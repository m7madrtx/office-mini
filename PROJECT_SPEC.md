# Office Mini — spec reverse-engineered from `Demo.mp4`

## What the demo actually is

A phone-first **"AI company" dashboard**. A team of AI agents is drawn as little voxel characters sitting at desks in a **3D isometric building cutaway**. You talk to the **General Manager**, who hands work to department agents. Each agent's desk shows whether it's busy, idle, failed or done, and links out to the real thing it manages (a sheet, Instagram, MakerWorld…).

The **Contractor** agent is the standout feature. It logs construction invoices into a "build" sheet and maintains a **walkable 3D tour of the user's house**, generated from the building plan ("you can give Claude the building plan and it does everything", 1:13).

The original was built with Claude: the 3D tour opens a `claude.ai/code/artifact/...` link (1:22). The pages are Claude artifacts viewed in the Claude iPhone app.

## Screen 1 — The office (0:05–0:45, 1:03–1:20)

**Header**
- Title `Tech3zoz Management` (we'll rename it), subtitle `المدير فوق · 6 إيجنتات · غرفة جاهزة للجاي` (*manager upstairs · 6 agents · a room ready for the next one*)
- Status legend: 🔴 `يشتغل` working · 🟢 `فاضي` idle · 🟠 `خطأ` error · 🔵 `خلصت` done
- `☀ نهاري` day/night toggle · yellow `تحديث` refresh button

**Building**: a real 3D scene (WebGL), dark navy with neon edge lines, low-poly/voxel characters. You can drag to rotate it and pinch to zoom. The status ring above a desk animates while that agent is working.

| Floor | Room | Visual cues |
|---|---|---|
| Top | General Manager `المدير العام` | Wide orange desk, 3 wall screens (line chart, bar list, grid), meeting table and plant |
| Mid | Email Manager `مدير الإيميلات` | Blue rug, wall screen showing a list |
| Mid | Finance Manager `المدير المالي` | Teal rug, bar chart on the wall, coin stacks |
| Lower | Instagram Manager `مدير الإنستغرام` + Card Designer `مصمم الكفرات` | Pink rug, big Instagram logo, colour swatches |
| Lower | Print Manager `مدير الطبعات` | Three 3D printers labelled `BAMBU LAB × 3`, filament rainbow, small robot |
| Lower | Home Engineer – Contractor `مهندس البيت · المقاول` | Orange rug, hard hat, small house model, blueprint on the wall |
| — | `+ غرفة جديدة` (new room) | Dashed empty slot for adding an agent |

Each desk has a floating **name chip** with a status dot. A ↗ on the chip means it links to an external resource.

**Agent card** (tap a desk): opens a bottom sheet. Example, the Contractor:
- Name + status `فاضي · جاهز` (idle · ready)
- Description: *enters construction invoices into the "Build" sheet by line item, and edits the 3D house tour and facade*
- Bullets: *contractor / electrical / plumbing invoices…* · *windows & facade on the structural plan*
- Buttons: `شيت بنا ↗` (Build sheet) · `جولة البيت 3D ↗` (3D house tour)
- Hint: *send him a photo of the invoice, or say: `فاتورة المقاول 1500`*

**Print Manager**: tapping it opened makerworld.com on a "Desk cable holder" model it had found (0:38–0:50).

**Chat dock** (always at the bottom): `افتح المحادثة ↑` expands the chat history. The input placeholder is *"write to the General Manager… e.g.: Email manager, what happened?"*. The yellow `دز` button sends the message.

## Screen 2 — 3D House Tour (1:20–1:55)

First-person walkthrough of a modern white house, on a phone.
- **HUD buttons**: `الخريطة` map · `من فوق` top view · `ليل` night · `الدور الأرضي` floor selector
- **Help card**: *joystick: walk · drag: look · tap door / faucet / flush / shower / curtain · elevator: approach and call it*
- **Left thumb**: virtual joystick. **Context button** appears near interactables: `افتح الباب` / `سكّر الباب` (open / close door), `قوم` (stand up, after sitting on the sofa)
- **Rooms seen**: entrance with a wooden door, open kitchen (island, bar stools, pendant lights), floating staircase, living room (L-sofa, plants, TV wall showing a **live weather news screen, 31°**), a room with a second TV, and a **3D-printer cabinet** (4 printers with filament spools)

## How we'll rebuild it (no Claude API, no Node)

| Layer | Choice | Why |
|---|---|---|
| Backend | **Python + FastAPI** | Python 3.12 is installed; Node is not |
| Frontend | Plain HTML + **Three.js from a CDN**, no build step | Same look as the original (real 3D); opens on a phone over Wi-Fi |
| Live status | WebSocket / server-sent events | Desks change state in real time |
| Agents | One loop per agent: **OpenRouter chat + tool calling**. The General Manager routes work with a `delegate(agent, task)` tool | Verified working on free models |
| Storage | SQLite (chat log, tasks, invoices) + a JSON floor plan for the house | Simple, local |
| Voice (AR + EN) | Browser speech recognition (`ar-SA` / `en-US`) now; OpenRouter audio model once credit exists | See the limits below |
| House tour | Generated from `house.json` (rooms, walls, doors, furniture, floors). The Contractor agent edits that JSON | "Give it the plan and it builds the tour" |
| TV weather | Open-Meteo (free, no key) | |

### Model picks (as of 2026-11-09)
- **Manager / router**: `nvidia/nemotron-3-ultra-550b-a55b:free` (1M context, tool calls). Tested: it called `add_invoice` correctly from a Gulf-Arabic message in about 6 s.
- **Workers**: `google/gemma-4-31b-it:free` (accepts images, good for invoice photos)
- **Vision fallback**: `nvidia/nemotron-3.5-super-vl:free`
- **Voice, once credit exists**: `google/gemini-2.5-flash-lite` (audio input, very cheap) or `mistralai/voxtral-small-24b-2507`

### OpenRouter limits found on this key
- Free tier, $0 balance → **50 free-model requests per day**. One agent turn with tool calls uses several requests, so this runs out fast.
- Sending **audio** fails with HTTP 402 *"requires at least $0.50 in balance"*, even on `:free` audio models.
- Buying a small amount of credit (historically $10) raises the free-model limit to about 1,000 requests/day and unlocks cheap paid audio transcription.

## Integrations: real vs. mocked

| Agent | Real version needs | Plan if not provided |
|---|---|---|
| Email Manager | Gmail API — Google Cloud OAuth client (`credentials.json`) | Mock inbox |
| Finance + Contractor "Build" sheet | Google Sheets API — same OAuth client | Local SQLite table + a sheet-like page |
| Instagram Manager | Meta Graph API (Business account + Meta app). Heavy setup | Mock: drafts posts and captions only |
| Card Designer | Image generation (paid models on OpenRouter) | LLM generates SVG/HTML cards |
| Print Manager | MakerWorld has no public API; Bambu printers need LAN access codes | Searches/links MakerWorld, mock printer queue |
| TV weather | Open-Meteo | Real (free) |
