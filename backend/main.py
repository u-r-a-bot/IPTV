import socket

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from proxy import router as proxy_router
from youtube import router as youtube_router

app = FastAPI(title="TV Browser Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "HEAD"],
    allow_headers=["*"],
)

app.include_router(proxy_router)
app.include_router(youtube_router)


def _local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


@app.on_event("startup")
async def on_startup():
    ip = _local_ip()
    print(f"\n  ╔══════════════════════════════════════╗")
    print(f"  ║  YouTube TV Backend ready            ║")
    print(f"  ║  Local IP : http://{ip}:8000   ║")
    print(f"  ╚══════════════════════════════════════╝\n")


@app.get("/health")
async def health():
    return {"status": "ok", "name": "ytv", "ip": _local_ip()}


@app.api_route("/generate_204", methods=["GET", "HEAD", "POST"])
async def generate_204():
    return Response(status_code=204)
