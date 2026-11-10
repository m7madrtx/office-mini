# Office Mini · المكتب الصغير

A virtual IT/SaaS company that runs on AI agents. It's shown as a 3D building where each room is a team and each person is an agent with a role, a seniority level, a manager, an AI model and its own knowledge files.

You can talk to anyone directly, or ask the **General Manager**. The GM routes work down the chain of command, and reports flow back up. When nobody in the company has the right skills, the GM proposes a hire for your approval.

No Node.js is needed, only Python. Developers: see [HANDOVER.md](HANDOVER.md) for the architecture, rules, API and next steps.

## Run it

- **Start:** double-click **`run.bat`**. The first run sets up `.venv`, which takes about a minute. The console shows the address for this PC and for your phone.
- **Stop:** double-click **`stop.bat`**, or close the console window.
- **Phone:** with `HOST=0.0.0.0` in `.env` (the default), open the phone address on the same Wi-Fi.

## What you can do

| Area | What's there |
|---|---|
| **Building** | 3D floors of team rooms with the executive suite on top. Drag to orbit a full 360°: the walls facing you fade so every room stays visible. Use ⟲ ⟳ ◎ to rotate or reset. Tap anyone, or a room label, for a card. |
| **Status halos** | The ring above each head shows status by colour: pink while working (it pulses and spins), green when available, blue when just finished, orange on errors. |
| **Live progress** | Tap someone who's working to see the current task, the elapsed time and their latest steps as they happen. |
| **People panel** (☰, top-left) | Everyone in the company. Group by division, room, status or manager; search; filter to active people only. |
| **Add room** | A 5-step wizard: Team → Layout → Roles → People → Review, previewed live in 3D. Editing reopens the same steps. |
| **Room settings** | Name, division, floor, 8 themes (Modern, Neon, Gaming, Gothic, Zen, Retro, Industrial, Space), accent colour and room knowledge. |
| **Desks and roles** | 1–3 desks × 1–4 people. Everyone can share one specialty, or roles can be mixed (30 IT/SaaS specialties). Every room has exactly one **Team lead** (directs and delegates, can propose hires) and at least one **Team member** (does the work), so a room always has 2+ people. Ranks follow the lead you pick; if a lead leaves, the longest-serving member takes over. |
| **Per person** | Name and colour (individual, same for all, or random), a role description, an **AI model** (suggested from the role's needs), and **knowledge files**. You can also move someone to another room or remove them. |
| **Chat** | Every person has their own thread. Type **@** to tag a person, room or division, and it gets routed to them. Hand-offs, colleague questions, reports and your approvals appear inline. You can attach photos. |
| **Org chart** | The live chain of command. On phones it shows as an indented outline. |
| **Work** | A task board (in progress / done / blocked), documents your team saved, the sample inbox, and a **live activity log** for the whole company. |
| **Workflows** (⚡ tab) | Chain people into a process: each step goes to a person, a room (its lead), a division (its head) or a role (whoever holds it), and receives the previous step's result. Steps can wait for your OK. Run them by hand, daily, weekly or every few hours. Each run has its own request budget, and scheduled runs skip themselves when the free daily allowance is low. Watch runs live, then read each step's result; the final result is saved as a document. Start from 6 templates, or ask the GM ("every Sunday, have Layla brief me on competitors") and it sets the routine up. |
| **Notifications** (bell) | Approval requests for hires, sending email, spending, publishing and more. Approve or decline with a note. Group by employee, division, room or type. |
| **Settings** (sliders) | AI provider health (colour-coded), default and vision models, auto-hire, manager review, company and division knowledge, language (EN/عربي) and appearance (Dark / Light / Auto). |
| **API alerts** | Banners appear when a key is expired or invalid, out of credit (red), or rate-limited or running low (amber). |

## AI providers

Each provider is set up once for the whole company, in `.env`. Each employee then picks a model from any connected provider; anyone without a choice uses the company default.

**Per-employee and per-room keys:** in **Settings → API keys** you can add extra keys (on this PC only, since the phone connection isn't encrypted). Assign one to a whole room (room wizard → Team) or to one person (room wizard → People → Details). A call uses the person's key, then their room's key, then the company key, and only when the key matches the provider of the model being called. Each key shows its health, today's and total requests, and who uses it; a failing key raises its own alert. A second OpenRouter key gives that person or room their own 50 free requests a day.

Supported providers: **OpenRouter**, **Anthropic (Claude)**, **OpenAI (ChatGPT)**, **Google Gemini**, **Qwen (DashScope)**, **DeepSeek**, **Mistral**, **Groq**, **xAI (Grok)** and local **Ollama**.

To connect one, add its key to `.env` and restart. The model picker then lists that provider's models with their capabilities: tools, vision, OCR, audio, coding, reasoning, multilingual, long context and free.

**Free tier:** OpenRouter's free key allows 50 requests a day.
- A simple message costs about 2 requests.
- A message that hands work down the chain costs about 3–5.
- Each message is capped at 10.

## Files

```
server/  app.py (API) · agents.py (runtime, tools, approvals) · org.py (rooms, people, hiring) · workflows.py (routines, scheduler) · keys.py (per-employee/room API keys)
         providers.py (model adapter, capabilities, health) · kb.py (knowledge) · catalog.py (roles) · db.py
web/     index.html · css/app.css · js/ (scene, wizard, chat, workflows, panels, settings, models, kbui, mention, views…)
data/    created at runtime: company.db and kb/ (uploaded files)
archive/ the earlier 3D house-tour demo (not used by the app)
```

To start from scratch, stop the app and delete `data/`.
