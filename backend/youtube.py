import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

import httpx
import yt_dlp
from fastapi import APIRouter, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)

router = APIRouter(prefix="/youtube")

# 720p/1080p on YouTube are video-only (DASH); a native <video> on WebOS 3.4 can't
# combine video+audio, and it also can't play a live/chunked stream — it needs a
# complete, byte-seekable file. So we mux to an MP4 with ffmpeg (/muxed) and serve
# it with range support. To stop this filling the disk: stale files are wiped on
# startup and the cache is hard-capped with oldest-first (LRU) eviction.
CACHE_DIR = Path(tempfile.gettempdir()) / "ytv_cache"
CACHE_DIR.mkdir(exist_ok=True)
MUX_HEIGHTS = [720, 1080]              # heights the /muxed (native) fallback serves
# YouTube only offers H.264 (avc1) up to 1080p. 1440p/2160p exist only as VP9
# (webm) or AV1 — AV1 can't decode on Chrome 38, so >1080p uses VP9. The client
# gates each option on MediaSource.isTypeSupported() so VP9 only appears where the
# TV can actually play it.
AVC_MAX = 1080                         # highest avc1/H.264 height YouTube provides
MAX_CACHE_BYTES = 2 * 1024 ** 3        # ~2 GB ceiling for muxed files (tune freely)
_mux_locks: dict = {}                  # cache-name -> asyncio.Lock (avoid double work)


def _ensure_ffmpeg():
    """Return the path to a stable, working ffmpeg binary.

    Prefers imageio-ffmpeg's bundled static build (the conda-forge build is broken
    on this box). Copies it once to a fixed location so the path is stable."""
    target = CACHE_DIR / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    target.parent.mkdir(exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return str(target)

    src = None
    try:
        import imageio_ffmpeg
        src = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        src = shutil.which("ffmpeg")

    if src and os.path.exists(src):
        try:
            shutil.copy2(src, target)
            return str(target)
        except OSError:
            return src
    return None


FFMPEG_EXE = _ensure_ffmpeg()
FFMPEG_DIR = os.path.dirname(FFMPEG_EXE) if FFMPEG_EXE else None

# Wipe muxed files left over from previous runs (the ffmpeg binary in bin/ stays).
for _stale in CACHE_DIR.glob("*.mp4"):
    try:
        _stale.unlink()
    except OSError:
        pass

YDL_OPTS = {
    "format": "22/18/best[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]",
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
}

FLAT_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "extract_flat": True,
}

# Max results we will ever fetch in a single page request (safety clamp)
MAX_PAGE = 48

STREAM_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.youtube.com/",
    "Origin":  "https://www.youtube.com",
}


def _parse_entries(result: dict) -> list:
    entries = (result or {}).get("entries") or []
    out = []
    for e in entries:
        if not e or not e.get("id"):
            continue
        vid_id = e["id"]
        out.append({
            "id":        vid_id,
            "url":       f"https://www.youtube.com/watch?v={vid_id}",
            "title":     e.get("title")    or "",
            "thumbnail": f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg",
            "duration":  e.get("duration") or 0,
            "channel":   e.get("channel")  or e.get("uploader") or "",
        })
    return out


def _video_by_height(formats: list, vcodec_prefix: str, ext: str) -> dict:
    """Best video-only format per height for a given codec/container (highest tbr)."""
    vids = {}
    for f in formats:
        if (f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")
                and f.get("ext") == ext and str(f.get("vcodec", "")).startswith(vcodec_prefix)
                and f.get("height") and f.get("url")):
            h = f["height"]
            if h not in vids or (f.get("tbr") or 0) > (vids[h].get("tbr") or 0):
                vids[h] = f
    return vids


def _best_audio(formats: list, ext: str):
    """Best audio-only format for a container (highest bitrate)."""
    audio = None
    for f in formats:
        if (f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")
                and f.get("ext") == ext and f.get("url")):
            if audio is None or (f.get("abr") or 0) > (audio.get("abr") or 0):
                audio = f
    return audio


def _quality_options(info: dict) -> list:
    """Build the full quality ladder, sorted ascending. Each entry carries the
    exact MediaSource codec strings so the client can gate it on isTypeSupported()
    (a TV without VP9 simply won't show 1440p/2160p):

      • progressive — muxed MP4 (audio+video, one file), instant via /stream.
        YouTube only offers this at 360p (itag 18) now.
      • mux (mp4)   — avc1/H.264 video-only ≤1080p + AAC audio, fed to MSE.
      • mux (webm)  — VP9 video-only 1440p/2160p + Opus audio, fed to MSE. The only
        way past 1080p on this TV (no H.264 4K exists; AV1 can't decode here).
    """
    formats = info.get("formats") or []

    # Best progressive (muxed) MP4 — instant, no ffmpeg needed.
    prog = None
    for f in formats:
        if not f.get("url") or f.get("ext") != "mp4":
            continue
        if f.get("acodec") in (None, "none") or f.get("vcodec") in (None, "none"):
            continue
        h = f.get("height") or 360
        if prog is None or h > prog["height"]:
            prog = {"height": h, "label": f"{h}p", "mode": "progressive",
                    "stream_url": f["url"]}

    avc  = _video_by_height(formats, "avc1", "mp4")    # H.264, ≤1080p
    vp9  = _video_by_height(formats, "vp9",  "webm")   # VP9, up to 2160p
    aac  = _best_audio(formats, "m4a")
    opus = _best_audio(formats, "webm")
    acodec = (aac.get("acodec") if aac else None) or "mp4a.40.2"

    out = []
    if prog:
        out.append(prog)

    prog_h = prog["height"] if prog else 0
    for h in sorted(set(list(avc.keys()) + list(vp9.keys()))):
        if h < 480 or h <= prog_h:                     # skip tiny + what progressive covers
            continue
        if h <= AVC_MAX and h in avc:                  # H.264 path (known-good)
            vcodec = avc[h].get("vcodec") or "avc1.4d401f"
            out.append({
                "height": h, "label": f"{h}p", "mode": "mux", "container": "mp4",
                "codecs":  f'video/mp4; codecs="{vcodec}"',
                "acodecs": f'audio/mp4; codecs="{acodec}"',
            })
        elif h in vp9 and opus:                        # VP9 path (1440p/2160p)
            out.append({
                "height": h, "label": f"{h}p", "mode": "mux", "container": "webm",
                "codecs":  'video/webm; codecs="vp9"',
                "acodecs": 'audio/webm; codecs="opus"',
            })

    out.sort(key=lambda x: x["height"])
    return out


def _extract(url: str) -> dict:
    with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
        return {
            "title":      info.get("title")     or "",
            "thumbnail":  info.get("thumbnail") or "",
            "stream_url": info.get("url")        or "",
            "duration":   info.get("duration")  or 0,
            "channel":    info.get("channel")   or "",
            "qualities":  _quality_options(info),
        }


# ── Search ────────────────────────────────────────────────────────────────────

def _clamp_page(limit: int, offset: int):
    """Sanitise pagination params and return (limit, offset, total_needed)."""
    offset = max(0, offset)
    limit = max(1, min(limit, MAX_PAGE))
    return limit, offset, offset + limit


def _flat_opts(total: int) -> dict:
    opts = dict(FLAT_OPTS)
    opts["playlist_items"] = f"1:{total}"
    return opts


@router.get("/search")
async def youtube_search(q: str, limit: int = 24, offset: int = 0):
    limit, offset, total = _clamp_page(limit, offset)

    def _search():
        with yt_dlp.YoutubeDL(_flat_opts(total)) as ydl:
            result = ydl.extract_info(f"ytsearch{total}:{q}", download=False)
        entries = _parse_entries(result)
        page = entries[offset:offset + limit]
        # has_more is best-effort: full window came back, so a next page may exist
        return page, len(entries) >= total

    try:
        videos, has_more = await asyncio.to_thread(_search)
        return JSONResponse({"videos": videos, "has_more": has_more, "offset": offset})
    except Exception as exc:
        return JSONResponse({"error": str(exc), "videos": []}, status_code=500)


@router.get("/trending")
async def youtube_trending(limit: int = 24, offset: int = 0):
    limit, offset, total = _clamp_page(limit, offset)

    def _trending():
        # Try the public trending playlist first (more reliable than /feed/trending)
        candidates = [
            "https://www.youtube.com/feed/trending",
            "PLbpi6ZahtOH6Ar_3GPy3workv-g63a-uc",  # YouTube Trending playlist
        ]
        for src in candidates:
            try:
                with yt_dlp.YoutubeDL(_flat_opts(total)) as ydl:
                    result = ydl.extract_info(src, download=False)
                entries = _parse_entries(result)
                if entries:
                    return entries[offset:offset + limit], len(entries) >= total
            except Exception:
                continue
        # Final fallback: popular search
        with yt_dlp.YoutubeDL(_flat_opts(total)) as ydl:
            result = ydl.extract_info(f"ytsearch{total}:trending music 2024", download=False)
        entries = _parse_entries(result)
        return entries[offset:offset + limit], len(entries) >= total

    try:
        videos, has_more = await asyncio.to_thread(_trending)
        return JSONResponse({"videos": videos, "has_more": has_more, "offset": offset})
    except Exception as exc:
        return JSONResponse({"error": str(exc), "videos": []}, status_code=500)


# ── Video info ────────────────────────────────────────────────────────────────

@router.get("/info")
async def youtube_info(url: str):
    try:
        info = await asyncio.to_thread(_extract, url)
        return JSONResponse(info)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


# ── Stream proxy ──────────────────────────────────────────────────────────────

@router.get("/stream")
async def youtube_stream(url: str, request: Request):
    req_headers = dict(STREAM_HEADERS)
    if "range" in request.headers:
        req_headers["Range"] = request.headers["range"]

    client = httpx.AsyncClient(timeout=None, follow_redirects=True)
    try:
        yt_resp = await client.send(
            client.build_request("GET", url, headers=req_headers),
            stream=True,
        )
    except httpx.RequestError as exc:
        await client.aclose()
        return JSONResponse({"error": str(exc)}, status_code=502)

    resp_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type":  yt_resp.headers.get("content-type", "video/mp4"),
    }
    for h in ("content-length", "content-range"):
        if h in yt_resp.headers:
            resp_headers[h.title()] = yt_resp.headers[h]

    async def stream_body():
        try:
            async for chunk in yt_resp.aiter_bytes(65536):
                yield chunk
        finally:
            await yt_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_body(),
        status_code=yt_resp.status_code,
        headers=resp_headers,
        media_type="video/mp4",
    )


# ── DASH segment range proxy (native &range= query, how YouTube's player fetches) ─

@router.get("/range")
async def youtube_range(url: str, start: int, end: int):
    """Fetch one byte range of a googlevideo DASH file using YouTube's native
    `&range=` query parameter (more 403-resistant than an HTTP Range header, and
    no CORS preflight). Used by the MSE/DASH player for each segment."""
    sep = "&" if "?" in url else "?"
    ranged = f"{url}{sep}range={start}-{end}"

    client = httpx.AsyncClient(timeout=None, follow_redirects=True)
    try:
        yt_resp = await client.send(
            client.build_request("GET", ranged, headers=STREAM_HEADERS),
            stream=True,
        )
    except httpx.RequestError as exc:
        await client.aclose()
        return JSONResponse({"error": str(exc)}, status_code=502)

    async def body():
        try:
            async for chunk in yt_resp.aiter_bytes(65536):
                yield chunk
        finally:
            await yt_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        body(),
        status_code=yt_resp.status_code,          # pass 403 through so the client can refresh
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


# ── Muxed quality (server-side merge of DASH video + audio, cached + capped) ────

def _safe_id(vid: str) -> str:
    return "".join(c for c in vid if c.isalnum() or c in "-_")


def _cleanup_partials(cache_path: Path) -> None:
    base = cache_path.with_suffix("").name
    for p in CACHE_DIR.glob(base + ".*"):
        try:
            p.unlink()
        except OSError:
            pass


def _evict_cache(keep: Path) -> None:
    """Keep total muxed-file size under MAX_CACHE_BYTES by deleting the oldest
    files first. Never deletes `keep` (the file we just produced / are serving)."""
    files = [p for p in CACHE_DIR.glob("*.mp4") if p != keep]
    files.sort(key=lambda p: p.stat().st_mtime)          # oldest first
    total = sum(p.stat().st_size for p in CACHE_DIR.glob("*.mp4"))
    for p in files:
        if total <= MAX_CACHE_BYTES:
            break
        try:
            total -= p.stat().st_size
            p.unlink()
        except OSError:
            pass


def _download_muxed(vid: str, height: int, cache_path: Path) -> None:
    """Download best avc1 video ≤height + AAC audio and merge to one MP4 (codecs
    copied, no re-encode). H.264 + AAC for WebOS 3.4 hardware-decode compatibility."""
    url = f"https://www.youtube.com/watch?v={vid}"
    outtmpl = str(cache_path.with_suffix("")) + ".%(ext)s"   # -> {id}_{h}.mp4 after merge
    opts = {
        "format": (
            f"bestvideo[height<={height}][vcodec^=avc1][ext=mp4]"
            f"+bestaudio[acodec^=mp4a][ext=m4a]"
            f"/best[height<={height}][ext=mp4]"
            f"/best[height<={height}]"
        ),
        "merge_output_format": "mp4",
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "overwrites": True,
    }
    if FFMPEG_DIR:
        opts["ffmpeg_location"] = FFMPEG_DIR
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])


@router.get("/muxed")
async def youtube_muxed(id: str, height: int = 1080):
    if height not in MUX_HEIGHTS:
        height = 1080
    vid = _safe_id(id)
    if not vid:
        return JSONResponse({"error": "bad id"}, status_code=400)
    if not FFMPEG_EXE:
        return JSONResponse({"error": "ffmpeg unavailable"}, status_code=500)

    cache_path = CACHE_DIR / f"{vid}_{height}.mp4"

    def _ready() -> bool:
        return cache_path.exists() and cache_path.stat().st_size > 0

    if not _ready():
        lock = _mux_locks.setdefault(cache_path.name, asyncio.Lock())
        async with lock:
            if not _ready():                       # re-check after acquiring lock
                try:
                    await asyncio.to_thread(_download_muxed, vid, height, cache_path)
                except Exception as exc:
                    _cleanup_partials(cache_path)
                    return JSONResponse({"error": str(exc)}, status_code=500)
        await asyncio.to_thread(_evict_cache, cache_path)   # enforce disk cap

    if not _ready():
        return JSONResponse({"error": "mux produced no file"}, status_code=500)

    os.utime(cache_path, None)                              # mark as recently used (LRU)
    # FileResponse honours Range requests automatically → scrubbing/seek works.
    return FileResponse(str(cache_path), media_type="video/mp4")


# ── MSE feasibility test: fragmented MP4 for client-side Media Source Extensions ─
# This is the format the official YouTube app feeds via MSE (no disk, adaptive).
# The real player (like the official app): /dash parses each DASH file's sidx
# index server-side and hands the client a clean segment map. The client feeds
# YouTube's own keyframe-aligned video + audio segments into two MSE SourceBuffers
# via range requests (proxied through /stream). No ffmpeg, no disk, no seams.

def _resolve_fmts(vid: str):
    """Return (avc_vids, vp9_vids, aac_audio, opus_audio, duration) — full format
    dicts so /dash can pick the right codec family/container for the requested
    height (avc1+AAC mp4 ≤1080p, VP9+Opus webm for 1440p/2160p)."""
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    formats = info.get("formats") or []
    avc  = _video_by_height(formats, "avc1", "mp4")
    vp9  = _video_by_height(formats, "vp9",  "webm")
    aac  = _best_audio(formats, "m4a")
    opus = _best_audio(formats, "webm")
    return avc, vp9, aac, opus, (info.get("duration") or 0)


def _iter_boxes(buf: bytes):
    i, n = 0, len(buf)
    while i + 8 <= n:
        size = int.from_bytes(buf[i:i + 4], "big")
        btype = buf[i + 4:i + 8].decode("latin1")
        if size == 1:
            size = int.from_bytes(buf[i + 8:i + 16], "big")
        if size < 8:
            break
        yield btype, i, size
        i += size


def _parse_dash_index(head: bytes) -> dict:
    """From the first chunk of a DASH mp4 (ftyp+moov+sidx+…), return the init byte
    range and the segment table (byte offset/size + presentation time)."""
    boxes = list(_iter_boxes(head))
    moov = next((b for b in boxes if b[0] == "moov"), None)
    sidx = next((b for b in boxes if b[0] == "sidx"), None)
    if not moov or not sidx:
        raise ValueError("missing moov/sidx (need a larger head fetch)")
    init_end = moov[1] + moov[2]                      # init segment = [0, init_end)

    o = sidx[1]
    ver = head[o + 8]
    timescale = int.from_bytes(head[o + 16:o + 20], "big")
    p = o + 20
    if ver == 0:
        first_off = int.from_bytes(head[p + 4:p + 8], "big"); p += 8
    else:
        first_off = int.from_bytes(head[p + 8:p + 16], "big"); p += 16
    p += 2                                            # reserved
    count = int.from_bytes(head[p:p + 2], "big"); p += 2

    seg_off = (sidx[1] + sidx[2]) + first_off
    segs, t = [], 0.0
    for _ in range(count):
        ref = int.from_bytes(head[p:p + 4], "big")
        dur = int.from_bytes(head[p + 4:p + 8], "big")
        size = ref & 0x7FFFFFFF
        segs.append([seg_off, size, round(t, 3)])     # [offset, size, startSec]
        seg_off += size
        t += dur / timescale
        p += 12
    return {"initEnd": init_end, "duration": round(t, 3), "segments": segs}


def _ebml_vint(buf: bytes, i: int, keep_marker: bool):
    """Read one EBML variable-length integer. keep_marker=True for element IDs
    (which include the length-descriptor bits), False for sizes."""
    first = buf[i]
    mask = 0x80
    length = 1
    while length <= 8 and not (first & mask):
        mask >>= 1
        length += 1
    if length > 8:
        raise ValueError("bad ebml vint")
    if keep_marker:
        val = int.from_bytes(buf[i:i + length], "big")
    else:
        val = first & (mask - 1)
        for j in range(1, length):
            val = (val << 8) | buf[i + j]
    return val, i + length


def _ebml_elem(buf: bytes, i: int):
    """Return (element_id, data_size, data_start_offset)."""
    eid, i = _ebml_vint(buf, i, True)
    size, i = _ebml_vint(buf, i, False)
    return eid, size, i


def _parse_webm_index(head: bytes, filesize: int = 0) -> dict:
    """WebM/Matroska analogue of _parse_dash_index for VP9/Opus DASH streams.
    Parses the Cues element (the segment index) into init range + segment table.
    Every computed offset lands on a Cluster (0x1F43B675) — verified."""
    n = len(head)

    # Locate the Segment element; all Cue positions are relative to its data start.
    i, seg_data, seg_size = 0, None, None
    while i + 2 <= n:
        eid, size, d = _ebml_elem(head, i)
        if eid == 0x18538067:                          # Segment
            seg_data, seg_size = d, size
            break
        i = d + size
    if seg_data is None:
        raise ValueError("no Segment element")

    timescale = 1000000                                # TimestampScale, default 1ms (ns)
    cues = []                                          # [(cue_time, cluster_pos), ...]
    j = seg_data
    while j + 2 <= n:
        try:
            eid, size, d = _ebml_elem(head, j)
        except Exception:
            break
        if eid == 0x1549A966:                          # Info
            k, kend = d, min(d + size, n)
            while k + 2 <= kend:
                cid, csize, cd = _ebml_elem(head, k)
                if cid == 0x2AD7B1:                    # TimestampScale
                    timescale = int.from_bytes(head[cd:cd + csize], "big")
                k = cd + csize
        elif eid == 0x1C53BB6B:                        # Cues (the index)
            k, kend = d, min(d + size, n)
            while k + 2 <= kend:
                cpid, cpsize, cpd = _ebml_elem(head, k)
                if cpid != 0xBB:                       # CuePoint
                    k = cpd + cpsize
                    continue
                ct = cpos = None
                m, mend = cpd, cpd + cpsize
                while m + 2 <= mend:
                    fid, fsize, fd = _ebml_elem(head, m)
                    if fid == 0xB3:                    # CueTime
                        ct = int.from_bytes(head[fd:fd + fsize], "big")
                    elif fid == 0xB7:                  # CueTrackPositions
                        p, pend = fd, fd + fsize
                        while p + 2 <= pend:
                            tid, tsize, td = _ebml_elem(head, p)
                            if tid == 0xF1:            # CueClusterPosition
                                cpos = int.from_bytes(head[td:td + tsize], "big")
                            p = td + tsize
                    m = fd + fsize
                if ct is not None and cpos is not None:
                    cues.append((ct, cpos))
                k = cpd + cpsize
            break
        elif eid == 0x1F43B675:                        # Cluster → reached media, stop
            break
        j = d + size

    if not cues:
        raise ValueError("no Cues (need a larger head fetch)")

    # Segment end: prefer the declared Segment size; fall back to file size.
    seg_end = (seg_data + seg_size) if (seg_size and seg_size < (1 << 56)) else filesize
    init_end = seg_data + cues[0][1]                   # init = [0, first Cluster)
    segs = []
    for idx in range(len(cues)):
        ct, cpos = cues[idx]
        off = seg_data + cpos
        nxt = (seg_data + cues[idx + 1][1]) if idx + 1 < len(cues) else seg_end
        segs.append([off, nxt - off, round(ct * timescale / 1e9, 3)])
    return {"initEnd": init_end, "duration": segs[-1][2] if segs else 0, "segments": segs}


async def _fetch_head(url: str, nbytes: int = 262144) -> bytes:
    headers = dict(STREAM_HEADERS)
    headers["Range"] = f"bytes=0-{nbytes - 1}"
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        r = await client.get(url, headers=headers)
        return r.content


@router.get("/dash")
async def youtube_dash(id: str, height: int = 1080):
    """Return the MSE segment map for the avc1 video ≤height + AAC audio: codec
    strings, init byte range, and per-segment [offset, size, startSec]. The client
    range-fetches segments via /youtube/stream and feeds two SourceBuffers."""
    vid = _safe_id(id)
    if not vid:
        return JSONResponse({"error": "bad id"}, status_code=400)

    try:
        avc, vp9, aac, opus, duration = await asyncio.to_thread(_resolve_fmts, vid)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)

    def _pick(vids: dict):                              # nearest height ≤ requested
        hs = sorted(vids.keys())
        chosen = hs[0]
        for h in hs:
            if h <= height:
                chosen = h
        return vids[chosen]

    # ≤1080p → avc1/AAC in mp4 (known-good). Above that → VP9/Opus in webm.
    if height <= AVC_MAX and avc and aac:
        vfmt, audio, container = _pick(avc), aac, "mp4"
        vcodec = 'video/mp4; codecs="%s"' % (vfmt.get("vcodec") or "avc1.4d401f")
        acodec = 'audio/mp4; codecs="%s"' % (aac.get("acodec") or "mp4a.40.2")
    elif vp9 and opus:
        vfmt, audio, container = _pick(vp9), opus, "webm"
        vcodec = 'video/webm; codecs="vp9"'
        acodec = 'audio/webm; codecs="opus"'
    elif avc and aac:                                  # webm unavailable → best avc1
        vfmt, audio, container = _pick(avc), aac, "mp4"
        vcodec = 'video/mp4; codecs="%s"' % (vfmt.get("vcodec") or "avc1.4d401f")
        acodec = 'audio/mp4; codecs="%s"' % (aac.get("acodec") or "mp4a.40.2")
    else:
        return JSONResponse({"error": "no DASH streams for this video"}, status_code=404)

    async def track(fmt):
        head = await _fetch_head(fmt["url"])
        if container == "webm":
            fsize = fmt.get("filesize") or fmt.get("filesize_approx") or 0
            idx = await asyncio.to_thread(_parse_webm_index, head, fsize)
        else:
            idx = await asyncio.to_thread(_parse_dash_index, head)
        idx["stream"] = "/youtube/range?url=" + quote(fmt["url"], safe="")
        return idx

    try:
        video_idx = await track(vfmt)
        audio_idx = await track(audio)
    except Exception as exc:
        return JSONResponse({"error": "index parse failed: %s" % exc}, status_code=500)

    return JSONResponse({
        "duration": duration or video_idx["duration"],
        "height":   vfmt.get("height") or height,
        "video": {
            "codecs":   vcodec,
            "initEnd":  video_idx["initEnd"],
            "stream":   video_idx["stream"],
            "segments": video_idx["segments"],
        },
        "audio": {
            "codecs":   acodec,
            "initEnd":  audio_idx["initEnd"],
            "stream":   audio_idx["stream"],
            "segments": audio_idx["segments"],
        },
    })


# ── Player page ───────────────────────────────────────────────────────────────

@router.get("/player")
async def youtube_player(url: str, request: Request):
    try:
        info = await asyncio.to_thread(_extract, url)
    except Exception as exc:
        return HTMLResponse(
            f"<body style='background:#000;color:#fff;font-family:sans-serif;padding:40px'>"
            f"<h2>Could not load video</h2><pre>{exc}</pre></body>",
            status_code=500,
        )

    if not info["stream_url"]:
        return HTMLResponse(
            "<body style='background:#000;color:#fff;font-family:sans-serif;padding:40px'>"
            "<h2>No playable stream found.</h2></body>",
            status_code=404,
        )

    proxy_base = str(request.base_url).rstrip("/")
    stream_src = f"{proxy_base}/youtube/stream?url={quote(info['stream_url'], safe='')}"
    title      = html_lib.escape(info["title"])
    channel    = html_lib.escape(info["channel"])
    thumbnail  = html_lib.escape(info["thumbnail"])

    return HTMLResponse(f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{title}</title>
  <style>
    *{{margin:0;padding:0;box-sizing:border-box;}}
    body{{background:#000;height:100vh;overflow:hidden;font-family:Arial,sans-serif;}}
    video{{width:100%;height:100%;object-fit:contain;display:block;}}
    #meta{{position:absolute;top:0;left:0;right:0;padding:14px 20px;
           background:linear-gradient(rgba(0,0,0,.85),transparent);color:#fff;pointer-events:none;}}
    #meta h1{{font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}}
    #meta span{{font-size:14px;color:#bbb;}}
  </style>
</head>
<body>
  <div id="meta"><h1>{title}</h1><span>{channel}</span></div>
  <video controls autoplay poster="{thumbnail}" preload="auto">
    <source src="{stream_src}" type="video/mp4">
  </video>
</body>
</html>""")
