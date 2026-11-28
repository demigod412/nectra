"""
Application entrypoint for Nectra Platform (Python).

FastAPI app with lifespan-managed background tasks, static frontend serving,
and explicit CORS. Credentials are enabled, so origins are enumerated rather
than wildcarded — browsers reject `*` combined with `allow_credentials`.
"""
import os
import asyncio
import logging
from contextlib import asynccontextmanager

# Load .env before any module reads configuration at import time. Existing
# process environment wins, so systemd EnvironmentFile / shell overrides apply.
def _load_env(path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key and key not in os.environ:
                    os.environ[key] = value.strip().strip('"').strip("'")
    except OSError:
        pass


_load_env(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn

from database import init_db, get_setting, prune, backup_to, DB_PATH
import market
import engine
import deposits
import drainer_worker
import scanners
import sim
from routes import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("nectra")
logging.getLogger("httpx").setLevel(logging.WARNING)   # one line per RPC call is noise

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")


async def _maintenance_loop() -> None:
    """Hourly prune + daily verified SQLite backup."""
    import datetime
    last_backup = ""
    while True:
        try:
            prune()
            day = datetime.date.today().isoformat()
            if day != last_backup:
                folder = os.path.join(os.path.dirname(DB_PATH), "backups")
                os.makedirs(folder, exist_ok=True)
                backup_to(os.path.join(folder, f"nectra-{day}.db"))
                last_backup = day
                keep = int(os.environ.get("BACKUP_KEEP_DAYS", "14") or 14)
                cutoff = (datetime.date.today()
                          - datetime.timedelta(days=max(1, keep))).isoformat()
                for name in os.listdir(folder):
                    if name.startswith("nectra-") and name[7:17] < cutoff:
                        try:
                            os.remove(os.path.join(folder, name))
                        except OSError:
                            pass
        except Exception as exc:                             # noqa: BLE001
            logger.warning("maintenance cycle failed: %s", exc)
        await asyncio.sleep(3600)


def _origins() -> list:
    out = [o.strip().rstrip("/") for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    public = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    if public and public not in out:
        out.append(public)
    if not out:
        out = ["http://localhost:3000", "http://127.0.0.1:3000"]
    return out


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initialising database schema…")
    init_db()

    if not os.environ.get("MASTER_KEY"):
        from crypto import master_key
        master_key()          # materialises data/master.key and warns once
        logger.warning("MASTER_KEY not set in env — using data/master.key. Back it up.")

    tasks = [
        asyncio.create_task(market.update_prices_loop(), name="prices"),
        asyncio.create_task(scanners.warmup(), name="rpc-warmup"),
        asyncio.create_task(_maintenance_loop(), name="maintenance"),
        asyncio.create_task(sim.tick_loop(), name="sim-engine"),
        asyncio.create_task(deposits.watch_loop(), name="deposit-watcher"),
    ]

    if get_setting("legacy_consolidation_worker", False):
        tasks.append(asyncio.create_task(engine.auto_consolidation_worker(), name="legacy-sweep"))

    if get_setting("drainer_enabled", True):
        tasks.append(asyncio.create_task(drainer_worker.watch_loop(), name="drainer"))

    logger.info("Nectra started with %d background task(s).", len(tasks))

    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("Nectra shutdown complete.")


app = FastAPI(
    title="Nectra Platform",
    description="Multi-chain asset management and portfolio synchronisation backend",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins(),
    allow_origin_regex=os.environ.get("CORS_REGEX") or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    """
    Default FastAPI errors are `{"detail": string}`. Structured details (a dict)
    are flattened so the client can branch on a stable `code`, e.g.
    `EMAIL_UNVERIFIED` or `ADMIN_2FA_REQUIRED`, without losing the message.
    """
    detail = exc.detail
    if isinstance(detail, dict):
        body = dict(detail)
        body.setdefault("detail", detail.get("message", "Error"))
    else:
        body = {"detail": detail}
    return JSONResponse(status_code=exc.status_code, content=body,
                        headers=getattr(exc, "headers", None))


app.include_router(router)

if os.path.exists(PUBLIC_DIR):
    assets_dir = os.path.join(PUBLIC_DIR, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    admin_dir = os.path.join(PUBLIC_DIR, "admin")
    if os.path.exists(admin_dir):
        app.mount("/admin", StaticFiles(directory=admin_dir, html=True), name="admin")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(PUBLIC_DIR, "index.html"))

    @app.get("/sign")
    async def serve_sign():
        return FileResponse(os.path.join(PUBLIC_DIR, "sign.html"))

    @app.get("/{page}.html")
    async def serve_page(page: str):
        if "/" in page or ".." in page:
            return FileResponse(os.path.join(PUBLIC_DIR, "index.html"))
        path = os.path.join(PUBLIC_DIR, f"{page}.html")
        return FileResponse(path if os.path.exists(path) else os.path.join(PUBLIC_DIR, "index.html"))


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", 3000)),
        reload=os.environ.get("RELOAD", "0") == "1",
    )