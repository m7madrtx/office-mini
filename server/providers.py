"""Model provider adapter: OpenRouter, Anthropic (Claude), OpenAI (ChatGPT), Google Gemini, Qwen (DashScope),
DeepSeek, Mistral, Groq, xAI (Grok) and local Ollama — behind one `complete()` call.

A model reference is "provider:model_id", e.g. "anthropic:claude-sonnet-4-5" or
"openrouter:nvidia/nemotron-3-ultra-550b-a55b:free". Everything speaks the OpenAI chat format
internally; Anthropic is translated to and from its Messages API.
"""
import json
import os
import re
import time

import httpx

PROVIDERS = [
    {"id": "openrouter", "name": "OpenRouter", "kind": "openai", "base": "https://openrouter.ai/api/v1",
     "key_env": "OPENROUTER_API_KEY", "keys_url": "https://openrouter.ai/settings/keys"},
    {"id": "anthropic", "name": "Anthropic (Claude)", "kind": "anthropic", "base": "https://api.anthropic.com/v1",
     "key_env": "ANTHROPIC_API_KEY", "keys_url": "https://console.anthropic.com/settings/keys"},
    {"id": "openai", "name": "OpenAI (ChatGPT)", "kind": "openai", "base": "https://api.openai.com/v1",
     "key_env": "OPENAI_API_KEY", "keys_url": "https://platform.openai.com/api-keys"},
    {"id": "gemini", "name": "Google Gemini", "kind": "openai", "base": "https://generativelanguage.googleapis.com/v1beta/openai",
     "key_env": "GEMINI_API_KEY", "keys_url": "https://aistudio.google.com/apikey"},
    {"id": "qwen", "name": "Qwen (Alibaba DashScope)", "kind": "openai", "base": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
     "key_env": "DASHSCOPE_API_KEY", "keys_url": "https://modelstudio.console.alibabacloud.com/"},
    {"id": "deepseek", "name": "DeepSeek", "kind": "openai", "base": "https://api.deepseek.com/v1",
     "key_env": "DEEPSEEK_API_KEY", "keys_url": "https://platform.deepseek.com/api_keys"},
    {"id": "mistral", "name": "Mistral", "kind": "openai", "base": "https://api.mistral.ai/v1",
     "key_env": "MISTRAL_API_KEY", "keys_url": "https://console.mistral.ai/api-keys"},
    {"id": "groq", "name": "Groq", "kind": "openai", "base": "https://api.groq.com/openai/v1",
     "key_env": "GROQ_API_KEY", "keys_url": "https://console.groq.com/keys"},
    {"id": "xai", "name": "xAI (Grok)", "kind": "openai", "base": "https://api.x.ai/v1",
     "key_env": "XAI_API_KEY", "keys_url": "https://console.x.ai/"},
    {"id": "ollama", "name": "Ollama (local)", "kind": "openai", "base": "http://localhost:11434/v1",
     "key_env": None, "keys_url": "https://ollama.com/download"},
]
BY_ID = {p["id"]: p for p in PROVIDERS}


class LLMError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def base_url(p: dict) -> str:
    return os.environ.get(f"{p['id'].upper()}_BASE_URL", p["base"]).rstrip("/")


def api_key(p: dict) -> str:
    """The company key for a provider (from .env)."""
    return os.environ.get(p["key_env"], "") if p["key_env"] else "ollama"


def stored_key(pid: str) -> str:
    """Any key added on the Settings page for this provider. Only used to list its models (read-only);
    model calls use exactly the key assigned to the employee/room, or the company key."""
    from . import db
    r = db.one("select secret from api_keys where provider=? order by id limit 1", (pid,))
    return r["secret"] if r else ""


def company_configured(p: dict) -> bool:
    if p["id"] == "ollama":
        return bool(os.environ.get("OLLAMA_BASE_URL"))
    return bool(api_key(p))


def configured(p: dict) -> bool:
    """Usable at all: a company key, or at least one key added in Settings."""
    return company_configured(p) or bool(p["key_env"] and stored_key(p["id"]))


def public_list() -> list[dict]:
    return [{"id": p["id"], "name": p["name"], "configured": configured(p), "company": company_configured(p),
             "key_env": p["key_env"] or "OLLAMA_BASE_URL", "keys_url": p["keys_url"]} for p in PROVIDERS]


def parse_ref(ref: str) -> tuple[dict, str]:
    pid, _, mid = (ref or "").partition(":")
    p = BY_ID.get(pid)
    if not p or not mid:
        raise LLMError(f"Unknown model '{ref}'. Use provider:model, e.g. openrouter:google/gemma-4-31b-it:free")
    return p, mid


# ---------------------------------------------------------------- capabilities
NON_CHAT = re.compile(r"(embed|whisper|tts|dall-e|gpt-image|moderation|rerank|transcribe|sora|veo|imagen|lyria|"
                      r"search-preview|realtime|audio-preview|computer-use|babbage|davinci|guard|aqa)", re.I)
VISION = re.compile(r"(gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|[-_.]vl|vision|pixtral|llava|gemma-?[34]|qwen.*vl|"
                    r"qwen3\.[5-9]|qwen-?(max|plus)|mistral-(medium|small)|grok-(2-vision|4)|nemotron.*vl|omni)", re.I)
AUDIO = re.compile(r"(gemini|voxtral|omni|gpt-4o-audio|gpt-audio)", re.I)
REASONING = re.compile(r"(o1|o3|o4|r1|reason|think|gpt-5|claude-(opus|sonnet)-[45]|claude-.*-4|gemini-(2\.5|3)|qwq|qwen3|"
                       r"deepseek-(r|v3\.[1-9])|grok-[34]|magistral|nemotron|kimi-k2)", re.I)
CODING = re.compile(r"(code|coder|codestral|devstral|claude|gpt-4\.1|gpt-5|o3|o4|deepseek|qwen3|kimi|glm|grok|"
                    r"gemini-(2\.5|3)|nemotron|north-mini-code)", re.I)
MULTILINGUAL = re.compile(r"(gpt|claude|gemini|qwen|command|mistral|llama-?[34]|gemma|deepseek|jais|aya|grok|kimi|glm|"
                          r"nemotron|o3|o4)", re.I)
OCR = re.compile(r"(gpt-4o|gpt-4\.1|gpt-5|claude|gemini|qwen.*vl|qwen3\.[5-9]|pixtral|mistral-ocr|gemma-?[34]|nemotron.*vl|omni)", re.I)

CAP_ORDER = ["tools", "vision", "ocr", "audio", "coding", "reasoning", "multilingual", "long_context", "free"]


def infer_caps(provider: str, mid: str, meta: dict | None = None) -> dict:
    caps: set[str] = set()
    ctx = None
    free = provider == "ollama" or mid.endswith(":free")
    if meta and provider == "openrouter":
        arch = meta.get("architecture") or {}
        mods = arch.get("input_modalities") or []
        params = meta.get("supported_parameters") or []
        if "image" in mods:
            caps.add("vision")
        if "audio" in mods:
            caps.add("audio")
        if "tools" in params:
            caps.add("tools")
        if "reasoning" in params or "include_reasoning" in params:
            caps.add("reasoning")
        ctx = meta.get("context_length")
        pr = meta.get("pricing") or {}
        try:
            free = free or (float(pr.get("prompt") or 1) == 0 and float(pr.get("completion") or 1) == 0)
        except ValueError:
            pass
    else:
        caps.add("tools")  # every modern chat API supports function calling
        if meta and provider == "mistral" and isinstance(meta.get("capabilities"), dict):
            mc = meta["capabilities"]
            if not mc.get("function_calling"):
                caps.discard("tools")
            if mc.get("vision"):
                caps.add("vision")
            ctx = meta.get("max_context_length")
        if VISION.search(mid):
            caps.add("vision")
        if AUDIO.search(mid):
            caps.add("audio")
        if REASONING.search(mid):
            caps.add("reasoning")
        ctx = ctx or (meta or {}).get("context_window") or (
            1_000_000 if re.search(r"gemini|gpt-4\.1", mid, re.I) else 200_000 if re.search(r"claude|gpt-5|o3|o4", mid, re.I)
            else 128_000)
    if CODING.search(mid):
        caps.add("coding")
    if MULTILINGUAL.search(mid):
        caps.add("multilingual")
    if "vision" in caps and OCR.search(mid):
        caps.add("ocr")
    if ctx and ctx >= 200_000:
        caps.add("long_context")
    if free:
        caps.add("free")
    return {"caps": [c for c in CAP_ORDER if c in caps], "context": ctx}


# ---------------------------------------------------------------- model lists
_models_cache: dict[str, tuple[float, list[dict]]] = {}


async def list_models(pid: str, force: bool = False) -> list[dict]:
    p = BY_ID.get(pid)
    if not p or not configured(p):
        return []
    hit = _models_cache.get(pid)
    if hit and not force and time.time() - hit[0] < 3600:
        return hit[1]
    out: list[dict] = []
    key = api_key(p) or stored_key(pid)
    try:
        async with httpx.AsyncClient(timeout=25) as c:
            if p["kind"] == "anthropic":
                r = await c.get(f"{base_url(p)}/models?limit=100",
                                headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
                items = r.json().get("data", [])
                for m in items:
                    out.append({"id": m["id"], "name": m.get("display_name") or m["id"], **infer_caps(pid, m["id"])})
            else:
                headers = {"Authorization": f"Bearer {key}"}
                r = await c.get(f"{base_url(p)}/models", headers=headers)
                items = r.json().get("data", [])
                for m in items:
                    mid = (m.get("id") or "").removeprefix("models/")
                    if not mid or NON_CHAT.search(mid):
                        continue
                    if pid == "openrouter" and "text" not in ((m.get("architecture") or {}).get("output_modalities") or ["text"]):
                        continue
                    out.append({"id": mid, "name": m.get("name") or mid, **infer_caps(pid, mid, m)})
    except Exception as e:  # provider down / bad key: show nothing rather than break the UI
        print(f"[models] {pid}: {e}", flush=True)
        return hit[1] if hit else []
    out.sort(key=lambda m: ("free" not in m["caps"], m["name"].lower()))
    _models_cache[pid] = (time.time(), out)
    return out


async def model_info(ref: str) -> dict:
    try:
        p, mid = parse_ref(ref)
    except LLMError:
        return {"caps": [], "context": None}
    for m in await list_models(p["id"]):
        if m["id"] == mid:
            return m
    return {"id": mid, "name": mid, **infer_caps(p["id"], mid)}


def suggest(models_by_provider: dict[str, list[dict]], needs: list[str], prefer_free: bool, n: int = 5) -> list[dict]:
    scored = []
    for pid, models in models_by_provider.items():
        for m in models:
            caps = set(m["caps"])
            if "tools" not in caps:
                continue  # employees must be able to use tools
            met = [c for c in needs if c in caps]
            # on a free tier, paid OpenRouter models just fail — rank free ones far higher
            free_bonus = (5 if "free" in caps else -4 if pid == "openrouter" else 0) if prefer_free else 0
            score = 3 * len(met) + free_bonus + (1 if "multilingual" in caps else 0) \
                + (0.5 if "reasoning" in caps else 0) + min(2, (m.get("context") or 0) / 500_000)
            scored.append({"ref": f"{pid}:{m['id']}", "provider": pid, "name": m["name"], "caps": m["caps"],
                           "met": met, "missing": [c for c in needs if c not in caps], "score": round(score, 2)})
    scored.sort(key=lambda x: -x["score"])
    return scored[:n]


# ---------------------------------------------------------------- completion
def _to_anthropic(messages: list[dict], tools: list[dict] | None) -> dict:
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system" and isinstance(m["content"], str))
    out: list[dict] = []

    def push(role, blocks):
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": blocks})

    for m in messages:
        role = m["role"]
        if role == "system":
            continue
        if role == "tool":
            push("user", [{"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}])
        elif role == "assistant":
            blocks = [{"type": "text", "text": m["content"]}] if m.get("content") else []
            for tc in m.get("tool_calls") or []:
                try:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["function"]["name"], "input": args})
            push("assistant", blocks or [{"type": "text", "text": "…"}])
        else:
            content = m["content"]
            if isinstance(content, str):
                push("user", [{"type": "text", "text": content}])
            else:
                blocks = []
                for part in content:
                    if part.get("type") == "text":
                        blocks.append({"type": "text", "text": part["text"]})
                    elif part.get("type") == "image_url":
                        url = part["image_url"]["url"]
                        mt, _, data = url.partition(";base64,")
                        blocks.append({"type": "image", "source": {"type": "base64", "media_type": mt.removeprefix("data:"),
                                                                   "data": data}})
                push("user", blocks)
    body = {"system": system, "messages": out}
    if tools:
        body["tools"] = [{"name": t["function"]["name"], "description": t["function"]["description"],
                          "input_schema": t["function"]["parameters"]} for t in tools]
    return body


async def complete(ref: str, messages: list[dict], tools: list[dict] | None = None, max_tokens: int = 6000,
                   fallbacks: list[str] | None = None, secret: str | None = None) -> dict:
    """One call = one model request. Returns an OpenAI-style message plus _model / _usage / _finish.
    `secret` is a key assigned to the employee or their room; without one the company key is used."""
    p, mid = parse_ref(ref)
    key = secret or api_key(p)
    if not key:
        raise LLMError(f"{p['name']} has no company key. Assign one of your {p['name']} keys to this employee or "
                       f"their room (Settings → API keys), or add {p['key_env']} to the .env file.", 401)
    t0 = time.time()
    async with httpx.AsyncClient(timeout=240) as c:
        if p["kind"] == "anthropic":
            body = {"model": mid, "max_tokens": min(max_tokens, 8192), **_to_anthropic(messages, tools)}
            r = await c.post(f"{base_url(p)}/messages", json=body,
                             headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                      "content-type": "application/json"})
        else:
            body: dict = {"model": mid, "messages": messages}
            if p["id"] == "openrouter":
                body.pop("model")
                body["models"] = [mid, *[f for f in (fallbacks or []) if f != mid]][:3]
                body["reasoning"] = {"effort": "low", "exclude": True}
            body["max_completion_tokens" if p["id"] == "openai" else "max_tokens"] = max_tokens
            if tools:
                body["tools"] = tools
                body["tool_choice"] = "auto"
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            if p["id"] == "openrouter":
                headers.update({"HTTP-Referer": "http://localhost", "X-Title": "Office Mini"})
            r = await c.post(f"{base_url(p)}/chat/completions", json=body, headers=headers)
    try:
        data = r.json()
    except ValueError:
        raise LLMError(f"{p['name']} returned HTTP {r.status_code}", r.status_code)
    if isinstance(data, list):
        data = data[0] if data else {}
    if r.status_code != 200 or (isinstance(data, dict) and data.get("error")):
        err = data.get("error") if isinstance(data, dict) else None
        msg = err.get("message") if isinstance(err, dict) else (err or f"HTTP {r.status_code}")
        raise LLMError(f"{p['name']}: {msg}", (err.get("code") if isinstance(err, dict) else None) or r.status_code)

    if p["kind"] == "anthropic":
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        calls = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})}}
                 for b in data.get("content", []) if b.get("type") == "tool_use"]
        u = data.get("usage") or {}
        msg = {"role": "assistant", "content": text, "tool_calls": calls or None}
        usage = {"in": u.get("input_tokens"), "out": u.get("output_tokens")}
        finish, model = data.get("stop_reason"), f"anthropic:{data.get('model', mid)}"
    else:
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        u = data.get("usage") or {}
        usage = {"in": u.get("prompt_tokens"), "out": u.get("completion_tokens")}
        finish, model = choice.get("finish_reason"), f"{p['id']}:{data.get('model', mid)}"
    msg["_model"], msg["_usage"], msg["_finish"], msg["_secs"] = model, usage, finish, round(time.time() - t0, 1)
    print(f"[llm] {model} finish={finish} tools={len(msg.get('tool_calls') or [])} "
          f"content={len(msg.get('content') or '')}ch in={usage['in']} out={usage['out']} {msg['_secs']}s", flush=True)
    return msg


# ---------------------------------------------------------------- health (colour-coded alerts)
# state: ok | low | rate_limited | depleted | expired | invalid | error | unconfigured
HEALTH: dict[str, dict] = {}
LEVEL = {"ok": "green", "low": "amber", "rate_limited": "amber", "error": "amber",
         "depleted": "red", "expired": "red", "invalid": "red", "unconfigured": "grey"}


def _set_health(pid: str, state: str, detail: str = "") -> dict:
    HEALTH[pid] = {"provider": pid, "state": state, "level": LEVEL[state], "detail": detail, "ts": time.time()}
    return HEALTH[pid]


def classify_error(status, message: str) -> str:
    m = (message or "").lower()
    if status in (401, 403) or "invalid" in m and "key" in m or "unauthorized" in m or "authentication" in m:
        return "expired" if "expired" in m else "invalid"
    if status == 402 or any(w in m for w in ("insufficient", "credit", "quota", "balance", "billing", "payment")):
        return "depleted"
    if status == 429 or "rate" in m or "limit" in m:
        return "rate_limited"
    return "error"


def mark_error(ref: str, err: "LLMError") -> dict:
    pid = (ref or "").partition(":")[0]
    state = classify_error(err.status, str(err))
    return _set_health(pid, state, str(err)[:240])


async def probe(p: dict, key: str) -> tuple[str, str]:
    """Check one key against its provider without spending a model request. Returns (state, detail)."""
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            if p["id"] == "openrouter":
                r = await c.get(f"{base_url(p)}/key", headers={"Authorization": f"Bearer {key}"})
                if r.status_code in (401, 403):
                    return "invalid", "OpenRouter rejected the key"
                d = r.json().get("data", {})
                exp = d.get("expires_at")
                if exp:
                    import datetime as _dt
                    if _dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() < time.time():
                        return "expired", f"Key expired on {exp[:10]}"
                q = d.get("free_model_daily_requests") or {}
                rem, lim = q.get("remaining"), q.get("limit")
                credit = d.get("limit_remaining")
                if rem is not None and rem <= 0:
                    return "depleted", f"Free requests used up for today (0/{lim}). They reset daily."
                if credit is not None and credit <= 0 and not d.get("is_free_tier"):
                    return "depleted", "No credit left on this key"
                if rem is not None and rem <= 10:
                    return "low", f"Only {rem}/{lim} free requests left today"
                return "ok", f"{rem}/{lim} free requests left today" if rem is not None else "Connected"
            if p["kind"] == "anthropic":
                r = await c.get(f"{base_url(p)}/models?limit=1", headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
            else:
                r = await c.get(f"{base_url(p)}/models", headers={"Authorization": f"Bearer {key}"})
        if r.status_code == 200:
            return "ok", "Connected"
        try:
            msg = (r.json().get("error") or {})
            msg = msg.get("message") if isinstance(msg, dict) else str(msg)
        except Exception:
            msg = f"HTTP {r.status_code}"
        return classify_error(r.status_code, msg or ""), msg or f"HTTP {r.status_code}"
    except Exception as e:
        return "error", f"Can't reach {p['name']}: {e}"[:240]


async def check_health(pid: str) -> dict:
    """Health of the company key for a provider."""
    p = BY_ID[pid]
    if not company_configured(p):
        extra = " (or assign one of your Settings keys to employees)" if configured(p) else ""
        return _set_health(pid, "unconfigured", f"No company key: add {p['key_env'] or 'OLLAMA_BASE_URL'} to .env{extra}")
    state, detail = await probe(p, api_key(p))
    if state == "ok" and pid != "openrouter":
        prev = HEALTH.get(pid)  # keep a recent runtime problem (e.g. no credit) visible for 10 minutes
        if prev and prev["state"] in ("depleted", "rate_limited") and time.time() - prev["ts"] < 600:
            return prev
    return _set_health(pid, state, detail)


async def health(refresh: bool = False) -> list[dict]:
    out = []
    for p in PROVIDERS:
        h = HEALTH.get(p["id"])
        if refresh or not h or time.time() - h["ts"] > 300:
            h = await check_health(p["id"])
        out.append({**h, "name": p["name"], "key_env": p["key_env"] or "OLLAMA_BASE_URL", "keys_url": p["keys_url"]})
    return out


_quota_cache: dict = {"ts": 0.0, "data": None}


async def quota(force: bool = False) -> dict | None:
    """OpenRouter's free-model daily request counter (the /key endpoint does not use quota)."""
    p = BY_ID["openrouter"]
    if not configured(p):
        return None
    if not force and _quota_cache["data"] and time.time() - _quota_cache["ts"] < 120:
        return _quota_cache["data"]
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(f"{base_url(p)}/key", headers={"Authorization": f"Bearer {api_key(p)}"})
        info = r.json().get("data", {})
        q = info.get("free_model_daily_requests") or {}
        _quota_cache.update(ts=time.time(), data={"used": q.get("used"), "limit": q.get("limit"),
                                                  "remaining": q.get("remaining"), "free_tier": info.get("is_free_tier")})
    except Exception:
        pass
    return _quota_cache["data"]
