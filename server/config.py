"""Reads settings from the project's .env file (simple KEY=value lines)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web"
DATA.mkdir(exist_ok=True)


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env()


def _list(name: str, default: str) -> list[str]:
    return [m.strip() for m in os.environ.get(name, default).split(",") if m.strip()]


def _ref(value: str) -> str:
    """Accept 'provider:model' or a bare OpenRouter model id (older .env files)."""
    from .providers import BY_ID
    return value if value.partition(":")[0] in BY_ID else f"openrouter:{value}"


# Company-wide defaults (each employee can override with their own model)
DEFAULT_MODEL = _ref(os.environ.get("DEFAULT_MODEL") or os.environ.get("MODEL_MANAGER", "nvidia/nemotron-3-ultra-550b-a55b:free"))
VISION_MODEL = _ref(os.environ.get("VISION_MODEL") or os.environ.get("MODEL_VISION", "google/gemma-4-31b-it:free"))
# OpenRouter-only: tried inside the same request when the chosen OpenRouter model is busy
MODEL_FALLBACKS = _list("MODEL_FALLBACKS", "google/gemma-4-31b-it:free,openrouter/free")

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))

WEATHER_CITY = os.environ.get("WEATHER_CITY", "Kuwait City")
WEATHER_LAT = float(os.environ.get("WEATHER_LAT", "29.3759"))
WEATHER_LON = float(os.environ.get("WEATHER_LON", "47.9774"))
