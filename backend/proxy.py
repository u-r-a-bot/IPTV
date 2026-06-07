from urllib.parse import urljoin, quote, urlparse

import httpx
from bs4 import BeautifulSoup
from bs4.element import PreformattedString
from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse

router = APIRouter()

STRIP_RESPONSE_HEADERS = {
    "x-frame-options",
    "content-security-policy",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    "transfer-encoding",
    "content-length",   # body size changes after HTML rewriting
    "content-encoding", # decoded by httpx already
}

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

YOUTUBE_HOSTS = {"www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"}

# __PROXY__ = proxy server base URL  (e.g. http://localhost:8000)
# __BASE__  = the proxied page's origin (e.g. https://www.youtube.com)
#
# IMPORTANT: inserted via PreformattedString so BS4 does NOT HTML-escape the
# content.  A plain NavigableString would turn && into &amp;&amp;, which is a
# JS syntax error that silently breaks the fetch/XHR override.
#
# BASE is hardcoded rather than using document.baseURI because YouTube's JS
# removes/replaces the <base> tag during initialisation.  Without BASE, relative
# URLs like /api/stats/atr resolve to localhost (same-origin) and bypass the
# proxy rewrite, causing 404s.
_INTERCEPTOR_JS = """\
(function(P,BASE){
  // Domains that must reach the server directly (IP-signed or real-browser-only).
  var BP=['googlevideo.com','jnn-pa.googleapis.com','i.ytimg.com','yt3.ggpht.com','lh3.googleusercontent.com'];
  function skip(h){for(var i=0;i<BP.length;i++){if(h===BP[i]||h.endsWith('.'+BP[i]))return true;}return false;}
  function rw(u){
    if(!u)return u;
    try{
      var x=new URL(u,BASE);
      if(x.origin===location.origin||x.href.indexOf(P)===0||skip(x.hostname))return u;
      return P+'/proxy?url='+encodeURIComponent(x.href);
    }catch(e){return u;}
  }
  var _f=window.fetch;
  window.fetch=function(r,i){
    if(typeof r==='string')r=rw(r);
    else if(r&&r.url){var n=rw(r.url);if(n!==r.url)r=new Request(n,r);}
    return _f.call(window,r,i);
  };
  var _x=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    var a=Array.from(arguments);a[1]=rw(a[1]);return _x.apply(this,a);
  };
  if(navigator.sendBeacon){
    var _sb=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(u,d){return _sb(rw(u),d);};
  }
})('__PROXY__','__BASE__');"""


def _is_youtube_video(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc not in YOUTUBE_HOSTS:
        return False
    if parsed.netloc == "youtu.be" and parsed.path.strip("/"):
        return True
    if parsed.path == "/watch" and "v=" in (parsed.query or ""):
        return True
    if parsed.path.startswith("/shorts/") and len(parsed.path) > len("/shorts/"):
        return True
    return False


def _nav_url(url: str, page_url: str, proxy_base: str) -> str:
    """Rewrite a navigation href/action through the proxy."""
    if not url or url.startswith(("data:", "javascript:", "#", "mailto:", "tel:")):
        return url
    absolute = urljoin(page_url, url)
    return f"{proxy_base}/proxy?url={quote(absolute, safe='')}"


def _rewrite_html(html: str, page_url: str, proxy_base: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    parsed = urlparse(page_url)
    base_origin = f"{parsed.scheme}://{parsed.netloc}"

    js = _INTERCEPTOR_JS.replace("__PROXY__", proxy_base).replace("__BASE__", base_origin)
    script = soup.new_tag("script")
    # PreformattedString tells BS4 to emit the JS verbatim — no HTML escaping.
    script.append(PreformattedString(js))

    head = soup.find("head") or soup.find("html") or soup
    existing_base = soup.find("base")
    if existing_base:
        existing_base["href"] = base_origin
        existing_base.insert_after(script)
    else:
        base_tag = soup.new_tag("base", href=base_origin)
        head.insert(0, script)
        head.insert(0, base_tag)  # base first, interceptor second

    for tag in soup.find_all("a", href=True):
        tag["href"] = _nav_url(tag["href"], page_url, proxy_base)

    for tag in soup.find_all("form", action=True):
        tag["action"] = _nav_url(tag["action"], page_url, proxy_base)

    for tag in soup.find_all(True):
        tag.attrs.pop("integrity", None)
        tag.attrs.pop("crossorigin", None)

    return str(soup)


def _rewrite_set_cookie(value: str) -> str:
    """Strip domain binding and Secure flag so cookies persist on the proxy host."""
    parts = [p.strip() for p in value.split(";")]
    kept = [parts[0]]
    for part in parts[1:]:
        low = part.lower()
        if low.startswith("domain"):
            continue
        if low == "secure":
            continue
        if low.startswith("samesite"):
            kept.append("SameSite=Lax")
            continue
        kept.append(part)
    return "; ".join(kept)


def _forward_request_headers(request: Request) -> dict:
    """Merge default headers with safe pass-through headers from the browser."""
    headers = dict(REQUEST_HEADERS)
    for h in (
        "accept", "content-type", "cookie",
        "x-goog-visitor-id", "x-goog-authuser",
        "x-youtube-client-name", "x-youtube-client-version",
        "authorization",
    ):
        val = request.headers.get(h)
        if val:
            headers[h] = val
    return headers


def _build_response(upstream: httpx.Response, body: bytes, media_type: str) -> Response:
    """Build the final response, rewriting Set-Cookie and copying all safe headers."""
    resp = Response(content=body, media_type=media_type, status_code=upstream.status_code)
    for k, v in upstream.headers.multi_items():
        kl = k.lower()
        if kl in STRIP_RESPONSE_HEADERS or kl == "content-type":
            continue
        if kl == "set-cookie":
            resp.headers.append(k, _rewrite_set_cookie(v))
        else:
            resp.headers.append(k, v)
    return resp


async def _do_proxy(url: str, request: Request, method: str = "GET") -> Response:
    proxy_base = str(request.base_url).rstrip("/")
    fwd = _forward_request_headers(request)

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            if method == "POST":
                body = await request.body()
                upstream = await client.post(url, content=body, headers=fwd)
            else:
                upstream = await client.get(url, headers=fwd)
    except httpx.RequestError as exc:
        return HTMLResponse(
            f"<body style='font-family:sans-serif;padding:40px'>"
            f"<h2>Could not reach {url}</h2><pre>{exc}</pre></body>",
            status_code=502,
        )

    content_type = upstream.headers.get("content-type", "")
    media_type = content_type.split(";")[0].strip() or "application/octet-stream"

    if "text/html" in content_type:
        body_bytes = _rewrite_html(
            upstream.text, str(upstream.url), proxy_base
        ).encode("utf-8")
        media_type = "text/html; charset=utf-8"
    else:
        body_bytes = upstream.content

    return _build_response(upstream, body_bytes, media_type)


@router.get("/proxy")
async def proxy_get(url: str, request: Request):
    proxy_base = str(request.base_url).rstrip("/")
    if _is_youtube_video(url):
        return RedirectResponse(f"{proxy_base}/youtube/player?url={quote(url, safe='')}")
    return await _do_proxy(url, request, "GET")


@router.post("/proxy")
async def proxy_post(url: str, request: Request):
    return await _do_proxy(url, request, "POST")


@router.head("/proxy")
async def proxy_head(url: str, request: Request):
    """HEAD — return upstream headers with no body (used by YouTube connectivity checks)."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
            upstream = await client.head(url, headers=_forward_request_headers(request))
    except httpx.RequestError:
        return Response(status_code=502)

    resp = Response(status_code=upstream.status_code)
    for k, v in upstream.headers.multi_items():
        kl = k.lower()
        if kl not in STRIP_RESPONSE_HEADERS and kl != "content-type":
            resp.headers.append(k, v)
    return resp
