"""The 3D house tour is generated from data/house.json. The Contractor agent edits it here."""
import json
import re
import shutil
from pathlib import Path

from .config import DATA

DEFAULT = Path(__file__).with_name("house_default.json")
PATH = DATA / "house.json"

FURNITURE = ["sofa_l", "sofa", "coffee_table", "tv_wall", "plant", "tree", "kitchen_island",
             "kitchen_counter", "dining_table", "bed", "wardrobe", "desk", "printer_cabinet",
             "bathroom_sink", "toilet", "shower", "curtain", "rug", "bookshelf", "floor_lamp"]

_COLOR = re.compile(r"^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-zA-Z]{3,20})$")


def load() -> dict:
    if not PATH.exists():
        shutil.copy(DEFAULT, PATH)
    return json.loads(PATH.read_text(encoding="utf-8"))


def save(h: dict) -> None:
    PATH.write_text(json.dumps(h, ensure_ascii=False, indent=1), encoding="utf-8")


def reset() -> None:
    shutil.copy(DEFAULT, PATH)


def summary() -> dict:
    h = load()
    return {
        "floors": [{
            "id": f["id"], "name": f["name"]["en"],
            "rooms": [{"id": r["id"], "name": r["name"]["en"], "name_ar": r["name"]["ar"],
                       "size_m": [round(r["x1"] - r["x0"], 1), round(r["z1"] - r["z0"], 1)],
                       "wall": r["wall"], "floor": r["floor"],
                       "furniture": [i["type"] for i in r["furniture"]]} for r in f["rooms"]],
        } for f in h["floors"]],
        "furniture_catalog": FURNITURE,
    }


def _find_room(h: dict, room: str):
    key = (room or "").strip().lower()
    for f in h["floors"]:
        for r in f["rooms"]:
            if key in (r["id"].lower(), r["name"]["en"].lower(), r["name"]["ar"]):
                return r
    for f in h["floors"]:  # loose match ("bedroom" -> "Master bedroom")
        for r in f["rooms"]:
            if key and (key in r["name"]["en"].lower() or key in r["id"].lower()):
                return r
    return None


def _free_spot(r: dict) -> tuple[float, float]:
    taken = [(i["x"], i["z"]) for i in r["furniture"]]
    best, best_d = ((r["x0"] + r["x1"]) / 2, (r["z0"] + r["z1"]) / 2), -1.0
    steps = 6
    for i in range(steps + 1):
        for j in range(steps + 1):
            x = r["x0"] + 0.8 + (r["x1"] - r["x0"] - 1.6) * i / steps
            z = r["z0"] + 0.8 + (r["z1"] - r["z0"] - 1.6) * j / steps
            d = min([((x - a) ** 2 + (z - b) ** 2) ** 0.5 for a, b in taken] or [9.0])
            if d > best_d:
                best, best_d = (x, z), d
    return round(best[0], 2), round(best[1], 2)


def edit(action: str, room: str, color: str = "", item: str = "", name: str = "") -> dict:
    h = load()
    r = _find_room(h, room)
    if not r:
        rooms = [x["id"] for f in h["floors"] for x in f["rooms"]]
        return {"ok": False, "error": f"Unknown room '{room}'. Rooms: {rooms}"}
    if action in ("paint_walls", "floor_color"):
        if not _COLOR.match(color or ""):
            return {"ok": False, "error": "color must be a hex code like #c8d6e5 or a CSS colour name"}
        r["wall" if action == "paint_walls" else "floor"] = color
    elif action == "add_furniture":
        if item not in FURNITURE:
            return {"ok": False, "error": f"Unknown item. Catalog: {FURNITURE}"}
        x, z = _free_spot(r)
        r["furniture"].append({"type": item, "x": x, "z": z})
    elif action == "remove_furniture":
        idx = next((k for k in range(len(r["furniture"]) - 1, -1, -1) if r["furniture"][k]["type"] == item), None)
        if idx is None:
            return {"ok": False, "error": f"No '{item}' in {r['id']}"}
        r["furniture"].pop(idx)
    elif action == "rename_room":
        if not name:
            return {"ok": False, "error": "name is required"}
        if re.search(r"[؀-ۿ]", name):
            r["name"]["ar"] = name
        else:
            r["name"]["en"] = name
    else:
        return {"ok": False, "error": "action must be paint_walls, floor_color, add_furniture, remove_furniture or rename_room"}
    save(h)
    return {"ok": True, "room": r["id"], "action": action}
