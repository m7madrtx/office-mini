"""API keys you add on the Settings page, assignable to one employee or a whole room.

Which key a model call uses: the employee's own key → their room's key → the company key in .env.
A key only applies when it belongs to the provider of the model being called.
Secrets stay in data/company.db on this PC and are never sent back to the browser (only the last 4 characters).
"""
import datetime as dt
import time

from . import db
from .providers import BY_ID, LEVEL, classify_error, probe


class KeyError_(ValueError):
    pass


def _mask(secret: str) -> str:
    return f"••••{secret[-4:]}" if len(secret) >= 8 else "••••"


def public(row: dict) -> dict:
    p = BY_ID.get(row["provider"], {})
    used_by = db.rows("select id, name from employees where api_key_id=?", (row["id"],))
    rooms = db.rows("select id, name from rooms where api_key_id=?", (row["id"],))
    today = dt.date.today().isoformat()
    state = row["state"] or "unchecked"
    return {"id": row["id"], "provider": row["provider"], "provider_name": p.get("name", row["provider"]),
            "label": row["label"], "masked": _mask(row["secret"]), "state": state, "level": LEVEL.get(state, "grey"),
            "detail": row["detail"] or "", "checked": row["checked"], "uses": row["uses"] or 0,
            "uses_today": (row["uses_day"] or 0) if row["day"] == today else 0, "last_used": row["last_used"],
            "employees": used_by, "rooms": rooms}


def listing() -> list[dict]:
    return [public(r) for r in db.rows("select * from api_keys order by provider, id")]


def get(kid: int | None) -> dict | None:
    return db.one("select * from api_keys where id=?", (kid,)) if kid else None


async def add(provider: str, label: str, secret: str) -> dict:
    p = BY_ID.get(provider)
    if not p or not p["key_env"]:
        raise KeyError_("Pick a provider")
    secret = (secret or "").strip()
    if len(secret) < 12 or any(ch.isspace() for ch in secret):
        raise KeyError_("That doesn't look like an API key")
    if db.one("select id from api_keys where secret=?", (secret,)):
        raise KeyError_("This key is already added")
    state, detail = await probe(p, secret)
    if LEVEL.get(state) == "red" and state != "depleted":
        raise KeyError_(f"{p['name']} didn't accept this key: {detail}")
    label = (label or "").strip()[:40] or f"{p['name']} key {_mask(secret)}"
    kid = db.run("insert into api_keys(provider, label, secret, created, state, detail, checked) values(?,?,?,?,?,?,?)",
                 (provider, label, secret, time.time(), state, detail[:240], time.time()))
    return public(get(kid))


def rename(kid: int, label: str) -> dict:
    if not get(kid):
        raise KeyError_("No such key")
    db.run("update api_keys set label=? where id=?", ((label or "").strip()[:40] or "Key", kid))
    return public(get(kid))


def remove(kid: int) -> None:
    db.run("update employees set api_key_id=null where api_key_id=?", (kid,))
    db.run("update rooms set api_key_id=null where api_key_id=?", (kid,))
    db.run("delete from api_keys where id=?", (kid,))


async def check(kid: int) -> dict:
    row = get(kid)
    if not row:
        raise KeyError_("No such key")
    state, detail = await probe(BY_ID[row["provider"]], row["secret"])
    db.run("update api_keys set state=?, detail=?, checked=? where id=?", (state, detail[:240], time.time(), kid))
    return public(get(kid))


async def check_all(max_age: float = 300) -> list[dict]:
    for r in db.rows("select id, checked from api_keys"):
        if not r["checked"] or time.time() - r["checked"] > max_age:
            await check(r["id"])
    return listing()


# ---------------------------------------------------------------- used by the agent runtime
def resolve(emp: dict, ref: str) -> dict | None:
    """The key row an employee's call to `ref` should use, or None for the company key."""
    pid = (ref or "").partition(":")[0]
    for kid in (emp.get("api_key_id"), (db.one("select api_key_id from rooms where id=?", (emp.get("room_id"),)) or {}).get("api_key_id")):
        row = get(kid)
        if row and row["provider"] == pid:
            return row
    return None


def record_use(kid: int) -> None:
    today = dt.date.today().isoformat()
    db.run("update api_keys set uses=coalesce(uses,0)+1, last_used=?, "
           "uses_day=case when day=? then coalesce(uses_day,0)+1 else 1 end, day=? where id=?", (time.time(), today, today, kid))


def mark_error(kid: int, status, message: str) -> dict:
    state = classify_error(status, message)
    db.run("update api_keys set state=?, detail=?, checked=? where id=?", (state, (message or "")[:240], time.time(), kid))
    return public(get(kid))


def health_entries() -> list[dict]:
    """Keys with problems, shaped like provider health so they show up as colour-coded alert banners."""
    out = []
    for k in listing():
        if k["level"] in ("red", "amber"):
            out.append({"provider": f"key:{k['id']}", "name": f"{k['provider_name']} · {k['label']}", "state": k["state"],
                        "level": k["level"], "detail": k["detail"], "ts": k["checked"], "key_env": k["masked"],
                        "keys_url": BY_ID.get(k["provider"], {}).get("keys_url", ""), "is_key": True})
    return out
