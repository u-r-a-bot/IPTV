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
MUX_HEIGHTS = [720, 1080]              # heights we offer via server-side muxing
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


def _quality_options(info: dict) -> list:
    """Build the quality list the TV can actually play, sorted ascending so the
    first entry is the instant-start default:

      • progressive  — muxed MP4 (audio+video in one file), plays instantly via
        the /stream proxy. YouTube only offers this at 360p (itag 18) now.
      • mux          — video-only DASH (720p/1080p) streamed via MSE on the
        client (windowed /fmp4 segments — no disk). 'codecs' is the exact
        MediaSource type string the client needs for addSourceBuffer().
    """
    formats = info.get("formats") or []

    # Best progressive (muxed) MP4 — instant, no ffmpeg needed.
    prog = None
    for f in formats:
        if not f.get("url"):
            continue
        if f.get("ext") != "mp4":
            continue
        if f.get("acodec") in (None, "none") or f.get("vcodec") in (None, "none"):
            continue
        h = f.get("height") or 360
        if prog is None or h > prog["height"]:
            prog = {"height": h, "label": f"{h}p", "mode": "progressive",
                    "stream_url": f["url"]}

    # Best avc1 (H.264) video-only per height + best AAC audio — for MSE mux.
    vids = {}
    for f in formats:
        if (f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")
                and f.get("ext") == "mp4" and str(f.get("vcodec", "")).startswith("avc1")
                and f.get("height")):
            h = f["height"]
            if h not in vids or (f.get("tbr") or 0) > (vids[h].get("tbr") or 0):
                vids[h] = f
    audio = None
    for f in formats:
        if (f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")
                and f.get("ext") == "m4a"):
            if audio is None or (f.get("abr") or 0) > (audio.get("abr") or 0):
                audio = f
    acodec = (audio.get("acodec") if audio else None) or "mp4a.40.2"

    out = []
    if prog:
        out.append(prog)
    for h in MUX_HEIGHTS:
        if h in vids and (not prog or h > prog["height"]):
            vcodec = vids[h].get("vcodec") or "avc1.4d401f"
            out.append({
                "height": h,
                "label":  f"{h}p",
                "mode":   "mux",
                "codecs": f'video/mp4; codecs="{vcodec}, {acodec}"',
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
    """Return ({height: video_format_dict}, audio_format_dict, duration) — avc1
    video-only per height + best AAC audio-only (full dicts for codec strings)."""
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    formats = info.get("formats") or []

    audio = None
    for f in formats:
        if (f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")
                and f.get("ext") == "m4a" and f.get("url")):
            if audio is None or (f.get("abr") or 0) > (audio.get("abr") or 0):
                audio = f

    vids = {}
    for f in formats:
        if (f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")
                and f.get("ext") == "mp4" and str(f.get("vcodec", "")).startswith("avc1")
                and f.get("height") and f.get("url")):
            h = f["height"]
            if h not in vids or (f.get("tbr") or 0) > (vids[h].get("tbr") or 0):
                vids[h] = f
    return vids, audio, (info.get("duration") or 0)


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
        vids, audio, duration = await asyncio.to_thread(_resolve_fmts, vid)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    if not vids or not audio:
        return JSONResponse({"error": "no DASH streams for this video"}, status_code=404)

    heights = sorted(vids.keys())
    chosen = heights[0]
    for h in heights:
        if h <= height:
            chosen = h
    vfmt = vids[chosen]

    async def track(fmt):
        head = await _fetch_head(fmt["url"])
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
        "height":   chosen,
        "video": {
            "codecs":   'video/mp4; codecs="%s"' % (vfmt.get("vcodec") or "avc1.4d401f"),
            "initEnd":  video_idx["initEnd"],
            "stream":   video_idx["stream"],
            "segments": video_idx["segments"],
        },
        "audio": {
            "codecs":   'audio/mp4; codecs="%s"' % (audio.get("acodec") or "mp4a.40.2"),
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
