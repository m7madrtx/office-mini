"""The company's structure: rooms on floors, employees at desks, and who reports to whom."""
import json
import random
import re
import time
import uuid

from . import db
from .catalog import DIVISIONS, LEAD, MEMBER, PALETTE, SPECIALTIES, rank, title_for

MAX_DESKS, MAX_PER_DESK = 3, 4
DIVISION_IDS = {d["id"] for d in DIVISIONS}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
MODEL_REF = re.compile(r"^[a-z]+:.{2,200}$")
EMP_COLS = ("id, room_id, name, specialty, seniority, reports_to, color, desk, seat, is_lead, instructions, look, created, model, "
            "api_key_id")

SKINS = ["#F3D3B8", "#E7B98F", "#C98E62", "#9C6644", "#6B4329"]
HAIRS = ["#1E1915", "#3A2A20", "#6B4A2F", "#B7835A", "#D9C27A", "#A7AFBF", "#7A2E3A"]
STYLES = ["short", "long", "bun", "buzz", "curly"]
GLASSES = {"rd_researcher", "competitor_researcher", "data_analyst", "ux_researcher", "legal_counsel",
           "software_architect", "finance_analyst", "technical_writer"}
HEADSET = {"support_specialist", "sales_executive", "customer_success", "email_manager"}
ENGINEERS = {"frontend_engineer", "backend_engineer", "fullstack_engineer", "mobile_engineer", "devops_engineer",
             "qa_engineer", "security_engineer", "ml_engineer"}


class OrgError(ValueError):
    pass


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:6]}"


def random_look(specialty: str, rnd: random.Random | None = None) -> dict:
    rnd = rnd or random.Random()
    acc = None
    if specialty in GLASSES:
        acc = "glasses"
    elif specialty in HEADSET:
        acc = "headset"
    elif specialty in ENGINEERS and rnd.random() < 0.5:
        acc = "headphones"
    return {"skin": rnd.choice(SKINS), "hair": rnd.choice(HAIRS), "style": rnd.choice(STYLES), "acc": acc}


def _insert_employee(e: dict) -> None:
    db.run(f"insert into employees({EMP_COLS}) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
           (e["id"], e["room_id"], e["name"], e["specialty"], e["seniority"], e.get("reports_to"), e["color"],
            e["desk"], e["seat"], 1 if e.get("is_lead") else 0, e.get("instructions", ""), json.dumps(e["look"]),
            e.get("created", time.time()), e.get("model", ""), e.get("api_key_id")))


def _check_key(kid) -> int | None:
    """An API key id from the keys page, or None (= use the company key)."""
    if kid in (None, "", 0, "0"):
        return None
    if not db.one("select id from api_keys where id=?", (int(kid),)):
        raise OrgError("That API key no longer exists")
    return int(kid)


ROOM_COLS = ("id, name, division, kind, floor, slot, accent, desks, per_desk, color_mode, uniform_color, composition, created, "
             "theme, api_key_id")
THEMES = ["modern", "neon", "gaming", "gothic", "zen", "retro", "industrial", "space"]


def _insert_room(r: dict) -> None:
    db.run(f"insert into rooms({ROOM_COLS}) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
           (r["id"], r["name"], r["division"], r.get("kind", "team"), r["floor"], r["slot"], r["accent"], r["desks"],
            r["per_desk"], r.get("color_mode", "individual"), r.get("uniform_color"), r.get("composition", "mixed"),
            time.time(), r.get("theme", "modern"), r.get("api_key_id")))


# ---------------------------------------------------------------- seed
def seed_if_empty() -> None:
    if db.one("select id from rooms limit 1"):
        return
    db.set_setting("company", "Office Mini")
    db.set_setting("review_reports", False)
    db.set_setting("auto_hire", False)
    _insert_room({"id": "exec", "name": "Executive Suite", "division": "executive", "kind": "exec", "floor": -1, "slot": 0,
                  "accent": "#F5B544", "desks": 1, "per_desk": 1, "composition": "same"})
    _insert_employee({"id": "gm", "room_id": "exec", "name": "Khalid Al-Rashid", "specialty": "general_manager", "seniority": 0,
                      "color": "#F5B544", "desk": 0, "seat": 0, "is_lead": True,
                      "look": {"skin": "#E7B98F", "hair": "#1E1915", "style": "short", "acc": None}})
    _insert_room({"id": "r_comms", "name": "Communications", "division": "operations", "floor": 0, "slot": 0,
                  "accent": "#14B8A6", "desks": 1, "per_desk": 1, "composition": "same"})
    _insert_employee({"id": "e_email", "room_id": "r_comms", "name": "Mariam Haddad", "specialty": "email_manager",
                      "seniority": LEAD, "reports_to": "gm", "color": "#22C3EE", "desk": 0, "seat": 0, "is_lead": True,
                      "look": {"skin": "#F3D3B8", "hair": "#3A2A20", "style": "long", "acc": "headset"}})


# ---------------------------------------------------------------- read
def employees() -> list[dict]:
    out = db.rows(f"select {EMP_COLS} from employees order by created, desk, seat")
    by_id = {e["id"]: e for e in out}
    rooms_ = {r["id"]: r for r in db.rows("select id, name, division from rooms")}
    for e in out:
        e["look"] = json.loads(e["look"] or "{}")
        e["is_lead"] = bool(e["is_lead"])
        e["model"] = e.get("model") or ""
        e["title"] = title_for(e["specialty"], e["seniority"])
        e["division"] = SPECIALTIES.get(e["specialty"], {}).get("division")
        e["room_name"] = rooms_.get(e["room_id"], {}).get("name")
        e["room_division"] = rooms_.get(e["room_id"], {}).get("division")
        e["direct_reports"] = [x["id"] for x in out if x["reports_to"] == e["id"]]
        e["manager_name"] = by_id[e["reports_to"]]["name"] if e["reports_to"] in by_id else None
    return out


def employee(eid: str) -> dict | None:
    return next((e for e in employees() if e["id"] == eid), None)


def subtree(eid: str, people: list[dict] | None = None) -> list[str]:
    """Everyone below eid in the chain of command."""
    people = people or employees()
    out, frontier = [], [eid]
    while frontier:
        nxt = [p["id"] for p in people if p["reports_to"] in frontier and p["id"] not in out]
        out += nxt
        frontier = nxt
    return out


def rooms() -> list[dict]:
    return db.rows(f"select {ROOM_COLS} from rooms order by kind desc, floor, slot")


def _vacant(room: dict, taken: set) -> list[tuple[int, int]]:
    return [(d, s) for d in range(room["desks"]) for s in range(room["per_desk"]) if (d, s) not in taken]


def snapshot() -> dict:
    rs = rooms()
    emps = employees()
    for r in rs:
        taken = {(e["desk"], e["seat"]) for e in emps if e["room_id"] == r["id"]}
        r["vacancies"] = len(_vacant(r, taken))
    team = [r for r in rs if r["kind"] == "team"]
    floors = max([r["floor"] for r in team], default=-1) + 1
    occupied = {(r["floor"], r["slot"]) for r in team}
    free = [{"floor": f, "slot": s} for f in range(floors) for s in (0, 1) if (f, s) not in occupied]
    return {"company": db.get_setting("company", "Office Mini"),
            "settings": {"review_reports": db.get_setting("review_reports", False),
                         "auto_hire": db.get_setting("auto_hire", False),
                         "default_model": db.get_setting("default_model", ""),
                         "vision_model": db.get_setting("vision_model", ""),
                         "logo_v": db.get_setting("logo_v", 0)},   # company logo version (image served at /api/logo)
            "rooms": rs, "employees": emps, "floors": floors, "free_slots": free}


# ---------------------------------------------------------------- placement
def _assign_position(floor, slot, exclude: str | None) -> tuple[int, int]:
    team = [r for r in rooms() if r["kind"] == "team" and r["id"] != exclude]
    occupied = {(r["floor"], r["slot"]) for r in team}
    top = max([r["floor"] for r in team], default=-1)
    if floor == "new":
        return top + 1, 0
    if isinstance(floor, int) and floor >= 0:
        if slot in (0, 1) and (floor, slot) not in occupied:
            return floor, slot
        for s in (0, 1):
            if (floor, s) not in occupied:
                return floor, s
        if floor > top:
            return top + 1, 0
        raise OrgError("That floor is full. Pick another floor or a new floor.")
    for f in range(top + 1):  # auto: lowest free spot
        for s in (0, 1):
            if (f, s) not in occupied:
                return f, s
    return top + 1, 0


def _compact_floors() -> None:
    team = [r for r in rooms() if r["kind"] == "team"]
    for new, old in enumerate(sorted({r["floor"] for r in team})):
        if new != old:
            db.run("update rooms set floor=? where kind='team' and floor=?", (new, old))


def _chain_up(eid: str | None) -> list[str]:
    seen = []
    managers = {e["id"]: e["reports_to"] for e in db.rows("select id, reports_to from employees")}
    while eid and eid not in seen:
        seen.append(eid)
        eid = managers.get(eid)
    return seen


def _check_model(ref: str) -> str:
    ref = (ref or "").strip()
    if ref and not MODEL_REF.match(ref):
        raise OrgError("Model must look like provider:model")
    return ref


# ---------------------------------------------------------------- rooms
def save_room(payload: dict, room_id: str | None = None) -> str:
    r = payload.get("room") or {}
    members = [m for m in (payload.get("members") or []) if m]
    existing = db.one("select * from rooms where id=?", (room_id,)) if room_id else None
    if room_id and not existing:
        raise OrgError("Room not found")
    is_exec = bool(existing and existing["kind"] == "exec")

    name = (r.get("name") or "").strip()[:40]
    if not name:
        raise OrgError("Give the room a name")
    division = "executive" if is_exec else r.get("division")
    if division not in DIVISION_IDS or (division == "executive" and not is_exec):
        raise OrgError("Pick a division")
    desks = 1 if is_exec else int(r.get("desks", 1))
    per = 1 if is_exec else int(r.get("per_desk", 1))
    if not (1 <= desks <= MAX_DESKS and 1 <= per <= MAX_PER_DESK):
        raise OrgError(f"Desks must be 1–{MAX_DESKS} and people per desk 1–{MAX_PER_DESK}")
    if not (1 <= len(members) <= desks * per):
        raise OrgError("A room needs at least one person and no more people than seats")
    accent = r.get("accent") if HEX.match(r.get("accent") or "") else "#8B7CFF"
    color_mode = r.get("color_mode") if r.get("color_mode") in ("individual", "uniform", "random") else "individual"
    uniform = r.get("uniform_color") if HEX.match(r.get("uniform_color") or "") else None
    composition = "same" if r.get("composition") == "same" else "mixed"
    theme = r.get("theme") if r.get("theme") in THEMES else "modern"
    room_key = _check_key(r.get("api_key_id"))

    if not is_exec:
        # every team room = exactly one team lead + at least one team member; rank follows the lead pick
        if len(members) < 2:
            raise OrgError("Every room needs a team lead and at least one team member (2+ people)")
        if len([m for m in members if m.get("is_lead")]) > 1:
            raise OrgError("Only one team lead per room")
        if not any(m.get("is_lead") for m in members):
            members[0]["is_lead"] = True
        for m in members:
            m["seniority"] = LEAD if m.get("is_lead") else MEMBER
    seats = set()
    for m in members:
        m["name"] = (m.get("name") or "").strip()[:40]
        if not m["name"]:
            raise OrgError("Every person needs a name")
        if is_exec:
            m["specialty"], m["seniority"] = "general_manager", 0
        elif m.get("specialty") not in SPECIALTIES or m["specialty"] == "general_manager":
            raise OrgError(f"Pick a specialty for {m['name']}")
        if not HEX.match(m.get("color") or ""):
            m["color"] = random.choice(PALETTE)
        m["model"] = _check_model(m.get("model", ""))
        m["api_key_id"] = _check_key(m.get("api_key_id"))
        d, s = int(m.get("desk", 0)), int(m.get("seat", 0))
        if not (0 <= d < desks and 0 <= s < per) or (d, s) in seats:
            raise OrgError("Seat layout doesn't match the desks")
        seats.add((d, s))

    if is_exec:
        members[0]["id"] = "gm"
    old_members = {e["id"]: e for e in db.rows("select * from employees where room_id=?", (room_id,))} if room_id else {}
    member_ids = {m.get("id") for m in members if m.get("id") in old_members}

    boss = None if is_exec else (payload.get("lead_reports_to") or "gm")
    if boss is not None:
        if boss in member_ids or not db.one("select id from employees where id=?", (boss,)):
            raise OrgError("Choose who this team reports to")
        if set(_chain_up(boss)) & member_ids:
            raise OrgError("That reporting line would create a loop")

    if existing:
        floor, slot = existing["floor"], existing["slot"]
        place = r.get("floor", "keep")
        if not is_exec and place != "keep" and (place != floor or r.get("slot", slot) != slot):
            floor, slot = _assign_position(place, r.get("slot"), room_id)
        db.run("update rooms set name=?, division=?, floor=?, slot=?, accent=?, desks=?, per_desk=?, color_mode=?, "
               "uniform_color=?, composition=?, theme=?, api_key_id=? where id=?",
               (name, division, floor, slot, accent, desks, per, color_mode, uniform, composition, theme, room_key, room_id))
    else:
        floor, slot = _assign_position(r.get("floor", "auto"), r.get("slot"), None)
        room_id = _new_id("r")
        _insert_room({"id": room_id, "name": name, "division": division, "floor": floor, "slot": slot, "accent": accent,
                      "desks": desks, "per_desk": per, "color_mode": color_mode, "uniform_color": uniform,
                      "composition": composition, "theme": theme, "api_key_id": room_key})

    for gone_id, gone in old_members.items():
        if gone_id not in member_ids:
            db.run("update employees set reports_to=? where reports_to=?", (gone["reports_to"] or "gm", gone_id))
            db.run("delete from employees where id=?", (gone_id,))

    for m in members:
        m["id"] = m["id"] if m.get("id") in old_members else ("gm" if is_exec else _new_id("e"))
    lead_id = next((m["id"] for m in members if m.get("is_lead")), None)
    now = time.time()
    for k, m in enumerate(members):
        reports = boss if (m["id"] == lead_id or not lead_id) else lead_id
        old = old_members.get(m["id"])
        if old:
            look = json.loads(old["look"])
            if old["specialty"] != m["specialty"]:
                look["acc"] = random_look(m["specialty"])["acc"]
            db.run("update employees set name=?, specialty=?, seniority=?, reports_to=?, color=?, desk=?, seat=?, "
                   "is_lead=?, instructions=?, look=?, model=?, api_key_id=? where id=?",
                   (m["name"], m["specialty"], int(m["seniority"]), None if is_exec else reports, m["color"],
                    int(m["desk"]), int(m["seat"]), 1 if m["id"] == lead_id or is_exec else 0,
                    (m.get("instructions") or "")[:2000], json.dumps(look), m["model"], m["api_key_id"], m["id"]))
        else:
            _insert_employee({"id": m["id"], "room_id": room_id, "name": m["name"], "specialty": m["specialty"],
                              "seniority": int(m["seniority"]), "reports_to": reports, "color": m["color"],
                              "desk": int(m["desk"]), "seat": int(m["seat"]), "is_lead": m["id"] == lead_id,
                              "instructions": (m.get("instructions") or "")[:2000], "look": random_look(m["specialty"]),
                              "created": now + k * 0.001, "model": m["model"], "api_key_id": m["api_key_id"]})
    _compact_floors()
    return room_id


def delete_room(room_id: str) -> None:
    room = db.one("select * from rooms where id=?", (room_id,))
    if not room:
        raise OrgError("Room not found")
    if room["kind"] == "exec":
        raise OrgError("The executive suite can't be removed")
    people = db.rows("select * from employees where room_id=?", (room_id,))
    ids = {p["id"] for p in people}
    lead = next((p for p in people if p["is_lead"]), people[0] if people else None)
    heir = (lead["reports_to"] if lead else None) or "gm"
    if heir in ids:
        heir = "gm"
    for pid in ids:
        db.run("update employees set reports_to=? where reports_to=? and room_id<>?", (heir, pid, room_id))
    db.run("delete from employees where room_id=?", (room_id,))
    db.run("delete from rooms where id=?", (room_id,))
    _compact_floors()


# ---------------------------------------------------------------- one employee
def _free_seat(room: dict, expand: bool = True) -> tuple[int, int]:
    taken = {(e["desk"], e["seat"]) for e in db.rows("select desk, seat from employees where room_id=?", (room["id"],))}
    free = _vacant(room, taken)
    if free:
        return free[0]
    if not expand or room["kind"] == "exec":
        raise OrgError(f"{room['name']} has no free seat")
    if room["per_desk"] < MAX_PER_DESK:
        db.run("update rooms set per_desk=per_desk+1 where id=?", (room["id"],))
        return 0, room["per_desk"]
    if room["desks"] < MAX_DESKS:
        db.run("update rooms set desks=desks+1 where id=?", (room["id"],))
        return room["desks"], 0
    raise OrgError(f"{room['name']} is full (3 desks × 4 seats)")


def update_employee(eid: str, f: dict) -> None:
    e = db.one("select * from employees where id=?", (eid,))
    if not e:
        raise OrgError("Employee not found")
    sets: dict = {}
    if "name" in f:
        name = (f["name"] or "").strip()[:40]
        if not name:
            raise OrgError("Name can't be empty")
        sets["name"] = name
    if "specialty" in f and eid != "gm":
        if f["specialty"] not in SPECIALTIES or f["specialty"] == "general_manager":
            raise OrgError("Unknown specialty")
        sets["specialty"] = f["specialty"]
    # rank isn't edited directly: it follows who leads the room (change the lead in the room wizard)
    if "color" in f and HEX.match(f["color"] or ""):
        sets["color"] = f["color"]
    if "instructions" in f:
        sets["instructions"] = (f["instructions"] or "")[:2000]
    if "model" in f:
        sets["model"] = _check_model(f["model"])
    if "api_key_id" in f:
        sets["api_key_id"] = _check_key(f["api_key_id"])
    if f.get("room_id") and f["room_id"] != e["room_id"] and eid != "gm":
        target = db.one("select * from rooms where id=?", (f["room_id"],))
        if not target or target["kind"] == "exec":
            raise OrgError("Pick a team room to move to")
        _check_can_leave(e)
        desk, seat = _free_seat(target)
        _hand_over(e)
        lead = db.one("select id from employees where room_id=? and is_lead=1", (target["id"],))
        sets.update({"room_id": target["id"], "desk": desk, "seat": seat, "is_lead": 0, "seniority": MEMBER,
                     "reports_to": f.get("reports_to") or (lead["id"] if lead else "gm")})
    elif "reports_to" in f and eid != "gm":
        boss = f["reports_to"]
        if boss == eid or not db.one("select id from employees where id=?", (boss,)):
            raise OrgError("Pick a valid manager")
        if eid in _chain_up(boss):
            raise OrgError("That reporting line would create a loop")
        sets["reports_to"] = boss
    if sets:
        db.run(f"update employees set {', '.join(f'{k}=?' for k in sets)} where id=?", (*sets.values(), eid))


def fire_employee(eid: str) -> None:
    if eid == "gm":
        raise OrgError("The General Manager can't be removed")
    e = db.one("select * from employees where id=?", (eid,))
    if not e:
        raise OrgError("Employee not found")
    _check_can_leave(e)
    _hand_over(e)
    db.run("delete from employees where id=?", (eid,))


def set_rank(eid: str, rank_: str, successor: str | None = None) -> dict:
    """Promote someone to their room's team lead (the old lead becomes a member), or demote the lead
    (a successor from the same room takes over: the one given, else the longest-serving member)."""
    e = db.one("select * from employees where id=?", (eid,))
    if not e or eid == "gm":
        raise OrgError("Pick a team member")
    room_id = e["room_id"]
    if rank_ == "lead":
        new_id = eid
    elif rank_ == "member":
        if not e["is_lead"]:
            return {"lead": None}
        cand = db.one("select id from employees where id=? and room_id=?", (successor, room_id)) if successor else \
            db.one("select id from employees where room_id=? and id<>? order by created limit 1", (room_id, eid))
        if not cand or cand["id"] == eid:
            raise OrgError("Pick who becomes the team lead")
        new_id = cand["id"]
    else:
        raise OrgError("Rank must be lead or member")
    old = db.one("select * from employees where room_id=? and is_lead=1", (room_id,))
    if old and old["id"] == new_id:
        return {"lead": new_id}
    boss = (old["reports_to"] if old else None) or e["reports_to"] or "gm"
    if boss == new_id:
        boss = "gm"
    # the new lead takes over the old lead's place in the chain, and everyone who reported to the old lead
    if old:
        db.run("update employees set reports_to=? where reports_to=? and id<>?", (new_id, old["id"], new_id))
        db.run("update employees set is_lead=0, seniority=?, reports_to=? where id=?", (MEMBER, new_id, old["id"]))
    db.run("update employees set reports_to=? where room_id=? and id<>? and is_lead=0", (new_id, room_id, new_id))
    db.run("update employees set is_lead=1, seniority=?, reports_to=? where id=?", (LEAD, boss, new_id))
    return {"lead": new_id, "previous": old["id"] if old else None}


def _check_can_leave(e: dict) -> None:
    left = db.one("select count(*) n from employees where room_id=? and id<>?", (e["room_id"], e["id"]))["n"]
    if left < 2:
        raise OrgError(f"{e['name']} can't leave: a room needs a team lead and at least one team member. "
                       "Add someone first, or delete the room.")


def _hand_over(e: dict) -> None:
    """Before someone leaves a room: if they led it, the longest-serving member becomes the new team lead;
    anyone reporting to them now reports to the new lead (or to their own manager)."""
    heir = None
    if e["is_lead"]:
        heir = db.one("select * from employees where room_id=? and id<>? order by created limit 1", (e["room_id"], e["id"]))
        if heir:
            db.run("update employees set is_lead=1, seniority=?, reports_to=? where id=?", (LEAD, e["reports_to"] or "gm", heir["id"]))
    db.run("update employees set reports_to=? where reports_to=? and id<>?",
           (heir["id"] if heir else (e["reports_to"] or "gm"), e["id"], heir["id"] if heir else ""))


def ensure_teams() -> list[str]:
    """Bring every team room up to the rule: one team lead (rank 2) + team members (rank 4), at least 2 people.
    Rooms with one person get a new team member with the same specialty. Returns the names of anyone added."""
    added = []
    for room in db.rows("select * from rooms where kind<>'exec'"):
        ppl = db.rows("select * from employees where room_id=? order by is_lead desc, seniority, created", (room["id"],))
        if not ppl:
            continue
        lead = ppl[0]
        if not lead["is_lead"]:
            db.run("update employees set is_lead=0 where room_id=?", (room["id"],))
            db.run("update employees set is_lead=1 where id=?", (lead["id"],))
        db.run("update employees set seniority=? where id=?", (LEAD, lead["id"]))
        for p in ppl[1:]:
            db.run("update employees set seniority=?, is_lead=0 where id=?", (MEMBER, p["id"]))
        if len(ppl) < 2:
            res = hire({"room_id": room["id"], "people": [{"specialty": lead["specialty"], "seniority": MEMBER}]})
            added += [db.one("select name from employees where id=?", (i,))["name"] for i in res["employees"]]
    return added


def hire(spec: dict) -> dict:
    """Used by approved GM hiring requests. Either a new room or new people in an existing room."""
    people = spec.get("people") or []
    if not people:
        raise OrgError("No one to hire")
    used = {e["name"] for e in db.rows("select name from employees")}
    from .catalog import FIRST_NAMES, LAST_NAMES
    def name_for(p):
        if p.get("name"):
            return p["name"]
        for _ in range(50):
            n = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
            if n not in used:
                used.add(n)
                return n
        return f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
    if spec.get("room_id"):
        room = db.one("select * from rooms where id=?", (spec["room_id"],))
        if not room:
            raise OrgError("Room not found")
        lead = db.one("select id from employees where room_id=? and is_lead=1", (room["id"],))
        new_ids = []
        for p in people:
            desk, seat = _free_seat(room)
            room = db.one("select * from rooms where id=?", (room["id"],))
            eid = _new_id("e")
            _insert_employee({"id": eid, "room_id": room["id"], "name": name_for(p), "specialty": p["specialty"],
                              "seniority": MEMBER, "reports_to": lead["id"] if lead else spec.get("reports_to", "gm"),
                              "color": random.choice(PALETTE), "desk": desk, "seat": seat, "look": random_look(p["specialty"]),
                              "model": p.get("model", "")})
            new_ids.append(eid)
        return {"room_id": room["id"], "employees": new_ids}
    if len(people) == 1:  # a new room needs a team lead plus at least one team member
        people = [people[0], {"specialty": people[0]["specialty"]}]
    n = len(people)
    per = min(MAX_PER_DESK, max(1, n if n <= 4 else (n + 1) // 2))
    desks = min(MAX_DESKS, (n + per - 1) // per)
    members = []
    for k, p in enumerate(people[: desks * per]):
        members.append({"name": name_for(p), "specialty": p["specialty"], "seniority": LEAD if k == 0 else rank(p.get("seniority", MEMBER)),
                        "color": random.choice(PALETTE), "desk": k // per, "seat": k % per, "is_lead": k == 0,
                        "model": p.get("model", "")})
    division = spec.get("division") or SPECIALTIES[people[0]["specialty"]]["division"]
    div = next(d for d in DIVISIONS if d["id"] == division)
    rid = save_room({"room": {"name": spec.get("room_name") or div["name"]["en"], "division": division, "floor": "auto",
                              "accent": div["color"], "desks": desks, "per_desk": per, "composition": "mixed"},
                     "members": members, "lead_reports_to": spec.get("reports_to") or "gm"})
    return {"room_id": rid, "employees": [e["id"] for e in db.rows("select id from employees where room_id=?", (rid,))]}
