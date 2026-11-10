"""Cover/card designs rendered as SVG from templates (no image model needed, so it stays free)."""
import re
from xml.sax.saxutils import escape

FORMATS = {"square": (1080, 1080), "story": (1080, 1920), "wide": (1280, 720)}

STYLES = {
    "neon":      {"bg": ("#0b1030", "#2a1065"), "fg": "#ffffff", "accent": "#35f2ff", "accent2": "#ff4fd8"},
    "minimal":   {"bg": ("#f6f4ef", "#ece8df"), "fg": "#1d1d1f", "accent": "#d4502b", "accent2": "#1d1d1f"},
    "sunset":    {"bg": ("#ff7e5f", "#6a3093"), "fg": "#ffffff", "accent": "#ffd86f", "accent2": "#ffffff"},
    "blueprint": {"bg": ("#0d3b66", "#0a2a4a"), "fg": "#eaf6ff", "accent": "#8fd3ff", "accent2": "#eaf6ff"},
    "festive":   {"bg": ("#0f5132", "#0b3d26"), "fg": "#fff8e1", "accent": "#f4c542", "accent2": "#e63946"},
}

_AR = re.compile(r"[؀-ۿ]")


def _wrap(text: str, max_chars: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > max_chars and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines[:4]


def render(title: str, subtitle: str = "", style: str = "neon", fmt: str = "square") -> str:
    s = STYLES.get(style, STYLES["neon"])
    w, h = FORMATS.get(fmt, FORMATS["square"])
    rtl = bool(_AR.search(title + subtitle))
    anchor_x, anchor = (w - 90, "end") if rtl else (90, "start")
    size = int(min(w, h) * (0.11 if len(title) < 24 else 0.085))
    lines = _wrap(title, max(8, int(w / (size * 0.55))))
    top = h * 0.42 - (len(lines) - 1) * size * 0.6
    title_svg = "".join(
        f'<text x="{anchor_x}" y="{top + i * size * 1.15:.0f}" font-size="{size}" font-weight="800" '
        f'fill="{s["fg"]}" text-anchor="{anchor}">{escape(line)}</text>' for i, line in enumerate(lines))
    sub_y = top + len(lines) * size * 1.15 + size * 0.2
    sub_svg = (f'<text x="{anchor_x}" y="{sub_y:.0f}" font-size="{int(size * 0.42)}" fill="{s["fg"]}" '
               f'opacity="0.85" text-anchor="{anchor}">{escape(subtitle)}</text>') if subtitle else ""
    bar_x = w - 90 - 160 if rtl else 90
    deco = {
        "neon": f'<circle cx="{w*0.82}" cy="{h*0.18}" r="{min(w,h)*0.16}" fill="none" stroke="{s["accent"]}" stroke-width="10" opacity=".8"/>'
                f'<circle cx="{w*0.12}" cy="{h*0.86}" r="{min(w,h)*0.09}" fill="none" stroke="{s["accent2"]}" stroke-width="8" opacity=".8"/>',
        "minimal": f'<rect x="{w*0.72}" y="{h*0.08}" width="{w*0.2}" height="{w*0.2}" fill="{s["accent"]}"/>',
        "sunset": f'<circle cx="{w/2}" cy="{h*0.95}" r="{w*0.45}" fill="{s["accent"]}" opacity=".35"/>',
        "blueprint": "".join(f'<line x1="{x}" y1="0" x2="{x}" y2="{h}" stroke="{s["accent"]}" stroke-opacity=".15"/>' for x in range(0, w, 60))
                     + "".join(f'<line x1="0" y1="{y}" x2="{w}" y2="{y}" stroke="{s["accent"]}" stroke-opacity=".15"/>' for y in range(0, h, 60)),
        "festive": "".join(f'<circle cx="{(i*197)%w}" cy="{(i*131)%int(h*0.3)+20}" r="{6+i%5*3}" fill="{s["accent"] if i%2 else s["accent2"]}" opacity=".8"/>' for i in range(18)),
    }[style if style in STYLES else "neon"]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'font-family="Tajawal, Cairo, Segoe UI, Arial, sans-serif">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{s["bg"][0]}"/><stop offset="1" stop-color="{s["bg"][1]}"/></linearGradient></defs>'
        f'<rect width="{w}" height="{h}" fill="url(#g)"/>{deco}'
        f'<rect x="{bar_x}" y="{top - size * 1.3:.0f}" width="160" height="12" rx="6" fill="{s["accent"]}"/>'
        f'{title_svg}{sub_svg}</svg>'
    )
