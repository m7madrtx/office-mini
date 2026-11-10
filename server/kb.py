"""Knowledge bases attached to an employee, a room, a division or the whole company.

Files are stored under data/kb and their text is extracted (PDF, Word .docx, text and code files).
Search is a simple keyword ranking over ~900-character chunks — free, offline, and good enough
for an agent to pull the right passage before answering.
"""
import base64
import io
import math
import re
import time
import zipfile

from . import db
from .config import DATA

KB_DIR = DATA / "kb"
KB_DIR.mkdir(exist_ok=True)
MAX_BYTES = 15 * 1024 * 1024
TEXT_EXT = {".txt", ".md", ".csv", ".json", ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".yaml", ".yml",
            ".xml", ".sql", ".log", ".ini", ".toml", ".sh", ".java", ".go", ".rs", ".c", ".cpp", ".cs", ".php", ".rb"}
SCOPES = ("employee", "room", "division", "company")


def _extract(name: str, data: bytes) -> str:
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    try:
        if ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            return "\n\n".join((p.extract_text() or "") for p in reader.pages[:300])
        if ext == ".docx":
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                xml = z.read("word/document.xml").decode("utf-8", "ignore")
            xml = re.sub(r"</w:p>", "\n", xml)
            return re.sub(r"<[^>]+>", "", xml)
        if ext in TEXT_EXT or not ext:
            return data.decode("utf-8", "ignore")
    except Exception as e:
        return f"(could not read this file: {e})"
    return ""  # images and other binaries are stored but not searchable


def add(scope_type: str, scope_id: str, name: str, data_b64: str, mime: str = "") -> dict:
    if scope_type not in SCOPES:
        raise ValueError("bad scope")
    data = base64.b64decode(data_b64.split(",", 1)[-1])
    if len(data) > MAX_BYTES:
        raise ValueError("File is larger than 15 MB")
    safe = re.sub(r"[^\w.\- ]", "_", name)[:120] or "file"
    kid = db.run("insert into knowledge(ts, scope_type, scope_id, name, mime, size, path, text) values(?,?,?,?,?,?,?,?)",
                 (time.time(), scope_type, scope_id, safe, mime, len(data), "", ""))
    path = KB_DIR / f"{kid}_{safe}"
    path.write_bytes(data)
    text = _extract(safe, data)
    db.run("update knowledge set path=?, text=? where id=?", (path.name, text, kid))
    return {"id": kid, "name": safe, "size": len(data), "chars": len(text)}


def remove(kid: int) -> None:
    row = db.one("select path from knowledge where id=?", (kid,))
    if row and row["path"]:
        (KB_DIR / row["path"]).unlink(missing_ok=True)
    db.run("delete from knowledge where id=?", (kid,))


def listing(scope_type: str | None = None, scope_id: str | None = None) -> list[dict]:
    sql = "select id, ts, scope_type, scope_id, name, mime, size, length(text) chars from knowledge"
    if scope_type:
        return db.rows(sql + " where scope_type=? and scope_id=? order by id desc", (scope_type, scope_id))
    return db.rows(sql + " order by id desc")


def scopes_for(emp: dict) -> list[tuple[str, str]]:
    return [("employee", emp["id"]), ("room", emp["room_id"]), ("division", emp.get("division") or ""), ("company", "company")]


def docs_for(emp: dict) -> list[dict]:
    out = []
    for st, sid in scopes_for(emp):
        out += db.rows("select id, name, scope_type, length(text) chars from knowledge where scope_type=? and scope_id=?",
                       (st, sid))
    return out


_TOKEN = re.compile(r"[\w؀-ۿ]+", re.UNICODE)


def search(emp: dict, query: str, k: int = 5) -> list[dict]:
    terms = [t.lower() for t in _TOKEN.findall(query) if len(t) > 2]
    if not terms:
        return []
    chunks = []
    for st, sid in scopes_for(emp):
        for d in db.rows("select id, name, text from knowledge where scope_type=? and scope_id=?", (st, sid)):
            text = d["text"] or ""
            for i in range(0, max(1, len(text)), 750):
                chunks.append((d, st, text[i:i + 900]))
    if not chunks:
        return []
    df = {t: sum(1 for _, _, c in chunks if t in c.lower()) for t in terms}
    scored = []
    for d, st, c in chunks:
        low = c.lower()
        s = sum(low.count(t) * math.log(1 + len(chunks) / (1 + df[t])) for t in terms)
        if s > 0:
            scored.append((s, d, st, c))
    scored.sort(key=lambda x: -x[0])
    return [{"document_id": d["id"], "file": d["name"], "scope": st, "excerpt": c.strip()} for _, d, st, c in scored[:k]]
