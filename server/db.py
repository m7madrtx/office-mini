"""SQLite storage for the virtual company: rooms, employees, tasks, documents, chat, mock inbox."""
import json
import sqlite3
import time
from contextlib import contextmanager

from .config import DATA

DB_PATH = DATA / "company.db"

SCHEMA = """
create table if not exists settings(key text primary key, value text);
create table if not exists rooms(
  id text primary key, name text, division text, kind text default 'team', floor integer, slot integer,
  accent text, desks integer, per_desk integer, color_mode text, uniform_color text, composition text,
  created real);
create table if not exists employees(
  id text primary key, room_id text, name text, specialty text, seniority integer, reports_to text,
  color text, desk integer, seat integer, is_lead integer default 0, instructions text default '',
  look text, created real);
create table if not exists tasks(
  id integer primary key, ts real, updated real, thread text, title text, detail text,
  assigner text, assignee text, status text, result text);
create table if not exists documents(
  id integer primary key, ts real, author text, title text, content text, task_id integer);
create table if not exists messages(
  id integer primary key, ts real, thread text, kind text, agent text, content text, meta text);
create table if not exists emails(
  id integer primary key, ts real, sender text, subject text, body text,
  unread integer default 1, archived integer default 0, draft text);
create table if not exists knowledge(
  id integer primary key, ts real, scope_type text, scope_id text, name text, mime text, size integer,
  path text, text text);
create table if not exists activity(
  id integer primary key, ts real, employee text, kind text, text text, meta text);
create index if not exists activity_emp on activity(employee, id);
create table if not exists approvals(
  id integer primary key, ts real, employee text, kind text, title text, detail text, payload text,
  status text default 'pending', decided real, note text, thread text);
create table if not exists notifications(
  id integer primary key, ts real, kind text, employee text, title text, body text, ref text, read integer default 0);
create table if not exists workflows(
  id integer primary key, name text, description text default '', icon text default 'zap', steps text, trigger text,
  enabled integer default 1, input_hint text default '', default_input text default '', budget integer default 0,
  min_quota integer default 10, save_output integer default 1, template text default '', created_by text default 'owner',
  created real, updated real, next_run real);
create table if not exists workflow_runs(
  id integer primary key, workflow_id integer, name text, ts real, finished real, status text, trigger text,
  input text default '', step integer default 0, steps text, requests integer default 0, budget integer default 0,
  error text default '', doc_id integer);
create index if not exists runs_wf on workflow_runs(workflow_id, id);
create table if not exists api_keys(
  id integer primary key, provider text, label text, secret text, created real, state text default '',
  detail text default '', checked real, uses integer default 0, uses_day integer default 0, day text default '',
  last_used real);
"""

MIGRATIONS = [
    "alter table employees add column model text default ''",
    "alter table rooms add column theme text default 'modern'",
    # two ranks only: heads, leads and room leads become Team leads (2); everyone else a Team member (4)
    "update employees set seniority=2 where seniority>0 and (seniority<=2 or is_lead=1)",
    "update employees set seniority=4 where seniority>2 and is_lead=0",
    # API keys can be assigned to one employee or a whole room (otherwise the company key in .env is used)
    "alter table employees add column api_key_id integer",
    "alter table rooms add column api_key_id integer",
]

SEED_EMAILS = [
    ("Stripe <billing@stripe.example>", "Your invoice for November is available",
     "Hi,\n\nYour Stripe invoice for November is ready: $412.30 (payment processing + Billing). "
     "It will be charged automatically on the 15th.\n\nStripe Billing", 2),
    ("Ahmad (Acme Logistics) <ahmad@acme-logistics.example>", "Interested in an enterprise plan",
     "Hello,\n\nWe're a logistics company with ~120 dispatchers. We like your product but need SSO, an audit log and "
     "a data-residency option in the GCC. Could you share enterprise pricing and a demo slot next week?\n\nThanks,\nAhmad", 5),
    ("AWS Notifications <no-reply@aws.example>", "Action required: RDS certificate rotation",
     "Your Amazon RDS instances in eu-central-1 use a certificate authority that expires on 15 December. "
     "Rotate to rds-ca-rsa2048-g1 before then to avoid connection failures.", 9),
    ("Sara <sara.k@example.com>", "Weekend plans?",
     "Hey! Are we still on for Friday? Also, is your new app ready for me to test yet? :)", 20),
    ("Product Hunt <hello@producthunt.example>", "Your launch is scheduled for Tuesday",
     "Congrats! Your launch is scheduled for Tuesday 00:01 PST. Prepare your gallery images, a first comment and "
     "make sure your team is around to answer questions.", 26),
    ("College Registrar <registrar@college.example>", "Reminder: course registration closes Thursday",
     "Dear student,\n\nRegistration for the spring semester closes this Thursday at 23:59. "
     "Please make sure your advisor has approved your plan.\n\nRegistrar's Office", 31),
    ("GitHub <noreply@github.example>", "[security] Dependabot alert: critical vulnerability in jsonwebtoken",
     "A critical severity vulnerability was found in jsonwebtoken < 9.0.0 used by your repository saas-api. "
     "Upgrade to 9.0.2 or later.", 40),
    ("Lina (freelance designer) <lina.design@example.com>", "Logo concepts v2",
     "Hi! Attached are three refined logo directions. I'd love your feedback by Wednesday so I can finalise the "
     "brand kit. My invoice for the first milestone (350 KWD) is attached too.", 55),
]


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def rows(sql: str, args: tuple = ()) -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    with conn() as c:
        r = c.execute(sql, args).fetchone()
        return dict(r) if r else None


def run(sql: str, args: tuple = ()) -> int:
    with conn() as c:
        return c.execute(sql, args).lastrowid


def get_setting(key: str, default=None):
    r = one("select value from settings where key=?", (key,))
    return json.loads(r["value"]) if r else default


def set_setting(key: str, value) -> None:
    run("insert into settings(key, value) values(?,?) on conflict(key) do update set value=excluded.value",
        (key, json.dumps(value)))


def add_message(thread: str, kind: str, agent: str, content: str, meta: dict | None = None) -> dict:
    ts = time.time()
    mid = run("insert into messages(ts, thread, kind, agent, content, meta) values(?,?,?,?,?,?)",
              (ts, thread, kind, agent, content, json.dumps(meta or {}, ensure_ascii=False)))
    return {"id": mid, "ts": ts, "thread": thread, "kind": kind, "agent": agent, "content": content, "meta": meta or {}}


def thread_messages(thread: str, limit: int = 80) -> list[dict]:
    out = rows("select * from messages where thread=? order by id desc limit ?", (thread, limit))
    for m in out:
        m["meta"] = json.loads(m["meta"] or "{}")
    return list(reversed(out))


def init() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        for sql in MIGRATIONS:
            try:
                c.execute(sql)
            except sqlite3.OperationalError:
                pass  # already applied
        if c.execute("select count(*) from emails").fetchone()[0] == 0:
            now = time.time()
            for sender, subject, body, hours in SEED_EMAILS:
                c.execute("insert into emails(ts, sender, subject, body) values(?,?,?,?)",
                          (now - hours * 3600, sender, subject, body))
