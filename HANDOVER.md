# Office Mini — project handover

Office Mini (المكتب الصغير) is a virtual IT/SaaS company run by AI agents. It's shown as a 3D building: each room is a team, and each person is an agent with a role, a rank, a manager, an AI model, an optional API key of their own, and knowledge files. You talk to anyone directly, or ask the General Manager (GM), who routes work down the chain of command.

This document is for whoever picks the project up next: how to run it, how it's built, the rules the code relies on, and what's left to do. The user-facing tour is in [README.md](README.md).

---

## 1. Quick start

**Requirements:** Windows 10/11 and Python 3.11+ (developed on 3.12). Node.js is not needed. The 3D library (Three.js) and fonts load from public CDNs, so the browser needs internet access.

1. Double-click `run.bat`.
   - **First run:** it copies `.env.example` to `.env` and opens it in Notepad. Paste an OpenRouter key into `OPENROUTER_API_KEY` (free at https://openrouter.ai/settings/keys), save, and run `run.bat` again.
   - It then creates `.venv`, installs `requirements.txt` (about a minute), starts the server and opens http://127.0.0.1:8765.
2. **Phone:** with `HOST=0.0.0.0` (the default), open the "On your phone" address the console prints, on the same Wi-Fi.
3. **Stop:** double-click `stop.bat`, or close the console window.

**Manual start (any OS):**

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m server.app
```

**Reset everything:** stop the app and delete the `data/` folder. On the next start it re-seeds a company with the GM, the Email Manager and one team member.

---

## 2. Repository layout

```
.env.example        settings template (copy to .env; never commit .env)
run.bat / stop.bat  Windows start/stop (stop.ps1 kills only this app's server process)
requirements.txt    fastapi, uvicorn, httpx, pypdf
server/
  app.py            FastAPI app: REST API, server-sent events (/api/events), static web files
  config.py         reads .env (DEFAULT_MODEL, VISION_MODEL, MODEL_FALLBACKS, HOST, PORT)
  db.py             SQLite schema + migrations + tiny helpers (rows/one/run, settings, messages)
  catalog.py        divisions, ranks, 30 IT/SaaS specialties (EN/AR titles, expertise, tool groups, capability needs)
  org.py            rooms, people, placement on floors, reporting lines, hiring, rank changes, team rules
  agents.py         the agent runtime: prompts, tools, delegation, approvals, event bus, activity log
  providers.py      model adapter for 10 providers, model lists + capabilities, suggestions, key health checks
  keys.py           API keys added in Settings, per-employee/per-room assignment, usage + health
  kb.py             knowledge files: text extraction (PDF, Word, text, code) and keyword search
  workflows.py      workflows (multi-step routines), the scheduler, templates, the GM's create_workflow tool
  stop.ps1          used by stop.bat
web/
  index.html        app shell (import map for Three.js 0.170.0 from jsDelivr)
  css/app.css       the whole design system: tokens, components, light mode, responsive rules
  js/main.js        boot, top bar, view switching, employee/room cards, light/dark, company logo
  js/store.js       app state, api() helper, live event stream (EventSource)
  js/scene.js       the 3D building (Three.js): rooms, people, themes, halos, camera, cutaway walls
  js/wizard.js      room setup/edit: Team · Layout · Roles · People · Review tabs
  js/chat.js        per-person chat with @mentions, photos, hand-off/report/approval events
  js/workflows.js   Workflows page, workflow editor, live run viewer
  js/panels.js      people panel, live progress, activity log, notifications + approvals
  js/settings.js    Settings page: provider health, API keys, company + logo, models, behaviour, knowledge
  js/models.js      model picker (capabilities, suggestions, per-provider tabs)
  js/keys.js        API key pickers for people and rooms
  js/views.js       org chart and Work page (tasks, documents, inbox, activity)
  js/kbui.js, mention.js, i18n.js (EN/AR strings), icons.js, ui.js (helpers: avatar, toast, confirmBox, md)
data/               created at runtime (ignored by git): company.db, kb/ uploads
archive/house-tour/ the earlier 3D house-tour prototype (not used by the app; safe to delete)
PROJECT_SPEC.md     analysis of the original demo video (historical; superseded by this file)
```

---

## 3. How it works

### 3.1 The organisation
- **Rooms and floors.** There are two room slots per floor, and the Executive Suite (the GM only) always sits on top of the highest team floor. Empty slots show a framed "Add room" placeholder. Placement and floor compaction live in `org.py` (`_assign_position`, `_compact_floors`), and `scene.js` `layout()` mirrors them for previews.
- **Ranks.** Every team room has exactly **one Team lead and at least one Team member** (so 2+ people).
  - **Storage:** the rank is kept as `seniority` (`0` = GM, `2` = lead, `4` = member) and always follows `is_lead`.
  - **Where it's enforced:** `save_room`, `set_rank`, `_check_can_leave` (blocks leaving a 2-person room) and `_hand_over` (a departing lead's longest-serving member takes over).
  - **On every start:** `ensure_teams()` repairs any room that breaks the rule, adding a member with the lead's specialty if needed.
- **Reporting lines.** Members report to their room lead, and the lead reports to whoever the wizard says (default: the GM). Loops are rejected (`_chain_up`).

### 3.2 Agents (`server/agents.py`)
- **One message from the owner is one *turn*.** The owner's message runs the addressed employee (`run_employee`) in a tool-calling loop. It allows up to `MAX_ROUNDS` model calls per person, and `turn.cap` requests in total across everyone involved: `MAX_REQUESTS` = 10 for chat, while workflow runs set their own cap.
- **Tools:**
  - **Everyone:** documents, `my_tasks`, `search_knowledge`, `request_approval`.
  - **Email Manager:** email tools on a mock inbox (`emails` table).
  - **GM:** `org_overview`, `hire`, `create_workflow`.
  - **Team leads and the GM:** can propose hires.
  - **Hand-offs:** `delegate` (anyone below you) and `ask_colleague` (anyone else). Each runs the other employee as a nested run (`_hand_to`), records a task, and posts hand-off/report messages.
- **Approvals.** Approvals (hire, send email, spend, workflow gates and more) go to the `approvals` table, surface in Notifications, and are executed in `decide()`.
- **Live UI.** Everything happens through the event bus `broadcast()`, which feeds `/api/events` (SSE): status, activity, hand-off, report, message, approvals, workflow, keys and org events. `log()` writes the per-person activity log.
- **Language.** Replies follow the owner's language (Arabic is detected from the script).

### 3.3 Models, providers and keys
- **Model references** look like `provider:model`, e.g. `openrouter:google/gemma-4-31b-it:free`. `providers.complete()` speaks the OpenAI chat format to every provider and translates to and from Anthropic's Messages API.
- **Which model a person uses:** their own `employee.model`, or else the company default from Settings or `.env`. If they're sent a photo and their model can't see images, the call switches to `VISION_MODEL`.
- **Which key a call uses** (`keys.resolve`): the employee's key → their room's key → the company key in `.env`. A key only applies to models of its own provider.
  - Keys added in Settings are stored in `data/company.db` and never returned to the browser.
  - Adding or deleting keys is only allowed from `127.0.0.1`, because the phone connection is plain HTTP.
- **Health and alerts.** `providers.probe()` checks a key without spending a request; for OpenRouter it uses `/key`, which also reports the free daily quota. Failures are classified (expired, invalid, depleted, rate-limited) and shown as colour-coded alerts.

### 3.4 Workflows (`server/workflows.py`)
- **What a workflow is:** ordered steps, each sent to a person (`emp:`), a room's lead (`room:`), a division head (`div:`) or a role holder (`role:`). If nobody holds the role, the GM routes it. Each step receives the previous step's output, and `{input}` in a step's instructions is replaced by the run's brief.
- **Gates.** A step with `gate` waits for an approval. Declining stops the run.
- **Triggers** can be manual, daily, weekly or every N hours. `scheduler_loop()` checks every 20 seconds.
  - **Missed runs:** runs missed while the app was off are not replayed, and runs that were in flight are marked "interrupted" on start-up.
  - **Low quota:** scheduled runs skip themselves when the free daily quota is below the workflow's cushion.
- **Output.** A finished run can save its combined output as a document. Six templates ship in `TEMPLATES`.

### 3.5 Frontend conventions
- **No build step:** plain ES modules, no bundler and no framework. Keep it that way unless there's a strong reason.
- **Strings:** all UI text goes in `i18n.js` (`en` and `ar`, Gulf Arabic). RTL is handled by `dir="rtl"`; use logical CSS properties (`inset-inline-start` and so on).
- **Theming:** colours are CSS variables in `:root`, with light mode under `:root[data-mode="light"]`. Bright accent colours are darkened with `color-mix` on light backgrounds.
- **Confirmations:** never use `confirm()` or `alert()`; embedded browsers block them silently. Use `confirmBox()` from `ui.js`.
- **Toasts:** use `toast()`. It keeps at most 2 on screen and merges duplicates.
- **Icons:** icons are block elements by default; inside running text, wrap them in `.help`, `p` or `.doc` so they stay on the line.
- **Avatars:** `avatar()` picks readable initials colour automatically (`inkFor`).
- **Testing:** in a hidden or background browser tab, animation frames are throttled. Call `window.officeScene.tick(n)` to advance the 3D scene before reading room labels.

### 3.6 Data model (SQLite, `data/company.db`)
| Table | What it holds |
|---|---|
| `settings` | key → JSON value (company name, default models, switches, logo + `logo_v`) |
| `rooms` | name, division, floor/slot, desks × seats, theme, accent, colour mode, `api_key_id` |
| `employees` | room, name, specialty, seniority (0/2/4), `is_lead`, `reports_to`, colour, look, model, `api_key_id`, role notes |
| `tasks`, `documents`, `messages` | work records; chat threads are keyed by employee id, workflow runs by `wf:<run id>` |
| `emails` | the mock inbox (8 seeded SaaS-style emails) |
| `knowledge` | uploaded files + extracted text, scoped to employee / room / division / company |
| `activity`, `notifications`, `approvals` | live log, notification feed, approval requests and decisions |
| `workflows`, `workflow_runs` | definitions (steps + trigger as JSON) and run history |
| `api_keys` | keys added in Settings: provider, label, secret, health, usage counters |

Schema changes go in `db.MIGRATIONS` (each statement is tried once per start; failures for already-applied changes are ignored).

### 3.7 API (all under `/api`)
| Area | Endpoints |
|---|---|
| Org | `GET catalog`, `GET org`, `POST/PUT/DELETE rooms[/{id}]`, `PATCH/DELETE employees/{id}`, `POST employees/{id}/rank` |
| Settings | `PATCH settings`, `GET/PUT/DELETE logo` |
| Models & keys | `GET providers`, `GET providers/health`, `GET models`, `GET models/suggest`, `GET models/info`, `GET/POST keys`, `PATCH/DELETE keys/{id}`, `POST keys/{id}/check` |
| Knowledge | `GET/POST kb`, `DELETE kb/{id}` |
| Chat & work | `GET/DELETE messages`, `POST chat`, `GET tasks`, `GET/DELETE documents[/{id}]`, `GET emails`, `GET quota` |
| Oversight | `GET activity`, `GET approvals`, `POST approvals/{id}`, `GET notifications`, `POST notifications/read` |
| Workflows | `GET/POST workflows`, `PUT/PATCH/DELETE workflows/{id}`, `POST workflows/{id}/run`, `GET runs`, `GET runs/{id}`, `POST runs/{id}/cancel` |
| Live | `GET events` (server-sent events) |

---

## 4. Configuration (`.env`)
See `.env.example`.
- **Keys:** add a provider key and that provider appears in the model picker.
- **Defaults:** `DEFAULT_MODEL` and `VISION_MODEL` are only defaults; Settings in the app overrides them.
- **Network:** `HOST=127.0.0.1` keeps the app on this PC only.

**Free-tier budgeting.** OpenRouter's free key allows 50 requests a day.
- **Chat:** a simple message costs about 2 requests; one that hands work down the chain costs about 3–5 (capped at 10).
- **Workflows:** each run has its own cap (default 4 per step, up to 40).

---

## 5. Security notes
- **No sign-in.** Anyone on the same Wi-Fi can use the app when `HOST=0.0.0.0`. Use `HOST=127.0.0.1` on untrusted networks. (A PIN or login is on the roadmap.)
- **Plain HTTP.** For this reason API keys can only be added or deleted from the PC itself.
- **Secrets stay local.** `.env` and `data/` (which holds keys added in Settings) are git-ignored. Check `git status` before every push.
- **Uploaded logos** are served with a strict Content-Security-Policy, so SVGs can't run scripts.
- **Model output** is rendered through a small escaping Markdown renderer (`ui.md`), never as raw HTML.

---

## 6. Known limitations
- **Email is a mock inbox.** Sending only marks a draft as sent; the real Gmail integration isn't built.
- **No real web access.** Agents have no web search or browsing, so research is based on the model's own knowledge plus your uploaded files.
- **Basic knowledge search.** It is keyword-based (no embeddings).
- **Voice input** is off on phones because browsers require HTTPS for the microphone.
- **Workflows don't resume.** One that was running when the app stopped is marked interrupted.
- **Imprecise cap info.** Capability detection for non-OpenRouter models is heuristic (name patterns).
- **Light testing coverage.** The Arabic UI and light mode were checked less thoroughly than English/dark.
- **No automated tests.** Changes were verified manually and through the API.

## 7. Suggested next steps
1. **PIN or login, plus HTTPS:** protects the app on Wi-Fi and enables voice input on phones.
2. **Per-team budgets:** daily request or spend caps per person or room, with charts (the key usage counters are a start).
3. **Real tools:** Gmail, Google Calendar and Drive, GitHub (engineers open pull requests), and web search for research.
4. **Agent memory:** each employee keeps notes between conversations.
5. **Meetings:** several agents debate one question, and the minutes are saved as a document.
6. **Performance reviews:** rate replies, and track quality and cost per person and model.
7. **Automated tests:** pytest for `org.py` rules, `workflows.next_after` and `keys.resolve`, plus a smoke test of the API.

---

## 8. Publishing to GitHub
From the project folder:

```bash
git init
git add .
git status
```

Check that `git status` does **not** list `.env`, `data/`, `.venv/`, `Demo.mp4` or `_video_review/`. If any appear, fix `.gitignore` before committing.

```bash
git commit -m "Office Mini: virtual AI company"
git branch -M main
git remote add origin https://github.com/<you>/office-mini.git
git push -u origin main
```

Your OpenRouter key appeared in earlier development chats. Consider generating a fresh key at https://openrouter.ai/settings/keys before or after publishing, and putting the new one in `.env`.
