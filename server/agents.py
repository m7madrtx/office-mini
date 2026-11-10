"""Employees as AI agents, with a real chain of command.

- Every employee has a persona (specialty, seniority, manager, team), their own model, and knowledge bases.
- You can talk to anyone directly, or ask the General Manager, who routes work to the right people.
- Managers delegate() down their part of the org; anyone can ask_colleague() across teams.
- The GM can hire new people or whole rooms (with your approval unless auto-hire is on).
- Sensitive actions become approval requests in the notifications panel.
- Everything an employee does is written to a live activity log.

Budget: each owner message is capped at MAX_REQUESTS model calls in total, however deep the chain goes
(workflow runs carry their own cap).
"""
import asyncio
import datetime as dt
import json
import time

from . import db, kb, keys, org
from .catalog import DIVISIONS, SPECIALTIES
from .config import DEFAULT_MODEL, MODEL_FALLBACKS, VISION_MODEL
from .providers import LLMError, check_health, complete, mark_error, model_info, quota

MAX_REQUESTS = 10
MAX_DEPTH = 3
MAX_ROUNDS = 4

# ---------------------------------------------------------------- live status + event bus
STATUS: dict[str, dict] = {}
_subscribers: set[asyncio.Queue] = set()


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=800)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


async def broadcast(event: dict) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


def status_of(eid: str) -> dict:
    return STATUS.get(eid, {"status": "idle", "task": "", "ts": 0})


async def set_status(eid: str, status: str, task: str = "") -> None:
    STATUS[eid] = {"status": status, "task": task[:80], "ts": time.time()}
    await broadcast({"type": "status", "id": eid, **STATUS[eid]})


async def log(eid: str, kind: str, text: str, meta: dict | None = None) -> None:
    """Activity log entry: kinds are model, tool, result, handoff, report, consult, approval, hire, error, info."""
    ts = time.time()
    aid = db.run("insert into activity(ts, employee, kind, text, meta) values(?,?,?,?,?)",
                 (ts, eid, kind, text[:600], json.dumps(meta or {}, ensure_ascii=False, default=str)))
    await broadcast({"type": "activity", "entry": {"id": aid, "ts": ts, "employee": eid, "kind": kind, "text": text[:600],
                                                   "meta": meta or {}}})
    if aid % 200 == 0:
        db.run("delete from activity where id < ?", (aid - 5000,))


async def notify(kind: str, eid: str | None, title: str, body: str = "", ref: str = "") -> None:
    nid = db.run("insert into notifications(ts, kind, employee, title, body, ref) values(?,?,?,?,?,?)",
                 (time.time(), kind, eid, title[:200], body[:1000], ref))
    await broadcast({"type": "notification", "id": nid, "kind": kind})


async def status_loop() -> None:
    while True:
        now = time.time()
        for eid, s in list(STATUS.items()):
            if s["status"] in ("done", "error") and now - s["ts"] > 60:
                await set_status(eid, "idle")
        await asyncio.sleep(5)


def default_model() -> str:
    return db.get_setting("default_model") or DEFAULT_MODEL


def vision_model() -> str:
    return db.get_setting("vision_model") or VISION_MODEL


# ---------------------------------------------------------------- tools
def _today() -> str:
    return dt.date.today().isoformat()


def _fn(name, desc, props=None, required=None):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props or {}, "required": required or []}}}


S, I = {"type": "string"}, {"type": "integer"}


def t_save_document(turn, me, title: str, content: str) -> dict:
    did = db.run("insert into documents(ts, author, title, content, task_id) values(?,?,?,?,?)",
                 (time.time(), me["id"], title[:120], content, None))
    return {"ok": True, "document_id": did, "title": title}


def t_find_documents(turn, me, query: str = "") -> dict:
    q = f"%{query}%"
    docs = db.rows("select d.id, d.title, d.ts, e.name author from documents d left join employees e on e.id=d.author "
                   "where d.title like ? or d.content like ? order by d.id desc limit 12", (q, q))
    return {"documents": [{**d, "date": dt.datetime.fromtimestamp(d.pop("ts")).strftime("%d %b")} for d in docs]}


def t_read_document(turn, me, id: int) -> dict:
    return db.one("select id, title, content from documents where id=?", (id,)) or {"error": "no such document"}


def t_my_tasks(turn, me) -> dict:
    return {"tasks": db.rows("select id, title, status, assigner from tasks where assignee=? order by id desc limit 10", (me["id"],))}


def t_search_knowledge(turn, me, query: str) -> dict:
    hits = kb.search(me, query)
    return {"results": hits} if hits else {"results": [], "note": "Nothing relevant in your knowledge bases.",
                                           "available_files": [d["name"] for d in kb.docs_for(me)][:20]}


def t_org_overview(turn, me) -> dict:
    people = turn.people.values()
    return {"company": db.get_setting("company", "Office Mini"),
            "rooms": [{"id": r["id"], "name": r["name"], "division": r["division"], "vacancies": r.get("vacancies", 0)}
                      for r in org.snapshot()["rooms"]],
            "people": [{"id": p["id"], "name": p["name"], "title": p["title"]["en"], "room": p["room_name"],
                        "reports_to": p["reports_to"], "status": status_of(p["id"])["status"]} for p in people],
            "specialties_you_can_hire": sorted(s for s in SPECIALTIES if s != "general_manager")}


def t_list_emails(turn, me, filter: str = "unread", search: str = "") -> dict:
    sql, args = "select id, ts, sender, subject, body, unread, draft from emails where archived=0", []
    if filter == "unread":
        sql += " and unread=1"
    elif filter == "drafts":
        sql += " and draft is not null"
    if search:
        sql += " and (subject like ? or sender like ? or body like ?)"
        args += [f"%{search}%"] * 3
    return {"emails": [{"id": e["id"], "from": e["sender"], "subject": e["subject"], "preview": e["body"][:180],
                        "unread": bool(e["unread"]), "has_draft": bool(e["draft"]),
                        "received": dt.datetime.fromtimestamp(e["ts"]).strftime("%a %d %b %H:%M")}
                       for e in db.rows(sql + " order by ts desc limit 10", tuple(args))]}


def t_read_email(turn, me, id: int) -> dict:
    e = db.one("select * from emails where id=?", (id,))
    if not e:
        return {"error": "no such email"}
    db.run("update emails set unread=0 where id=?", (id,))
    return {"id": e["id"], "from": e["sender"], "subject": e["subject"], "body": e["body"], "draft": e["draft"]}


def t_draft_reply(turn, me, email_id: int, body: str) -> dict:
    if not db.one("select id from emails where id=?", (email_id,)):
        return {"error": "no such email"}
    db.run("update emails set draft=?, unread=0 where id=?", (body, email_id))
    return {"ok": True, "note": "Draft saved. To send it, call send_email (the owner must approve)."}


def t_archive_email(turn, me, id: int) -> dict:
    db.run("update emails set archived=1, unread=0 where id=?", (id,))
    return {"ok": True}


TOOLS = {
    "save_document": (t_save_document, _fn("save_document",
        "Save a deliverable (plan, spec, research, code, copy) to the company's shared documents.",
        {"title": S, "content": {"type": "string", "description": "Full content in Markdown"}}, ["title", "content"]), "Writing a document"),
    "find_documents": (t_find_documents, _fn("find_documents", "Search the company's shared documents.", {"query": S}), "Searching documents"),
    "read_document": (t_read_document, _fn("read_document", "Read a shared document in full.", {"id": I}, ["id"]), "Reading a document"),
    "my_tasks": (t_my_tasks, _fn("my_tasks", "Tasks assigned to me."), "Checking my tasks"),
    "search_knowledge": (t_search_knowledge, _fn("search_knowledge",
        "Search the knowledge-base files attached to you, your room, your division and the company.", {"query": S}, ["query"]),
        "Searching knowledge"),
    "org_overview": (t_org_overview, _fn("org_overview", "Every room and person, who they report to, and what they're doing."),
        "Reviewing the org"),
    "list_emails": (t_list_emails, _fn("list_emails", "List the owner's inbox, newest first.",
        {"filter": {"type": "string", "enum": ["unread", "all", "drafts"]}, "search": S}), "Checking the inbox"),
    "read_email": (t_read_email, _fn("read_email", "Read one email in full.", {"id": I}, ["id"]), "Reading an email"),
    "draft_reply": (t_draft_reply, _fn("draft_reply", "Save a reply draft for an email.", {"email_id": I, "body": S},
        ["email_id", "body"]), "Drafting a reply"),
    "archive_email": (t_archive_email, _fn("archive_email", "Archive an email.", {"id": I}, ["id"]), "Archiving mail"),
}
ASYNC_TOOLS = {
    "delegate": "Delegating", "ask_colleague": "Consulting a colleague", "request_approval": "Asking for approval",
    "hire": "Proposing a hire", "send_email": "Requesting to send", "create_workflow": "Setting up a routine",
}
GROUP_TOOLS = {"org": ["org_overview"], "email": ["list_emails", "read_email", "draft_reply", "archive_email"]}
BASE_TOOLS = ["save_document", "find_documents", "read_document", "my_tasks", "search_knowledge"]
RECORD_EVENT = {"save_document": "documents", "draft_reply": "emails", "archive_email": "emails", "read_email": "emails"}


def tools_for(me: dict, turn) -> list[dict]:
    names = BASE_TOOLS + [t for g in SPECIALTIES[me["specialty"]]["tools"] for t in GROUP_TOOLS.get(g, [])]
    schemas = [TOOLS[n][1] for n in names]
    people = turn.people
    below = [people[i] for i in org.subtree(me["id"], list(people.values())) if i in people]
    if below:
        schemas.append(_fn("delegate", "Assign a task to someone in your part of the organisation. They do it and report back.",
            {"to": {"type": "string", "enum": [p["id"] for p in below],
                    "description": "; ".join(f"{p['id']} = {p['name']} ({p['title']['en']}, {p['room_name']})" for p in below)[:3000]},
             "title": {"type": "string", "description": "Short task title"},
             "instructions": {"type": "string", "description": "What to do, context, and what to send back"}},
            ["to", "title", "instructions"]))
    others = [p for p in people.values() if p["id"] != me["id"] and p["id"] not in {b["id"] for b in below}]
    if others:
        schemas.append(_fn("ask_colleague", "Ask a colleague outside your team for input. They answer you directly.",
            {"to": {"type": "string", "enum": [p["id"] for p in others],
                    "description": "; ".join(f"{p['id']} = {p['name']} ({p['title']['en']})" for p in others)[:3000]},
             "question": S}, ["to", "question"]))
    schemas.append(_fn("request_approval", "Ask the owner to approve something before you do it (spending, publishing, "
        "contacting outsiders, deleting data, big decisions). It appears in the owner's notifications.",
        {"title": S, "details": S, "kind": {"type": "string", "enum": ["general", "spend", "publish", "access", "decision"]}},
        ["title", "details"]))
    if "email" in SPECIALTIES[me["specialty"]]["tools"]:
        schemas.append(_fn("send_email", "Ask the owner to approve sending an email that already has a draft.",
            {"email_id": I}, ["email_id"]))
    if me["id"] == "gm" or me["seniority"] <= 2:   # the GM and team leads can propose hires
        schemas.append(_fn("hire", "Hire people when no one in the company has the skills for a task. Either add them "
            "to an existing room of the same division (room_id) or open a new room. This call itself files the approval "
            "request for the owner (unless auto-hire is on) — do not also call request_approval for it.",
            {"reason": S, "room_id": {"type": "string", "description": "existing room id, or omit for a new room"},
             "room_name": {"type": "string", "description": "e.g. 'Market Intelligence'"},
             "division": {"type": "string", "enum": [d["id"] for d in DIVISIONS if d["id"] != "executive"]},
             "reports_to": {"type": "string", "description": "who leads them: normally you, or the head/lead of the SAME division. "
                                                             "Never someone from an unrelated division."},
             "people": {"type": "array", "items": {"type": "object", "properties": {
                 "specialty": {"type": "string", "enum": [s for s in SPECIALTIES if s != "general_manager"]},
                 "seniority": {"type": "integer", "enum": [2, 4], "description": "2 = Team lead, 4 = Team member"},
                 "name": S}, "required": ["specialty"]}}},
            ["reason", "people"]))
    if me["id"] == "gm":
        schemas.append(_fn("create_workflow", "Set up a recurring routine or a reusable multi-step process when the owner "
            "asks for something to happen regularly ('every morning…', 'each Sunday…') or wants a repeatable pipeline. "
            "Each step goes to one person (employee id) or to a role (specialty id: whoever holds it). The output of each "
            "step is passed to the next. It appears on the owner's Workflows page. Call it once; calling it again with "
            "the same name updates that workflow instead of adding another.",
            {"name": S, "description": S,
             "steps": {"type": "array", "items": {"type": "object", "properties": {
                 "to": {"type": "string", "description": "employee id, or a specialty id such as competitor_researcher"},
                 "title": S, "instructions": S,
                 "ask_owner_first": {"type": "boolean", "description": "wait for the owner's approval before this step"}},
                 "required": ["to", "title", "instructions"]}},
             "schedule": {"type": "object", "properties": {
                 "type": {"type": "string", "enum": ["manual", "daily", "weekly", "interval"]},
                 "time": {"type": "string", "description": "HH:MM, 24-hour local time"},
                 "days": {"type": "array", "items": {"type": "string", "enum": ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]},
                          "description": "weekly only: the days it runs"},
                 "every_hours": I}}},
            ["name", "steps"]))
    return schemas


# ---------------------------------------------------------------- prompts
def _division_name(div_id: str) -> str:
    return next((d["name"]["en"] for d in DIVISIONS if d["id"] == div_id), div_id)


def system_prompt(me: dict, turn, caller: str) -> str:
    people = turn.people
    spec = SPECIALTIES[me["specialty"]]
    company = db.get_setting("company", "Office Mini")
    mgr = people.get(me["reports_to"])
    reports = [p for p in people.values() if p["reports_to"] == me["id"]]
    lines = [
        f"You are {me['name']}, {me['title']['en']} at {company}, a software and SaaS company. "
        f"You work in the {_division_name(spec['division'])} division ({me['room_name']} room).",
        f"Expertise: {spec['expertise']}",
        (f"You report to {mgr['name']} ({mgr['title']['en']})." if mgr else "You lead the company and report directly to the owner."),
    ]
    if reports:
        lines.append("Your direct reports: " + "; ".join(f"{r['name']} — {r['title']['en']} (id {r['id']})" for r in reports) + ".")
    if me["id"] == "gm":
        lines.append("Company directory: " + "; ".join(f"{p['name']} — {p['title']['en']}, {p['room_name']} (id {p['id']})"
                                                       for p in people.values() if p["id"] != "gm") + ".")
        lines.append("Route every request to the right person: delegate to whoever has the expertise (normally via their "
                     "manager for big pieces of work). If nobody in the company has the needed skills, use hire() to propose "
                     "the right people, then tell the owner. Use org_overview for vacancies and room ids.")
    elif reports:
        lines.append("Delegate work that fits someone's expertise with delegate(); do quick things yourself.")
    else:
        lines.append("You have no direct reports: do the work yourself. Use ask_colleague when another team's expertise helps.")
    if me.get("instructions"):
        lines.append(f"Your role as described by the owner: {me['instructions']}")
    docs = kb.docs_for(me)
    if docs:
        lines.append("Knowledge files you can search with search_knowledge: " + ", ".join(d["name"] for d in docs[:25]) + ".")
    if caller == "owner":
        lines.append("You are talking directly with the owner of the company, in a phone chat.")
    elif caller == "workflow":
        lines.append("You are running one step of a workflow (a routine process the owner set up). Do the work — "
                     "yourself or by delegating parts to your team — then reply with the complete deliverable for this "
                     "step. Your reply is handed to the next step and kept for the owner, so make it self-contained.")
    else:
        boss = people.get(caller)
        lines.append(f"{boss['name'] if boss else 'A colleague'} sent you this request. Do it, then reply with a concise "
                     "report addressed to them (what you did, key findings, decisions they must make).")
    lines += [
        "Work like a seasoned professional: concrete, specific, expert output — never generic advice.",
        "Save substantial deliverables (plans, specs, research, code, copy) with save_document and mention the title.",
        "Before spending money, publishing, contacting outsiders or deleting things, use request_approval.",
        "Keep chat replies short (2–6 sentences). Call all the tools you need in one response when you can — the owner "
        "has a small daily budget of model requests.",
        "Never invent data that a tool did not return.",
        f"Today is {_today()}.",
    ]
    if turn.lang_ar is True:
        lines.append("Reply in friendly Gulf Arabic (the owner wrote in Arabic).")
    elif turn.lang_ar is False:
        lines.append("Reply in English (the owner wrote in English).")
    return "\n".join(lines)


# ---------------------------------------------------------------- the run
class Turn:
    def __init__(self, thread: str, review: bool, lang_ar: bool | None, cap: int = MAX_REQUESTS):
        self.thread, self.review, self.lang_ar, self.cap = thread, review, lang_ar, cap
        self.requests = 0
        self.people = {p["id"]: p for p in org.employees()}


def _summ(result) -> str:
    if not isinstance(result, dict):
        return str(result)[:120]
    if result.get("error"):
        return f"error: {result['error']}"
    parts = []
    for k, v in result.items():
        if isinstance(v, list):
            parts.append(f"{len(v)} {k}")
        elif k in ("ok", "note", "report"):
            continue
        elif isinstance(v, (str, int, float)) and len(str(v)) < 60:
            parts.append(f"{k}={v}")
    return ", ".join(parts)[:160] or "ok"


async def _run_tool(turn: Turn, me: dict, name: str, args: dict, depth: int) -> dict:
    argtxt = ", ".join(f"{k}={str(v)[:40]}" for k, v in args.items() if k not in ("content", "body", "instructions", "details"))
    await log(me["id"], "tool", f"{name}({argtxt})", {"tool": name})
    if name in ASYNC_TOOLS:
        await set_status(me["id"], "working", ASYNC_TOOLS[name])
        try:
            from . import workflows  # late import: workflows builds on this module
            result = await {"delegate": _delegate, "ask_colleague": _consult, "request_approval": _request_approval,
                            "hire": _hire, "send_email": _send_email,
                            "create_workflow": workflows.tool_create}[name](turn, me, args, depth)
        except Exception as e:
            result = {"error": str(e)}
    elif name in TOOLS:
        fn, _schema, label = TOOLS[name]
        await set_status(me["id"], "working", label)
        try:
            result = fn(turn, me, **args)
        except TypeError as e:
            result = {"error": f"bad arguments: {e}"}
        except Exception as e:
            result = {"error": str(e)}
        if name in RECORD_EVENT:
            await broadcast({"type": "records", "kind": RECORD_EVENT[name]})
    else:
        result = {"error": f"unknown tool {name}"}
    await log(me["id"], "error" if isinstance(result, dict) and result.get("error") else "result", f"{name} → {_summ(result)}",
              {"tool": name})
    return result


async def _hand_to(turn: Turn, me: dict, to: dict, title: str, instructions: str, depth: int, kind: str) -> dict:
    if depth + 1 > MAX_DEPTH or turn.requests >= turn.cap - 1:
        return {"error": "No budget left for this hand-off now; do it yourself or tell the owner."}
    now = time.time()
    task_id = db.run("insert into tasks(ts, updated, thread, title, detail, assigner, assignee, status, result) "
                     "values(?,?,?,?,?,?,?,?,?)", (now, now, turn.thread, title, instructions, me["id"], to["id"],
                                                    "in_progress", None))
    await broadcast({"type": "handoff", "from": me["id"], "to": to["id"], "title": title, "task_id": task_id, "kind": kind})
    await broadcast({"type": "records", "kind": "tasks"})
    msg = db.add_message(turn.thread, "handoff", me["id"], title, {"to": to["id"], "task_id": task_id, "kind": kind,
                                                                   "instructions": instructions})
    await broadcast({"type": "message", "message": msg})
    await log(me["id"], "handoff", f"{'Asked' if kind == 'consult' else 'Assigned'} {to['name']}: {title}", {"to": to["id"], "task_id": task_id})
    await log(to["id"], "handoff", f"New {'question' if kind == 'consult' else 'task'} from {me['name']}: {title}",
              {"from": me["id"], "task_id": task_id})
    await set_status(me["id"], "working", f"Waiting on {to['name'].split()[0]}")

    report, ok = await run_employee(turn, to, instructions, caller=me["id"], depth=depth + 1)
    db.run("update tasks set status=?, result=?, updated=? where id=?", ("done" if ok else "blocked", report, time.time(), task_id))
    await broadcast({"type": "report", "from": to["id"], "to": me["id"], "task_id": task_id, "ok": ok})
    await broadcast({"type": "records", "kind": "tasks"})
    msg = db.add_message(turn.thread, "report", to["id"], report, {"to": me["id"], "task_id": task_id, "ok": ok, "kind": kind})
    await broadcast({"type": "message", "message": msg})
    await log(to["id"], "report", f"Reported to {me['name']}: {report[:200]}", {"to": me["id"], "task_id": task_id})
    return {"report": report, "task_id": task_id, "status": "done" if ok else "blocked"}


async def _delegate(turn, me, args, depth):
    to = turn.people.get(args.get("to"))
    if not to or to["id"] not in org.subtree(me["id"], list(turn.people.values())):
        return {"error": "You can only delegate to people in your part of the organisation; use ask_colleague otherwise."}
    title = (args.get("title") or "Task")[:120]
    return await _hand_to(turn, me, to, title, args.get("instructions") or title, depth, "task")


async def _consult(turn, me, args, depth):
    to = turn.people.get(args.get("to"))
    if not to or to["id"] == me["id"]:
        return {"error": "Unknown colleague"}
    q = (args.get("question") or "")[:2000]
    return await _hand_to(turn, me, to, q[:120], q, depth, "consult")


async def _approval(turn, me, kind, title, detail, payload=None) -> int:
    aid = db.run("insert into approvals(ts, employee, kind, title, detail, payload, thread) values(?,?,?,?,?,?,?)",
                 (time.time(), me["id"], kind, title[:200], detail[:3000], json.dumps(payload or {}), turn.thread))
    await notify("approval", me["id"], title, detail, str(aid))
    await log(me["id"], "approval", f"Requested approval: {title}", {"approval_id": aid, "kind": kind})
    await broadcast({"type": "approvals"})
    return aid


async def _request_approval(turn, me, args, depth):
    aid = await _approval(turn, me, args.get("kind") or "general", args.get("title") or "Approval needed", args.get("details") or "")
    return {"approval_id": aid, "status": "pending", "note": "The owner will decide in the notifications panel. Tell them it's waiting."}


async def _send_email(turn, me, args, depth):
    e = db.one("select * from emails where id=?", (args.get("email_id"),))
    if not e or not e["draft"]:
        return {"error": "That email has no draft yet. Use draft_reply first."}
    aid = await _approval(turn, me, "send_email", f"Send reply: {e['subject']}",
                          f"To: {e['sender']}\n\n{e['draft']}", {"email_id": e["id"]})
    return {"approval_id": aid, "status": "pending", "note": "Sending waits for the owner's approval."}


async def _hire(turn, me, args, depth):
    people = [p for p in (args.get("people") or []) if p.get("specialty") in SPECIALTIES and p["specialty"] != "general_manager"]
    if not people:
        return {"error": "List at least one person with a valid specialty."}
    division = args.get("division") or SPECIALTIES[people[0]["specialty"]]["division"]
    boss = turn.people.get(args.get("reports_to") or me["id"]) or me
    # sanity: a new team reports to the hirer, or to a leader in the same division
    if boss["id"] not in (me["id"], "gm") and (boss.get("room_division") != division or boss["seniority"] > 2):
        boss = me
    room = db.one("select id, division from rooms where id=?", (args.get("room_id"),)) if args.get("room_id") else None
    spec = {"room_id": room["id"] if room else None, "room_name": args.get("room_name"), "division": division,
            "reports_to": boss["id"], "people": people[:12], "reason": args.get("reason", "")}
    roles = ", ".join(SPECIALTIES[p["specialty"]]["title"]["en"] for p in people)
    if db.get_setting("auto_hire", False):
        res = org.hire(spec)
        turn.people = {p["id"]: p for p in org.employees()}
        await announce_hire(me["id"], res, roles)
        return {"hired": res, "note": "Hired. They can take work right away."}
    where = (room and next((r["name"] for r in org.rooms() if r["id"] == room["id"]), "")) or args.get("room_name") or "a new room"
    aid = await _approval(turn, me, "hire", f"Hire: {roles}", f"{args.get('reason', '')}\n\nRoom: {where}\nReports to: {boss['name']}", spec)
    return {"approval_id": aid, "status": "pending", "reports_to": boss["name"],
            "note": "Approval request filed (no need to call request_approval). Tell the owner it's waiting in notifications."}


async def announce_hire(by: str, res: dict, roles: str) -> None:
    await broadcast({"type": "org_changed"})
    await log(by, "hire", f"Hired {roles}", res)
    await notify("hire", by, f"New hires: {roles}", "", res.get("room_id", ""))


async def decide(aid: int, approve: bool, note: str = "") -> dict:
    a = db.one("select * from approvals where id=?", (aid,))
    if not a or a["status"] != "pending":
        raise ValueError("This request was already decided")
    payload = json.loads(a["payload"] or "{}")
    result = ""
    if approve and a["kind"] == "hire":
        people = {p["id"]: p for p in org.employees()}
        boss = people.get(payload.get("reports_to"))
        div = payload.get("division") or SPECIALTIES.get((payload.get("people") or [{}])[0].get("specialty", ""), {}).get("division")
        if not boss or (boss["id"] not in ("gm", a["employee"]) and (boss.get("room_division") != div or boss["seniority"] > 2)):
            payload["reports_to"] = a["employee"] if a["employee"] in people else "gm"
        res = org.hire(payload)
        await announce_hire(a["employee"], res, a["title"].removeprefix("Hire: "))
        result = "Hired."
    elif a["kind"] == "workflow":
        from . import workflows
        result = workflows.gate_decided(aid, approve, note)
    elif approve and a["kind"] == "send_email":
        db.run("update emails set archived=1 where id=?", (payload.get("email_id"),))
        result = "Marked as sent (real sending needs the Gmail connection)."
    db.run("update approvals set status=?, decided=?, note=? where id=?",
           ("approved" if approve else "rejected", time.time(), note, aid))
    verdict = "approved" if approve else "declined"
    msg = db.add_message(a["thread"] or a["employee"], "approval", "owner", f"{verdict}: {a['title']}",
                         {"approval_id": aid, "approved": approve, "to": a["employee"], "note": note, "result": result})
    await broadcast({"type": "message", "message": msg})
    await log(a["employee"], "approval", f"Owner {verdict}: {a['title']}{f' — {note}' if note else ''}", {"approval_id": aid})
    await broadcast({"type": "approvals"})
    return {"ok": True, "result": result}


async def _resolve_model(me: dict, image: bool) -> tuple[str, list[str], dict | None]:
    """The model to call, its fallbacks, and the API key to use (employee's → room's → None = company key)."""
    ref = me.get("model") or default_model()
    if image:
        info = await model_info(ref)
        if "vision" not in info.get("caps", []):
            await log(me["id"], "info", f"{ref.split(':', 1)[1]} can't see images — using {vision_model().split(':', 1)[1]} for this photo")
            ref = vision_model()
    fallbacks = MODEL_FALLBACKS if ref.startswith("openrouter:") else []
    return ref, fallbacks, keys.resolve(me, ref)


async def run_employee(turn: Turn, me: dict, content, caller: str, depth: int,
                       history: list | None = None, image: str | None = None) -> tuple[str, bool]:
    """Run one employee on one request. Returns (reply or report text, success)."""
    tools = tools_for(me, turn)
    messages = [{"role": "system", "content": system_prompt(me, turn, caller)}, *(history or []), {"role": "user", "content": content}]
    ref, fallbacks, key = await _resolve_model(me, bool(image))
    await set_status(me["id"], "working", "Thinking…" if caller == "owner" else "On a task")

    reply, sub_reports, ok = "", [], True
    try:
        for rnd in range(MAX_ROUNDS):
            if turn.requests >= turn.cap:
                reply = reply or "I had to stop here: this message used its whole request budget."
                break
            last = rnd == MAX_ROUNDS - 1 or turn.requests >= turn.cap - 1
            await log(me["id"], "model", f"Thinking with {ref.split(':', 1)[1]}" + (f" · key “{key['label']}”" if key else ""),
                      {"model": ref, "key": key["id"] if key else None})
            msg = await complete(ref, messages, None if last else tools, fallbacks=fallbacks,
                                 secret=key["secret"] if key else None)
            turn.requests += 1
            if key:
                keys.record_use(key["id"])
            await log(me["id"], "model", f"{msg['_model'].split(':', 1)[-1]} replied in {msg['_secs']}s · "
                      f"{msg['_usage'].get('in') or 0}→{msg['_usage'].get('out') or 0} tokens · {msg['_finish']}",
                      {"model": msg["_model"], **msg["_usage"], "secs": msg["_secs"]})
            await broadcast({"type": "budget", "used": turn.requests, "cap": turn.cap})
            calls = msg.get("tool_calls") or []
            if not calls:
                reply = (msg.get("content") or "").strip()
                if not reply and msg["_finish"] == "length" and rnd < MAX_ROUNDS - 1:
                    messages.append({"role": "user", "content": "Please give your final answer now, briefly."})
                    continue
                break
            messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
            only_handoffs = all(c.get("function", {}).get("name") in ("delegate", "ask_colleague") for c in calls)
            for call in calls:
                fname = call.get("function", {}).get("name", "")
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = await _run_tool(turn, me, fname, args, depth)
                if fname in ("delegate", "ask_colleague") and result.get("report"):
                    sub_reports.append(result["report"])
                messages.append({"role": "tool", "tool_call_id": call.get("id") or fname,
                                 "content": json.dumps(result, ensure_ascii=False, default=str)})
            if only_handoffs and not turn.review and sub_reports:
                reply = (msg.get("content") or "").strip()
                break
        if not reply and caller != "owner":
            reply = "\n\n".join(sub_reports) or "Done."
        await set_status(me["id"], "done", "Reported back" if caller != "owner" else "Replied")
    except LLMError as e:
        ok = False
        text = str(e)
        if key:  # the employee's / room's own key failed: flag that key, not the company one
            k = keys.mark_error(key["id"], e.status, text)
            await broadcast({"type": "keys"})
            if k["level"] == "red":
                await notify("error", me["id"], f"API key “{k['label']}” {k['state']}", k["detail"])
        else:
            h = mark_error(ref, e)
            await broadcast({"type": "health", "health": h})
            if h["level"] == "red":
                await notify("error", me["id"], f"{h['provider']} API {h['state']}", h["detail"])
        reply = ("The free daily request limit is used up (or the free model is busy). Try again in a bit."
                 if e.status == 429 or "rate" in text.lower() or "limit" in text.lower() else f"I couldn't reach my AI model: {text}")
        await set_status(me["id"], "error", "Model error")
        await log(me["id"], "error", text)
        await notify("error", me["id"], f"{me['name']} hit a model error", text)
    return reply, ok


_turn_lock = asyncio.Lock()


def _history(thread: str) -> list[dict]:
    out = []
    for m in db.thread_messages(thread, 14):
        if m["kind"] == "user":
            out.append({"role": "user", "content": m["content"]})
        elif m["kind"] == "reply":
            out.append({"role": "assistant", "content": m["content"]})
        elif m["kind"] == "report":
            out.append({"role": "assistant", "content": f"[Report received] {m['content'][:600]}"})
        elif m["kind"] == "approval":
            out.append({"role": "user", "content": f"[Owner {m['content']}]"})
    return out[-10:]


def _mention_context(mentions: list[dict], people: dict) -> str:
    lines = []
    for m in mentions or []:
        if m.get("type") == "employee" and m.get("id") in people:
            p = people[m["id"]]
            lines.append(f"- {p['name']} (id {p['id']}), {p['title']['en']}, {p['room_name']} room")
        elif m.get("type") == "room":
            ppl = [p for p in people.values() if p["room_id"] == m.get("id")]
            lead = next((p for p in ppl if p["is_lead"]), ppl[0] if ppl else None)
            if lead:
                lines.append(f"- the {lead['room_name']} room: lead {lead['name']} (id {lead['id']}); members "
                             + ", ".join(f"{p['name']} ({p['title']['en']}, id {p['id']})" for p in ppl))
        elif m.get("type") == "division":
            ppl = sorted((p for p in people.values() if p.get("room_division") == m.get("id")), key=lambda p: p["seniority"])
            if ppl:
                lines.append(f"- the {_division_name(m['id'])} division: " + ", ".join(
                    f"{p['name']} ({p['title']['en']}, id {p['id']})" for p in ppl[:12]))
    if not lines:
        return ""
    return ("\n\n[The owner tagged these people/teams. Route the request to them: delegate if they are in your part of "
            "the organisation, otherwise ask_colleague.]\n" + "\n".join(lines))


async def chat(thread: str, text: str, image: str | None = None, mentions: list | None = None) -> dict:
    me = org.employee(thread)
    if not me:
        raise ValueError("Unknown employee")
    async with _turn_lock:
        lang_ar = any("؀" <= ch <= "ۿ" for ch in text) if text else None
        turn = Turn(thread, bool(db.get_setting("review_reports", False)), lang_ar)
        history = _history(thread)
        user = db.add_message(thread, "user", "owner", text or "(photo)", {"image": bool(image), "mentions": mentions or []})
        await broadcast({"type": "message", "message": user})
        await log(thread, "info", f"Message from the owner: {text[:160]}")
        content = (text or "Here is a photo.") + _mention_context(mentions or [], turn.people)
        if image:
            content = [{"type": "text", "text": content}, {"type": "image_url", "image_url": {"url": image}}]
        reply, ok = await run_employee(turn, turn.people[thread], content, "owner", 0, history, image)
        if reply or not ok:
            out = db.add_message(thread, "reply" if ok else "error", thread, reply or "Done.", {"requests": turn.requests})
            await broadcast({"type": "message", "message": out})
        await broadcast({"type": "turn_done", "thread": thread, "requests": turn.requests})
        q = await quota(force=True)
        if q:
            await broadcast({"type": "quota", **q})
            await broadcast({"type": "health", "health": await check_health("openrouter")})
        return {"requests": turn.requests}
