"""Workflows: reusable multi-step processes that run on demand or on a schedule.

- A workflow is an ordered list of steps. Each step goes to a person, a room (its lead), a division (its head) or a
  role (whoever holds it; the GM routes it when nobody does).
- Each step's output is handed to the next one. A step can wait for the owner's approval first.
- Every run has its own request budget. Scheduled runs are skipped when the free daily allowance is running low, so a
  routine never eats the requests you need for chatting.
- The scheduler checks every 20 seconds. Runs that were missed while the app was off are not replayed.
"""
import asyncio
import datetime as dt
import json
import re
import time

from . import agents, db, org
from .catalog import DIVISIONS, SPECIALTIES
from .providers import quota

TRIGGERS = ("manual", "interval", "daily", "weekly")
ICONS = ("zap", "inbox", "trending", "code", "megaphone", "alert", "clock", "file", "users", "target", "flask", "star")
MAX_STEPS = 8
MAX_BUDGET = 40
_tasks: dict[int, asyncio.Task] = {}               # run id -> running task
_gates: dict[int, tuple[asyncio.Event, dict]] = {}  # approval id -> (event, verdict)
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


class WorkflowError(Exception):
    pass


# ---------------------------------------------------------------- templates
def _step(to, title, title_ar, instructions, gate=False):
    return {"to": to, "title": title, "title_ar": title_ar, "instructions": instructions, "gate": gate}


TEMPLATES = [
    {"id": "inbox_triage", "icon": "inbox", "name": {"en": "Morning inbox triage", "ar": "فرز البريد الصباحي"},
     "description": {"en": "Every morning the Email Manager clears the noise, drafts replies and tells you what needs you.",
                     "ar": "كل صباح مدير الإيميلات ينظف البريد ويجهز ردود ويقولك شنو يحتاجك."},
     "trigger": {"type": "daily", "time": "08:00"},
     "steps": [_step("role:email_manager", "Triage the inbox", "فرز البريد",
                     "Go through the unread emails. Archive noise and newsletters, draft replies for anything that needs "
                     "an answer, and give me a short prioritised list: what needs me today, what you drafted, what you archived.")]},
    {"id": "standup", "icon": "users", "name": {"en": "Daily stand-up", "ar": "الاجتماع اليومي"},
     "description": {"en": "The GM reviews the org and the task board, then sends you blockers and today's priorities.",
                     "ar": "المدير العام يراجع الشركة والمهام ويرسلك المعوقات وأولويات اليوم."},
     "trigger": {"type": "daily", "time": "09:30"},
     "steps": [_step("emp:gm", "Run the stand-up", "إدارة الاجتماع",
                     "Run a short stand-up. Check org_overview and recent tasks. Summarise what each team finished "
                     "recently, what is blocked and why, and the top 3 priorities for today. Don't delegate — just report.")]},
    {"id": "competitor_brief", "icon": "trending", "name": {"en": "Weekly competitor brief", "ar": "ملخص المنافسين الأسبوعي"},
     "description": {"en": "Research scans the market, then Product turns it into concrete opportunities.",
                     "ar": "البحث يمسح السوق، والمنتج يحولها لفرص واضحة."},
     "trigger": {"type": "weekly", "time": "09:00", "days": [6]},
     "steps": [_step("role:competitor_researcher", "Scan the competition", "مسح المنافسين",
                     "Write a brief on our main competitors: notable moves, pricing or feature changes, positioning. Use "
                     "your knowledge files. Never invent news — mark clearly what needs verification. Save it as a document."),
               _step("role:product_manager", "Product implications", "انعكاسات على المنتج",
                     "Turn the competitor brief into at most 3 concrete product opportunities or threats, each with a "
                     "suggested next step and a rough effort estimate.")]},
    {"id": "feature_pipeline", "icon": "code", "input_hint": {"en": "Which feature?", "ar": "أي ميزة؟"},
     "name": {"en": "Feature pipeline", "ar": "مسار الميزة"},
     "description": {"en": "Spec → technical design → test plan → release notes, with your OK before anything is announced.",
                     "ar": "مواصفات ← تصميم تقني ← خطة اختبار ← ملاحظات الإصدار، مع موافقتك قبل الإعلان."},
     "trigger": {"type": "manual"},
     "steps": [_step("role:product_manager", "Write the spec", "كتابة المواصفات",
                     "Write a concise product spec for: {input}. Problem, users, scope, acceptance criteria, out of scope. "
                     "Save it as a document."),
               _step("role:software_architect", "Technical design", "التصميم التقني",
                     "Design the implementation for this spec: components, data model, APIs, risks, and a task breakdown "
                     "with estimates. Save it as a document."),
               _step("role:qa_engineer", "Test plan", "خطة الاختبار",
                     "Write the test plan: test cases including edge cases, what to automate, and the release checklist."),
               _step("role:technical_writer", "Release notes", "ملاحظات الإصدار",
                     "Write user-facing release notes and a short changelog entry for this feature.", gate=True)]},
    {"id": "launch_kit", "icon": "megaphone", "input_hint": {"en": "What are we launching?", "ar": "شنو بنطلق؟"},
     "name": {"en": "Launch kit", "ar": "حزمة الإطلاق"},
     "description": {"en": "Marketing plans the launch, Content writes the copy, and Growth prepares the go-live checklist.",
                     "ar": "التسويق يخطط، المحتوى يكتب، والنمو يجهز قائمة الإطلاق."},
     "trigger": {"type": "manual"},
     "steps": [_step("role:marketing_manager", "Launch plan", "خطة الإطلاق",
                     "Plan the launch of: {input}. Audience, positioning, channels, timeline, success metrics."),
               _step("role:content_marketer", "Launch copy", "نصوص الإطلاق",
                     "Write the launch copy from the plan: landing-page headline and subhead, 3 social posts, and a "
                     "launch email. Save it as a document."),
               _step("role:growth_marketer", "Go-live checklist", "قائمة الإطلاق",
                     "Prepare the go-live checklist and the first-week experiments to run.", gate=True)]},
    {"id": "security_check", "icon": "alert", "name": {"en": "Weekly security check", "ar": "فحص الأمان الأسبوعي"},
     "description": {"en": "Security reviews alerts and expiring certificates, then lists fixes by severity.",
                     "ar": "الأمن يراجع التنبيهات والشهادات المنتهية ويرتب الإصلاحات حسب الخطورة."},
     "trigger": {"type": "weekly", "time": "10:00", "days": [0]},
     "steps": [_step("role:security_engineer", "Security review", "مراجعة الأمان",
                     "Review our security posture. Ask the Email Manager for any security-related emails (dependency "
                     "alerts, certificate expiries, access notices). List each issue with severity, deadline and the fix.")]},
]


# ---------------------------------------------------------------- storage
def _load(r: dict) -> dict:
    r["steps"] = json.loads(r["steps"] or "[]")
    r["trigger"] = json.loads(r["trigger"] or '{"type":"manual"}')
    r["enabled"] = bool(r["enabled"])
    r["save_output"] = bool(r["save_output"])
    return r


def _load_run(r: dict) -> dict:
    r["steps"] = json.loads(r["steps"] or "[]")
    return r


def get(wid: int) -> dict | None:
    r = db.one("select * from workflows where id=?", (wid,))
    return _load(r) if r else None


def run(rid: int) -> dict | None:
    r = db.one("select * from workflow_runs where id=?", (rid,))
    return _load_run(r) if r else None


def budget_of(wf: dict) -> int:
    return max(2, min(MAX_BUDGET, wf.get("budget") or 4 * max(1, len(wf["steps"]))))


def listing() -> list[dict]:
    out = []
    for w in db.rows("select * from workflows order by id"):
        w = _load(w)
        last = db.one("select id, status, ts, finished, requests, trigger from workflow_runs where workflow_id=? "
                      "order by id desc limit 1", (w["id"],))
        w["last_run"] = last
        w["running"] = any(r["workflow_id"] == w["id"] for r in _active())
        w["budget_effective"] = budget_of(w)
        out.append(w)
    return out


def runs(workflow_id: int | None = None, limit: int = 40) -> list[dict]:
    if workflow_id:
        rs = db.rows("select * from workflow_runs where workflow_id=? order by id desc limit ?", (workflow_id, limit))
    else:
        rs = db.rows("select * from workflow_runs order by id desc limit ?", (limit,))
    return [_load_run(r) for r in rs]


def _active() -> list[dict]:
    return db.rows("select id, workflow_id from workflow_runs where status in ('running','waiting')")


# ---------------------------------------------------------------- schedule maths
def next_after(trigger: dict, after: float) -> float | None:
    kind = trigger.get("type", "manual")
    if kind == "interval":
        return after + max(1, min(168, int(trigger.get("every_hours") or 24))) * 3600
    if kind not in ("daily", "weekly"):
        return None
    m = _TIME.match(trigger.get("time") or "09:00")
    hh, mm = (int(m.group(1)), int(m.group(2))) if m else (9, 0)
    days = set(trigger.get("days") or []) if kind == "weekly" else set(range(7))
    if not days:
        return None
    base = dt.datetime.fromtimestamp(after).replace(hour=hh, minute=mm, second=0, microsecond=0)
    for k in range(0, 8):
        cand = base + dt.timedelta(days=k)
        if cand.timestamp() > after and cand.weekday() in days:
            return cand.timestamp()
    return None


def _clean_trigger(t: dict | None) -> dict:
    t = t or {}
    kind = t.get("type") if t.get("type") in TRIGGERS else "manual"
    out = {"type": kind}
    if kind == "interval":
        out["every_hours"] = max(1, min(168, int(t.get("every_hours") or 24)))
    if kind in ("daily", "weekly"):
        out["time"] = t.get("time") if _TIME.match(str(t.get("time") or "")) else "09:00"
        out["time"] = "%02d:%s" % (int(out["time"].split(":")[0]), out["time"].split(":")[1])
    if kind == "weekly":
        out["days"] = sorted({int(d) for d in (t.get("days") or []) if str(d).lstrip("-").isdigit() and 0 <= int(d) <= 6}) or [0]
    return out


def _valid_target(to: str) -> bool:
    kind, _, ref = (to or "").partition(":")
    if kind == "emp":
        return org.employee(ref) is not None
    if kind == "room":
        return db.one("select id from rooms where id=?", (ref,)) is not None
    if kind == "div":
        return any(d["id"] == ref for d in DIVISIONS)
    if kind == "role":
        return ref in SPECIALTIES
    return False


def save(body: dict, wid: int | None = None, created_by: str = "owner") -> int:
    name = (body.get("name") or "").strip()[:60]
    if not name:
        raise WorkflowError("Give the workflow a name")
    steps = []
    for s in (body.get("steps") or [])[:MAX_STEPS]:
        to = s.get("to") or ""
        if not _valid_target(to):
            raise WorkflowError(f"Step '{s.get('title') or len(steps) + 1}' has no valid assignee")
        title = (s.get("title") or "").strip()[:80] or f"Step {len(steps) + 1}"
        instructions = (s.get("instructions") or "").strip()[:4000]
        if not instructions:
            raise WorkflowError(f"Step '{title}' needs instructions")
        steps.append({"to": to, "title": title, "instructions": instructions, "gate": bool(s.get("gate"))})
    if not steps:
        raise WorkflowError("Add at least one step")
    trigger = _clean_trigger(body.get("trigger"))
    enabled = bool(body.get("enabled", True))
    now = time.time()
    nxt = next_after(trigger, now) if enabled else None
    vals = (name, (body.get("description") or "")[:300], body.get("icon") if body.get("icon") in ICONS else "zap",
            json.dumps(steps, ensure_ascii=False), json.dumps(trigger), int(enabled),
            (body.get("input_hint") or "")[:80], (body.get("default_input") or "")[:1000],
            max(0, min(MAX_BUDGET, int(body.get("budget") or 0))), max(0, min(50, int(body.get("min_quota", 10) or 0))),
            int(bool(body.get("save_output", True))), (body.get("template") or "")[:40])
    if wid:
        if not get(wid):
            raise WorkflowError("No such workflow")
        db.run("update workflows set name=?, description=?, icon=?, steps=?, trigger=?, enabled=?, input_hint=?, "
               "default_input=?, budget=?, min_quota=?, save_output=?, template=?, updated=?, next_run=? where id=?",
               (*vals, now, nxt, wid))
        return wid
    return db.run("insert into workflows(name, description, icon, steps, trigger, enabled, input_hint, default_input, "
                  "budget, min_quota, save_output, template, created_by, created, updated, next_run) "
                  "values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (*vals, created_by, now, now, nxt))


def set_enabled(wid: int, enabled: bool) -> None:
    wf = get(wid)
    if not wf:
        raise WorkflowError("No such workflow")
    db.run("update workflows set enabled=?, next_run=? where id=?",
           (int(enabled), next_after(wf["trigger"], time.time()) if enabled else None, wid))


def delete(wid: int) -> None:
    for r in _active():
        if r["workflow_id"] == wid:
            cancel(r["id"])
    db.run("delete from workflows where id=?", (wid,))


# ---------------------------------------------------------------- resolving who does a step
def resolve(to: str, people: dict) -> tuple[dict | None, str]:
    """Returns (employee, note). The note explains a fallback to the GM."""
    kind, _, ref = (to or "").partition(":")
    by_rank = lambda ps: sorted(ps, key=lambda p: (not p.get("is_lead"), p["seniority"], p["created"] or 0))
    if kind == "emp" and ref in people:
        return people[ref], ""
    if kind == "room":
        ps = by_rank([p for p in people.values() if p["room_id"] == ref])
        if ps:
            return ps[0], ""
    if kind == "div":
        ps = sorted((p for p in people.values() if p.get("room_division") == ref), key=lambda p: p["seniority"])
        if ps:
            return ps[0], ""
    if kind == "role":
        ps = sorted((p for p in people.values() if p["specialty"] == ref), key=lambda p: p["seniority"])
        if ps:
            return ps[0], ""
        title = SPECIALTIES.get(ref, {}).get("title", {}).get("en", ref)
        return people.get("gm"), (f"Nobody in the company is a {title} yet. Get this step done by the right person — "
                                  f"delegate it, or propose a hire if no one fits.")
    return people.get("gm"), "The person this step was meant for has left the company. Route it to the right person."


# ---------------------------------------------------------------- running
async def _push(rid: int) -> None:
    await agents.broadcast({"type": "workflow", "run": run(rid)})


def _save_run(rid: int, **fields) -> None:
    if "steps" in fields:
        fields["steps"] = json.dumps(fields["steps"], ensure_ascii=False, default=str)
    sets = ", ".join(f"{k}=?" for k in fields)
    db.run(f"update workflow_runs set {sets} where id=?", (*fields.values(), rid))


async def start(wid: int, trigger: str = "manual", input_text: str | None = None) -> int:
    wf = get(wid)
    if not wf:
        raise WorkflowError("No such workflow")
    if any(r["workflow_id"] == wid for r in _active()):
        raise WorkflowError("This workflow is already running")
    text = (input_text if input_text is not None else wf["default_input"] or "").strip()[:2000]
    steps = [{**s, "status": "pending", "assignee": None, "output": "", "requests": 0, "started": None,
              "finished": None, "approval_id": None, "note": ""} for s in wf["steps"]]
    rid = db.run("insert into workflow_runs(workflow_id, name, ts, status, trigger, input, steps, budget) "
                 "values(?,?,?,?,?,?,?,?)", (wid, wf["name"], time.time(), "running", trigger, text,
                                             json.dumps(steps, ensure_ascii=False), budget_of(wf)))
    _tasks[rid] = asyncio.create_task(_run(rid, wf))
    await _push(rid)
    await agents.broadcast({"type": "workflows"})
    return rid


def _content(wf: dict, i: int, step: dict, input_text: str, prev: tuple | None, note: str, owner_note: str) -> str:
    instr = step["instructions"].replace("{input}", input_text or "(no brief given)")
    parts = [f"Workflow \"{wf['name']}\" — step {i + 1} of {len(wf['steps'])}: {step['title']}", "", instr]
    if input_text and "{input}" not in step["instructions"]:
        parts += ["", f"Brief from the owner: {input_text}"]
    if prev:
        who, title, out = prev
        parts += ["", f"Output of the previous step ({title}, by {who}):", out[:3500]]
    if owner_note:
        parts += ["", f"Note from the owner: {owner_note}"]
    if note:
        parts += ["", note]
    return "\n".join(parts)


async def _run(rid: int, wf: dict) -> None:
    r = run(rid)
    steps = r["steps"]
    turn = agents.Turn(f"wf:{rid}", bool(db.get_setting("review_reports", False)), None, cap=r["budget"])
    prev, current, status, error = None, None, "done", ""
    try:
        await agents.log("gm", "info", f"Workflow started: {wf['name']} ({r['trigger']})", {"run_id": rid})
        for i, st in enumerate(steps):
            turn.people = {p["id"]: p for p in org.employees()}
            me, note = resolve(st["to"], turn.people)
            if not me:
                raise RuntimeError("No one can take this step (the General Manager is missing)")
            current = me
            st["assignee"] = me["id"]
            _save_run(rid, step=i, steps=steps)
            owner_note = ""
            if st.get("gate"):
                st["status"] = "waiting"
                _save_run(rid, status="waiting", steps=steps)
                aid = await agents._approval(turn, me, "workflow", f"{wf['name']}: start “{st['title']}”?",
                                             (f"Step {i + 1} of {len(steps)} goes to {me['name']}.\n\n"
                                              + (f"Previous step's result:\n{prev[2][:1500]}" if prev else st["instructions"][:1500])),
                                             {"run_id": rid, "step": i})
                st["approval_id"] = aid
                _save_run(rid, steps=steps)
                await _push(rid)
                ev = asyncio.Event()
                _gates[aid] = (ev, {})
                await ev.wait()
                verdict = _gates.pop(aid)[1]
                owner_note = verdict.get("note", "")
                st["note"] = owner_note
                if not verdict.get("approve"):
                    st["status"] = "skipped"
                    status, error = "stopped", "You declined a step, so the run stopped there."
                    break
                _save_run(rid, status="running")
            if turn.requests >= turn.cap:
                st["status"] = "skipped"
                status, error = "out_of_budget", f"The run used its whole budget of {turn.cap} requests."
                break
            st["status"], st["started"] = "running", time.time()
            _save_run(rid, steps=steps)
            await _push(rid)
            if prev and prev[3] != me["id"]:
                await agents.broadcast({"type": "handoff", "from": prev[3], "to": me["id"], "title": st["title"], "kind": "task"})
            await agents.log(me["id"], "handoff", f"Workflow “{wf['name']}” · step {i + 1}: {st['title']}", {"run_id": rid})
            now = time.time()
            task_id = db.run("insert into tasks(ts, updated, thread, title, detail, assigner, assignee, status, result) "
                             "values(?,?,?,?,?,?,?,?,?)", (now, now, turn.thread, f"{wf['name']} · {st['title']}",
                                                          st["instructions"], prev[3] if prev else me["id"], me["id"],
                                                          "in_progress", None))
            await agents.broadcast({"type": "records", "kind": "tasks"})
            content = _content(wf, i, st, r["input"], prev and prev[:3], note, owner_note)
            before = turn.requests
            async with agents._turn_lock:
                reply, ok = await agents.run_employee(turn, me, content, caller="workflow", depth=0)
            st.update(output=reply, requests=turn.requests - before, finished=time.time(), status="done" if ok else "failed")
            db.run("update tasks set status=?, result=?, updated=? where id=?", ("done" if ok else "blocked", reply, time.time(), task_id))
            await agents.broadcast({"type": "records", "kind": "tasks"})
            msg = db.add_message(turn.thread, "report", me["id"], reply, {"to": "owner", "task_id": task_id, "ok": ok, "step": i})
            await agents.broadcast({"type": "message", "message": msg})
            _save_run(rid, steps=steps, requests=turn.requests)
            await _push(rid)
            if not ok:
                status, error = "failed", reply[:300]
                break
            prev = (me["name"], st["title"], reply, me["id"])
    except asyncio.CancelledError:
        status, error = "cancelled", "Cancelled by you."
        for st in steps:
            if st["status"] in ("running", "waiting"):
                st["status"] = "skipped"
            if st.get("approval_id") and st["status"] != "done":
                db.run("update approvals set status='rejected', decided=?, note='Run cancelled' where id=? and status='pending'",
                       (time.time(), st["approval_id"]))
        if current:
            await agents.set_status(current["id"], "idle")
        await agents.broadcast({"type": "approvals"})
    except Exception as e:  # keep the scheduler alive whatever happens
        status, error = "failed", str(e)[:300]
        for st in steps:
            if st["status"] in ("running", "waiting"):
                st["status"] = "failed"
    finally:
        _tasks.pop(rid, None)
    for st in steps:
        if st["status"] == "pending" and status != "done":
            st["status"] = "skipped"
    doc_id = None
    done = [s for s in steps if s["status"] == "done" and s["output"]]
    if status == "done" and wf.get("save_output") and done:
        body = "\n\n".join(f"## {i + 1}. {s['title']}\n\n{s['output']}" for i, s in enumerate(done))
        head = f"_Workflow run · {dt.datetime.now().strftime('%d %b %Y %H:%M')}_" + (f"\n\n**Brief:** {r['input']}" if r["input"] else "")
        doc_id = db.run("insert into documents(ts, author, title, content, task_id) values(?,?,?,?,?)",
                        (time.time(), done[-1]["assignee"], f"{wf['name']} — {dt.date.today().strftime('%d %b')}",
                         f"{head}\n\n{body}", None))
        await agents.broadcast({"type": "records", "kind": "documents"})
    _save_run(rid, status=status, finished=time.time(), steps=steps, requests=turn.requests, error=error, doc_id=doc_id)
    await _push(rid)
    await agents.broadcast({"type": "workflows"})
    owner = (done[-1]["assignee"] if done else "gm")
    if status == "done":
        await agents.notify("workflow", owner, f"Workflow finished: {wf['name']}", (done[-1]["output"] if done else "")[:600], f"run:{rid}")
    elif status != "cancelled":
        await agents.notify("error" if status == "failed" else "workflow", owner, f"Workflow {status.replace('_', ' ')}: {wf['name']}", error, f"run:{rid}")
    q = await quota(force=True)
    if q:
        await agents.broadcast({"type": "quota", **q})


def gate_decided(aid: int, approve: bool, note: str) -> str:
    g = _gates.get(aid)
    if not g:
        return "That workflow run is no longer waiting."
    g[1].update(approve=approve, note=note)
    g[0].set()
    return "Workflow continues." if approve else "Workflow stopped."


def cancel(rid: int) -> bool:
    task = _tasks.get(rid)
    if task:
        task.cancel()
        return True
    r = run(rid)
    if r and r["status"] in ("running", "waiting"):  # orphaned (e.g. after a restart)
        _save_run(rid, status="cancelled", finished=time.time(), error="Cancelled by you.")
        return True
    return False


# ---------------------------------------------------------------- scheduler
def recover() -> None:
    """On start-up: runs that were in flight when the app stopped can't resume; missed schedules are not replayed."""
    now = time.time()
    for r in db.rows("select * from workflow_runs where status in ('running','waiting')"):
        r = _load_run(r)
        for st in r["steps"]:
            if st["status"] in ("running", "waiting", "pending"):
                st["status"] = "skipped"
            if st.get("approval_id"):
                db.run("update approvals set status='rejected', decided=?, note='App restarted' where id=? and status='pending'",
                       (now, st["approval_id"]))
        _save_run(r["id"], status="interrupted", finished=now, steps=r["steps"], error="The app was stopped while this ran.")
    for w in db.rows("select * from workflows where enabled=1"):
        w = _load(w)
        if not w["next_run"] or w["next_run"] < now:
            db.run("update workflows set next_run=? where id=?", (next_after(w["trigger"], now), w["id"]))


async def _skip(wf: dict, why: str) -> None:
    now = time.time()
    steps = [{**s, "status": "skipped", "assignee": None, "output": "", "requests": 0} for s in wf["steps"]]
    rid = db.run("insert into workflow_runs(workflow_id, name, ts, finished, status, trigger, steps, error) values(?,?,?,?,?,?,?,?)",
                 (wf["id"], wf["name"], now, now, "skipped", "schedule", json.dumps(steps, ensure_ascii=False), why))
    await agents.notify("workflow", "gm", f"Skipped: {wf['name']}", why, f"run:{rid}")
    await _push(rid)


async def scheduler_loop() -> None:
    recover()
    while True:
        try:
            now = time.time()
            for w in db.rows("select * from workflows where enabled=1 and next_run is not null and next_run<=?", (now,)):
                wf = _load(w)
                db.run("update workflows set next_run=? where id=?", (next_after(wf["trigger"], now), wf["id"]))
                if any(r["workflow_id"] == wf["id"] for r in _active()):
                    await _skip(wf, "The previous run was still going.")
                    continue
                q = await quota()
                if q and q.get("free_tier") and q.get("remaining") is not None and q["remaining"] < max(budget_of(wf) // 2, wf["min_quota"]):
                    await _skip(wf, f"Only {q['remaining']} free requests were left today (this routine needs a cushion of "
                                    f"{max(budget_of(wf) // 2, wf['min_quota'])}). It will try again next time.")
                    continue
                await start(wf["id"], "schedule")
        except Exception as e:  # never let one bad workflow stop the scheduler
            print(f"[workflows] scheduler error: {e}")
        await asyncio.sleep(20)


# ---------------------------------------------------------------- the GM's tool
async def tool_create(turn, me, args, depth) -> dict:
    people = turn.people
    steps = []
    for s in args.get("steps") or []:
        to = str(s.get("to") or "")
        target = (to if ":" in to else f"emp:{to}" if to in people else f"role:{to}" if to in SPECIALTIES else "")
        steps.append({"to": target, "title": s.get("title"), "instructions": s.get("instructions"),
                      "gate": bool(s.get("ask_owner_first"))})
    sched = dict(args.get("schedule") or {"type": "manual"})
    names = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
    sched["days"] = [names[str(d).lower()[:3]] for d in sched.get("days") or [] if str(d).lower()[:3] in names]
    name = (args.get("name") or "").strip()
    same = db.one("select id from workflows where lower(name)=lower(?)", (name,))   # re-running the tool updates, never duplicates
    try:
        wid = save({"name": name, "description": args.get("description", ""), "steps": steps,
                    "trigger": sched, "enabled": True, "icon": "zap"},
                   same["id"] if same else None, created_by=me["id"])
    except (WorkflowError, ValueError) as e:
        return {"error": str(e)}
    wf = get(wid)
    nxt = dt.datetime.fromtimestamp(wf["next_run"]).strftime("%a %d %b %H:%M") if wf["next_run"] else "only when run by hand"
    await agents.broadcast({"type": "workflows"})
    await agents.log(me["id"], "info", f"Set up workflow “{wf['name']}”", {"workflow_id": wid})
    await agents.notify("workflow", me["id"], f"New workflow: {wf['name']}", f"Next run: {nxt}", f"wf:{wid}")
    return {"ok": True, "workflow_id": wid, "next_run": nxt, "budget_per_run": budget_of(wf),
            "note": "It's on the owner's Workflows page, where they can edit, pause or run it now."}
