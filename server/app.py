"""Office Mini web server: REST API + live events (server-sent events) + the web app."""
import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
import time

from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agents, catalog, db, kb, keys, org, providers, workflows
from .config import HOST, PORT, WEB


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init()
    org.seed_if_empty()
    added = org.ensure_teams()   # every room: one team lead + at least one team member
    if added:
        print(f"  Added team members so every room has a lead and a member: {', '.join(added)}")
    tasks = [asyncio.create_task(agents.status_loop()), asyncio.create_task(workflows.scheduler_loop())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Office Mini", lifespan=lifespan)


@app.middleware("http")
async def no_stale_files(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"  # always revalidate so edits show up
    return response


def _org_payload() -> dict:
    snap = org.snapshot()
    for e in snap["employees"]:
        st = agents.status_of(e["id"])
        e.update({"status": st["status"], "task": st["task"], "status_ts": st["ts"]})
    snap["settings"]["default_model"] = agents.default_model()
    snap["settings"]["vision_model"] = agents.vision_model()
    return snap


async def _org_changed() -> None:
    await agents.broadcast({"type": "org", "org": _org_payload()})


def _bad(e: Exception):
    raise HTTPException(400, str(e))


# ---------------------------------------------------------------- catalog / org
@app.get("/api/catalog")
async def get_catalog():
    return {**catalog.public(), "themes": org.THEMES}


@app.get("/api/org")
async def get_org():
    return _org_payload()


class RoomIn(BaseModel):
    room: dict
    members: list[dict]
    lead_reports_to: str | None = None


@app.post("/api/rooms")
async def create_room(body: RoomIn):
    try:
        rid = org.save_room(body.model_dump())
    except org.OrgError as e:
        _bad(e)
    await _org_changed()
    return {"id": rid, "org": _org_payload()}


@app.put("/api/rooms/{rid}")
async def update_room(rid: str, body: RoomIn):
    try:
        org.save_room(body.model_dump(), rid)
    except org.OrgError as e:
        _bad(e)
    await _org_changed()
    return {"id": rid, "org": _org_payload()}


@app.delete("/api/rooms/{rid}")
async def delete_room(rid: str):
    try:
        org.delete_room(rid)
    except org.OrgError as e:
        _bad(e)
    await _org_changed()
    return {"org": _org_payload()}


@app.patch("/api/employees/{eid}")
async def patch_employee(eid: str, body: dict):
    try:
        org.update_employee(eid, body)
    except org.OrgError as e:
        _bad(e)
    if body.get("room_id"):
        await agents.log(eid, "info", f"Moved to {org.employee(eid)['room_name']}")
    await _org_changed()
    return {"org": _org_payload()}


@app.post("/api/employees/{eid}/rank")
async def change_rank(eid: str, body: dict):
    try:
        res = org.set_rank(eid, body.get("rank", ""), body.get("successor"))
    except org.OrgError as e:
        _bad(e)
    if res.get("previous"):
        new, old = org.employee(res["lead"]), org.employee(res["previous"])
        await agents.log(res["lead"], "info", f"Promoted to team lead of {new['room_name']} (was {old['name']})")
        await agents.log(res["previous"], "info", f"Now a team member, reporting to {new['name']}")
    await _org_changed()
    return {"org": _org_payload(), **res}


@app.delete("/api/employees/{eid}")
async def delete_employee(eid: str):
    try:
        org.fire_employee(eid)
    except org.OrgError as e:
        _bad(e)
    await _org_changed()
    return {"org": _org_payload()}


class SettingsIn(BaseModel):
    company: str | None = None
    review_reports: bool | None = None
    auto_hire: bool | None = None
    default_model: str | None = None
    vision_model: str | None = None


@app.patch("/api/settings")
async def patch_settings(body: SettingsIn):
    if body.company is not None and body.company.strip():
        db.set_setting("company", body.company.strip()[:40])
    for key in ("review_reports", "auto_hire"):
        if getattr(body, key) is not None:
            db.set_setting(key, getattr(body, key))
    for key in ("default_model", "vision_model"):
        val = getattr(body, key)
        if val is not None:
            if val and not org.MODEL_REF.match(val):
                raise HTTPException(400, "Model must look like provider:model")
            db.set_setting(key, val)
    await _org_changed()
    return {"ok": True}


# ---------------------------------------------------------------- company logo
LOGO_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"}


class LogoIn(BaseModel):
    data: str  # data URL


@app.get("/api/logo")
async def get_logo():
    import base64
    url = db.get_setting("logo", "")
    if not url:
        raise HTTPException(404)
    head, _, b64 = url.partition(",")
    mime = head[5:].split(";")[0]
    # SVGs are served with a strict policy so they can never run scripts, even if opened directly
    return Response(base64.b64decode(b64), media_type=mime,
                    headers={"Cache-Control": "public, max-age=31536000, immutable",
                             "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})


@app.put("/api/logo")
async def put_logo(body: LogoIn):
    import base64
    import binascii
    head, _, b64 = body.data.partition(",")
    mime = head[5:].split(";")[0] if head.startswith("data:") else ""
    if mime not in LOGO_TYPES or ";base64" not in head:
        raise HTTPException(400, "Use a PNG, JPG, WebP, GIF or SVG image")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "That image couldn't be read")
    if len(raw) > 300_000:
        raise HTTPException(413, "Logo is too large (max 300 KB)")
    db.set_setting("logo", body.data)
    db.set_setting("logo_v", int(time.time()))
    await _org_changed()
    return {"logo_v": db.get_setting("logo_v")}


@app.delete("/api/logo")
async def delete_logo():
    db.set_setting("logo", "")
    db.set_setting("logo_v", 0)
    await _org_changed()
    return {"ok": True}


# ---------------------------------------------------------------- models
@app.get("/api/providers")
async def get_providers():
    return {"providers": providers.public_list()}


@app.get("/api/providers/health")
async def get_health(refresh: bool = False):
    if refresh:
        await keys.check_all(0)
    return {"health": await providers.health(refresh) + keys.health_entries()}


# ---------------------------------------------------------------- API keys (per employee / per room)
def _local_only(request: Request) -> None:
    """Secrets travel unencrypted over plain http, so keys can only be added or deleted from this PC."""
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "For safety, add or delete API keys on the PC running Office Mini (http://127.0.0.1:%d). "
                                 "You can still assign keys to people from here." % PORT)


class KeyIn(BaseModel):
    provider: str
    label: str = ""
    secret: str


@app.get("/api/keys")
async def get_keys(request: Request):
    host = request.client.host if request.client else ""
    return {"keys": keys.listing(), "can_edit": host in ("127.0.0.1", "::1", "localhost")}


@app.post("/api/keys")
async def add_key(body: KeyIn, request: Request):
    _local_only(request)
    try:
        k = await keys.add(body.provider, body.label, body.secret)
    except keys.KeyError_ as e:
        _bad(e)
    await agents.broadcast({"type": "keys"})
    return k


@app.patch("/api/keys/{kid}")
async def rename_key(kid: int, body: dict):
    try:
        k = keys.rename(kid, body.get("label", ""))
    except keys.KeyError_ as e:
        _bad(e)
    await agents.broadcast({"type": "keys"})
    return k


@app.post("/api/keys/{kid}/check")
async def check_key(kid: int):
    try:
        k = await keys.check(kid)
    except keys.KeyError_ as e:
        _bad(e)
    await agents.broadcast({"type": "keys"})
    return k


@app.delete("/api/keys/{kid}")
async def delete_key(kid: int, request: Request):
    _local_only(request)
    keys.remove(kid)
    await agents.broadcast({"type": "keys"})
    await _org_changed()
    return {"ok": True}


@app.get("/api/models")
async def get_models(provider: str | None = None, refresh: bool = False):
    ids = [provider] if provider else [p["id"] for p in providers.PROVIDERS if providers.configured(p)]
    out = {}
    for pid in ids:
        out[pid] = await providers.list_models(pid, force=refresh)
    return {"models": out}


@app.get("/api/models/suggest")
async def suggest_models(specialty: str, n: int = 5):
    spec = catalog.SPECIALTIES.get(specialty)
    if not spec:
        raise HTTPException(404, "unknown specialty")
    models = {p["id"]: await providers.list_models(p["id"]) for p in providers.PROVIDERS if providers.configured(p)}
    q = await providers.quota()
    prefer_free = bool(q and q.get("free_tier"))
    return {"needs": spec["needs"], "suggestions": providers.suggest(models, spec["needs"], prefer_free, n)}


@app.get("/api/models/info")
async def get_model_info(ref: str):
    return await providers.model_info(ref)


# ---------------------------------------------------------------- knowledge
class KbIn(BaseModel):
    scope_type: str
    scope_id: str
    name: str
    mime: str = ""
    data: str  # base64 / data URL


@app.get("/api/kb")
async def get_kb(scope_type: str | None = None, scope_id: str | None = None):
    return {"files": kb.listing(scope_type, scope_id)}


@app.post("/api/kb")
async def post_kb(body: KbIn):
    try:
        res = kb.add(body.scope_type, body.scope_id, body.name, body.data, body.mime)
    except ValueError as e:
        _bad(e)
    if body.scope_type == "employee":
        await agents.log(body.scope_id, "info", f"Knowledge added: {res['name']}")
    await agents.broadcast({"type": "kb"})
    return res


@app.delete("/api/kb/{kid}")
async def delete_kb(kid: int):
    kb.remove(kid)
    await agents.broadcast({"type": "kb"})
    return {"ok": True}


# ---------------------------------------------------------------- activity, approvals, notifications
@app.get("/api/activity")
async def get_activity(employee: str | None = None, limit: int = 120):
    if employee:
        rows = db.rows("select * from activity where employee=? order by id desc limit ?", (employee, limit))
    else:
        rows = db.rows("select * from activity order by id desc limit ?", (limit,))
    for r in rows:
        r["meta"] = json.loads(r["meta"] or "{}")
    return {"activity": list(reversed(rows))}


@app.get("/api/approvals")
async def get_approvals(status: str | None = None):
    sql = "select * from approvals" + (" where status=?" if status else "") + " order by status='pending' desc, id desc limit 300"
    rows = db.rows(sql, (status,) if status else ())
    for r in rows:
        r["payload"] = json.loads(r["payload"] or "{}")
    return {"approvals": rows}


class DecideIn(BaseModel):
    approve: bool
    note: str = ""


@app.post("/api/approvals/{aid}")
async def decide_approval(aid: int, body: DecideIn):
    try:
        res = await agents.decide(aid, body.approve, body.note)
    except (ValueError, org.OrgError) as e:
        _bad(e)
    await _org_changed()
    return res


@app.get("/api/notifications")
async def get_notifications():
    return {"notifications": db.rows("select * from notifications order by id desc limit 200"),
            "pending": db.one("select count(*) n from approvals where status='pending'")["n"],
            "unread": db.one("select count(*) n from notifications where read=0 and kind<>'approval'")["n"]}


@app.post("/api/notifications/read")
async def read_notifications():
    db.run("update notifications set read=1")
    await agents.broadcast({"type": "approvals"})
    return {"ok": True}


# ---------------------------------------------------------------- chat + work
class ChatIn(BaseModel):
    thread: str = "gm"
    text: str = ""
    image: str | None = None
    mentions: list[dict] = []


@app.get("/api/messages")
async def get_messages(thread: str = "gm"):
    return {"messages": db.thread_messages(thread)}


@app.delete("/api/messages")
async def clear_messages(thread: str):
    db.run("delete from messages where thread=?", (thread,))
    return {"ok": True}


@app.post("/api/chat")
async def post_chat(body: ChatIn):
    if not body.text.strip() and not body.image:
        raise HTTPException(400, "empty message")
    if body.image and len(body.image) > 6_000_000:
        raise HTTPException(413, "image too large")
    try:
        return await agents.chat(body.thread, body.text.strip(), body.image, body.mentions)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.get("/api/tasks")
async def get_tasks():
    return {"tasks": db.rows("select * from tasks order by id desc limit 200")}


@app.get("/api/documents")
async def get_documents():
    return {"documents": db.rows("select id, ts, author, title, substr(content,1,220) preview, length(content) size "
                                 "from documents order by id desc limit 200")}


@app.get("/api/documents/{did}")
async def get_document(did: int):
    d = db.one("select * from documents where id=?", (did,))
    if not d:
        raise HTTPException(404)
    return d


@app.delete("/api/documents/{did}")
async def delete_document(did: int):
    db.run("delete from documents where id=?", (did,))
    await agents.broadcast({"type": "records", "kind": "documents"})
    return {"ok": True}


@app.get("/api/emails")
async def get_emails():
    return {"emails": db.rows("select id, ts, sender, subject, body, unread, draft from emails where archived=0 order by ts desc")}


# ---------------------------------------------------------------- workflows
def _wf_err(e: Exception):
    raise HTTPException(400, str(e))


@app.get("/api/workflows")
async def get_workflows():
    return {"workflows": workflows.listing(), "templates": workflows.TEMPLATES, "icons": workflows.ICONS,
            "max_steps": workflows.MAX_STEPS, "max_budget": workflows.MAX_BUDGET}


@app.post("/api/workflows")
async def create_workflow(body: dict):
    try:
        wid = workflows.save(body)
    except (workflows.WorkflowError, ValueError) as e:
        _wf_err(e)
    await agents.broadcast({"type": "workflows"})
    return {"id": wid, "workflow": workflows.get(wid)}


@app.put("/api/workflows/{wid}")
async def update_workflow(wid: int, body: dict):
    try:
        workflows.save(body, wid)
    except (workflows.WorkflowError, ValueError) as e:
        _wf_err(e)
    await agents.broadcast({"type": "workflows"})
    return {"id": wid, "workflow": workflows.get(wid)}


@app.patch("/api/workflows/{wid}")
async def toggle_workflow(wid: int, body: dict):
    try:
        workflows.set_enabled(wid, bool(body.get("enabled")))
    except workflows.WorkflowError as e:
        _wf_err(e)
    await agents.broadcast({"type": "workflows"})
    return {"workflow": workflows.get(wid)}


@app.delete("/api/workflows/{wid}")
async def delete_workflow(wid: int):
    workflows.delete(wid)
    await agents.broadcast({"type": "workflows"})
    return {"ok": True}


class RunIn(BaseModel):
    input: str | None = None


@app.post("/api/workflows/{wid}/run")
async def run_workflow(wid: int, body: RunIn):
    try:
        rid = await workflows.start(wid, "manual", body.input)
    except workflows.WorkflowError as e:
        _wf_err(e)
    return {"run_id": rid}


@app.get("/api/runs")
async def get_runs(workflow: int | None = None, limit: int = 40):
    return {"runs": workflows.runs(workflow, min(limit, 200))}


@app.get("/api/runs/{rid}")
async def get_run(rid: int):
    r = workflows.run(rid)
    if not r:
        raise HTTPException(404)
    return {"run": r, "messages": db.thread_messages(f"wf:{rid}", 200)}


@app.post("/api/runs/{rid}/cancel")
async def cancel_run(rid: int):
    if not workflows.cancel(rid):
        raise HTTPException(400, "This run isn't active")
    await agents.broadcast({"type": "workflows"})
    return {"ok": True}


@app.get("/api/quota")
async def get_quota():
    return (await providers.quota()) or {}


@app.get("/api/events")
async def events(request: Request):
    q = agents.subscribe()

    async def stream():
        try:
            yield "retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=20)
                    if ev.get("type") == "org_changed":
                        ev = {"type": "org", "org": _org_payload()}
                    yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            agents.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


if __name__ == "__main__":
    import socket

    import uvicorn

    print(f"\n  Office Mini on this PC:  http://127.0.0.1:{PORT}")
    if HOST == "0.0.0.0":
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.168.0.1", 9))  # no packet is sent; this just picks the Wi-Fi interface
                print(f"  On your phone (same Wi-Fi):  http://{s.getsockname()[0]}:{PORT}\n")
        except OSError:
            print("  On your phone: http://<this PC's IP>:%d  (find the IP with ipconfig)\n" % PORT)
    uvicorn.run("server.app:app", host=HOST, port=PORT, timeout_graceful_shutdown=1)
