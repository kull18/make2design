"""
textvec — convierte cada capa de texto de design.json en contornos vectoriales (SVG).

Sirve como respaldo cuando Figma no deja a los plugins cargar fuentes (pasa en Linux):
el plugin dibuja el texto como vector, visualmente idéntico aunque no editable como texto.

Usa HarfBuzz (el mismo motor de Chrome) para acomodar los glifos y fontTools para los contornos.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

try:
    import uharfbuzz as hb
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Faltan dependencias para vectorizar: pip install uharfbuzz fonttools") from exc

FONTS_DIR = Path(__file__).resolve().parent / "fonts"
WEIGHT_NAMES = {100: ["Thin"], 200: ["ExtraLight"], 300: ["Light"], 400: ["Regular", ""], 500: ["Medium"],
                600: ["SemiBold"], 700: ["Bold"], 800: ["ExtraBold"], 900: ["Black"]}
FAMILY_PREFIX = {"inter": "Inter", "jetbrains mono": "JetBrainsMono", "plus jakarta sans": "PlusJakartaSans"}


class Face:
    def __init__(self, path: Path):
        self.path = path
        self.tt = TTFont(str(path))
        self.glyph_set = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        self.upem = self.tt["head"].unitsPerEm
        data = path.read_bytes()
        self.hb_face = hb.Face(hb.Blob(data))
        self.hb_font = hb.Font(self.hb_face)
        self.hb_font.scale = (self.upem, self.upem)
        os2 = self.tt["OS/2"] if "OS/2" in self.tt else None
        hhea = self.tt["hhea"]
        if os2 is not None and (os2.fsSelection & (1 << 7)):
            self.asc, self.desc, self.gap = os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap
        else:
            self.asc, self.desc, self.gap = hhea.ascent, hhea.descent, hhea.lineGap
        post = self.tt["post"]
        self.underline = (post.underlinePosition, max(1, post.underlineThickness))
        self.strike = ((os2.yStrikeoutPosition, max(1, os2.yStrikeoutSize)) if os2 is not None
                       else (int(self.upem * 0.3), int(self.upem * 0.05)))
        self.cmap = self.tt.getBestCmap() or {}

    def has(self, ch: str) -> bool:
        return ord(ch) in self.cmap


@lru_cache(maxsize=None)
def find_face(family: str, weight: int, italic: bool) -> Face:
    prefix = FAMILY_PREFIX.get((family or "").lower(), (family or "Inter").replace(" ", ""))
    w = min(900, max(100, int(round((weight or 400) / 100.0)) * 100))
    order = sorted(WEIGHT_NAMES, key=lambda k: (abs(k - w), -k if w >= 400 else k))
    for pfx in (prefix, "Inter"):
        for k in order:
            for name in WEIGHT_NAMES[k]:
                styles = ([f"{name}Italic", "Italic" if name in ("Regular", "") else None] if italic else []) + [name or "Regular"]
                for st in filter(None, styles):
                    p = FONTS_DIR / f"{pfx}-{st}.ttf"
                    if p.exists():
                        return Face(p)
    raise FileNotFoundError(f"No hay archivos de fuente en {FONTS_DIR}")


def apply_case(text: str, case: str) -> str:
    if case == "UPPER":
        return text.upper()
    if case == "LOWER":
        return text.lower()
    if case == "TITLE":
        return " ".join(w[:1].upper() + w[1:] for w in text.split(" "))
    return text


def shape_line(face: Face, fallback: Face, text: str, size: float, spacing: float):
    """Devuelve [(face, glyph_name, x, y)] en px y el ancho de la línea."""
    scale = size / face.upem
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    features = {"kern": True, "liga": spacing == 0, "clig": spacing == 0, "calt": True}
    hb.shape(face.hb_font, buf, features)
    out, x = [], 0.0
    clusters = [i.cluster for i in buf.glyph_infos]
    for info, pos, cl in zip(buf.glyph_infos, buf.glyph_positions, clusters):
        if info.codepoint == 0 and cl < len(text) and fallback.has(text[cl]):
            # Carácter que la fuente no tiene: se toma de la fuente de respaldo
            fs = size / fallback.upem
            gname = fallback.cmap[ord(text[cl])]
            adv = fallback.tt["hmtx"][gname][0] * fs
            out.append((fallback, gname, x, 0.0, fs))
            x += adv + spacing
            continue
        gname = face.order[info.codepoint]
        out.append((face, gname, x + pos.x_offset * scale, -pos.y_offset * scale, scale))
        x += pos.x_advance * scale + spacing
    return out, x


def text_to_svg(n: dict, sans_fallback: str = "Inter") -> dict | None:
    chars = n.get("characters") or ""
    if not chars.strip():
        return None
    font = n.get("font") or {}
    face = find_face(font.get("family", "Inter"), font.get("weight", 400), bool(font.get("italic")))
    fallback = find_face(sans_fallback, font.get("weight", 400), bool(font.get("italic")))
    size = float(n.get("fontSize") or 14)
    spacing = float(n.get("letterSpacing") or 0)
    s = size / face.upem
    content_h = (face.asc - face.desc) * s
    lh = float(n["lineHeight"]) if n.get("lineHeight") else (face.asc - face.desc + face.gap) * s
    lines = apply_case(chars, n.get("textCase", "ORIGINAL")).split("\n")

    shaped = [shape_line(face, fallback, ln, size, spacing) for ln in lines]
    max_w = max((w for _, w in shaped), default=0)
    box_w = max(float(n.get("w") or 0), max_w)
    align = n.get("align", "LEFT")
    paths, deco = [], []
    for i, (glyphs, w) in enumerate(shaped):
        ox = {"CENTER": (box_w - w) / 2, "RIGHT": box_w - w}.get(align, 0.0)
        baseline = i * lh + (lh - content_h) / 2 + face.asc * s
        for gface, gname, gx, gy, gs in glyphs:
            pen = SVGPathPen(gface.glyph_set, ntos=_ntos)
            tpen = TransformPen(pen, (gs, 0, 0, -gs, ox + gx, baseline + gy))
            gface.glyph_set[gname].draw(tpen)
            d = pen.getCommands()
            if d:
                paths.append(d)
        if n.get("decoration") in ("UNDERLINE", "STRIKETHROUGH") and w > 0:
            pos, thick = face.underline if n["decoration"] == "UNDERLINE" else face.strike
            y = baseline - pos * s - (thick * s if n["decoration"] == "STRIKETHROUGH" else 0)
            deco.append(f'<rect x="{ox:.2f}" y="{y:.2f}" width="{w - spacing:.2f}" height="{max(0.6, thick * s):.2f}"/>')
    if not paths and not deco:
        return None

    total_h = max(lh * len(lines), content_h)
    defs, fill = "", "#000"
    if n.get("gradient"):
        g = n["gradient"]
        a = math.radians(g.get("angle", 90))
        dx, dy = math.sin(a), -math.cos(a)
        stops = "".join(f'<stop offset="{st["position"]:.3f}" stop-color="{rgb(st["color"])}" stop-opacity="{st["color"].get("a", 1):.3f}"/>'
                        for st in g["stops"])
        defs = (f'<defs><linearGradient id="g" x1="{0.5 - dx / 2:.3f}" y1="{0.5 - dy / 2:.3f}" '
                f'x2="{0.5 + dx / 2:.3f}" y2="{0.5 + dy / 2:.3f}">{stops}</linearGradient></defs>')
        fill = "url(#g)"
        fill_op = 1
    else:
        c = n.get("color") or {"r": 0, "g": 0, "b": 0, "a": 1}
        fill, fill_op = rgb(c), c.get("a", 1)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{box_w:.2f}" height="{total_h:.2f}" '
           f'viewBox="0 0 {box_w:.2f} {total_h:.2f}">{defs}<g fill="{fill}" fill-opacity="{fill_op:.3f}">'
           f'<path d="{" ".join(paths)}"/>{"".join(deco)}</g></svg>')
    return {"svg": svg, "w": round(box_w, 2), "h": round(total_h, 2)}


def _ntos(v: float) -> str:
    t = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if t in ("-0", "") else t


def rgb(c: dict) -> str:
    return f"rgb({round(c['r'] * 255)},{round(c['g'] * 255)},{round(c['b'] * 255)})"


def iter_nodes(nodes):
    for n in nodes:
        yield n
        yield from iter_nodes(n.get("children", []))


def vectorize_design(design: dict, log=print) -> int:
    """Agrega n['vector'] = {'ref', 'w', 'h'}; los SVG idénticos se guardan una vez en design['vectors']."""
    import hashlib
    store: dict[str, str] = design.setdefault("vectors", {})
    count = 0
    for page in design.get("pages", []):
        for frame in page.get("frames", []):
            for n in iter_nodes(frame.get("children", [])):
                if n.get("type") == "TEXT":
                    try:
                        v = text_to_svg(n)
                    except Exception as exc:  # noqa: BLE001
                        log(f"    ! no se pudo vectorizar '{str(n.get('characters'))[:30]}': {exc}")
                        v = None
                    if v:
                        ref = hashlib.sha1(v["svg"].encode()).hexdigest()[:14]
                        store.setdefault(ref, v["svg"])
                        n["vector"] = {"ref": ref, "w": v["w"], "h": v["h"]}
                        count += 1
    design["vectorText"] = True
    log(f"  {len(store)} contornos únicos")
    return count
