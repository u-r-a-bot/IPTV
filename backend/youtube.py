import asyncio
import html as html_lib
from urllib.parse import quote

import httpx
import yt_dlp
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

router = APIRouter(prefix="/youtube")

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


def _extract(url: str) -> dict:
    with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
        return {
            "title":      info.get("title")     or "",
            "thumbnail":  info.get("thumbnail") or "",
            "stream_url": info.get("url")        or "",
            "duration":   info.get("duration")  or 0,
            "channel":    info.get("channel")   or "",
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
