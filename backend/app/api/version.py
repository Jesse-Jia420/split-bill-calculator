"""Backend version endpoint — exposes git commit at startup time."""
from fastapi import APIRouter

router = APIRouter(tags=["meta"])

# Read once at import time (not per-request)
import subprocess, os

_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

try:
    commit = (
        subprocess.check_output(
            ["git", "rev-parse", "--short=8", "HEAD"],
            stderr=subprocess.DEVNULL,
            cwd=_root,
        )
        .decode()
        .strip()
    )
    is_dirty = bool(
        subprocess.call(
            ["git", "diff", "--quiet"],
            stderr=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            cwd=_root,
        )
    )
except Exception:
    commit = "unknown"
    is_dirty = False

VERSION = commit + ("-dirty" if is_dirty else "")


@router.get("/version")
def get_version() -> dict:
    """Return backend git version tag."""
    return {"backend": VERSION}
