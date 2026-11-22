#!/usr/bin/env python3
"""
make2design — convierte las pantallas de una app de Figma Make (o cualquier web)
en un JSON que el plugin "Make → Design (páginas)" dibuja en Figma Design,
creando UNA PÁGINA de Figma por cada pantalla.

Uso rápido:
  python make2design.py inspect http://localhost:5173
  python make2design.py extract --config pages.json -o design.json
  python make2design.py extract --url http://localhost:5173 --discover -o design.json
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    from playwright.sync_api import sync_playwright, Page, BrowserContext
except ImportError:  # pragma: no cover
    sys.exit("Falta Playwright: pip install -r requirements.txt && playwright install chromium")

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

HERE = Path(__file__).resolve().parent
WALKER_JS = (HERE / "walker.js").read_text(encoding="utf-8")
FIGMA_MAX_IMAGE = 4096          # límite de figma.createImage
REFERENCE_TILE = 4000           # alto máximo de cada tira de la captura de referencia
SUPPORTED_FORMATS = {"PNG", "JPEG", "GIF"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- imágenes
class ImageStore:
    """Guarda imágenes en base64 sin duplicados; los nodos solo llevan una referencia."""

    def __init__(self) -> None:
        self.images: dict[str, str] = {}
        self.by_src: dict[str, str | None] = {}

    def add_bytes(self, data: bytes) -> str | None:
        data = normalize_image(data)
        if data is None:
            return None
        ref = hashlib.sha1(data).hexdigest()[:16]
        self.images.setdefault(ref, base64.b64encode(data).decode("ascii"))
        return ref

    def from_src(self, ctx: BrowserContext, src: str) -> str | None:
        if src in self.by_src:
            return self.by_src[src]
        ref = None
        try:
            if src.startswith("data:"):
                header, _, payload = src.partition(",")
                data = base64.b64decode(payload) if ";base64" in header else payload.encode()
            else:
                resp = ctx.request.get(src, timeout=20000)
                data = resp.body() if resp.ok else None
            if data:
                ref = self.add_bytes(data)
        except Exception as exc:  # noqa: BLE001
            log(f"    ! no se pudo descargar {src[:80]}: {exc}")
        self.by_src[src] = ref
        return ref


def normalize_image(data: bytes) -> bytes | None:
    """Figma solo acepta PNG/JPEG/GIF de hasta 4096 px por lado."""
    if Image is None:
        return data if data[:4] in (b"\x89PNG", b"GIF8") or data[:3] == b"\xff\xd8\xff" else None
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        if fmt in SUPPORTED_FORMATS and max(img.size) <= FIGMA_MAX_IMAGE:
            return data
        img.thumbnail((FIGMA_MAX_IMAGE, FIGMA_MAX_IMAGE))
        out = io.BytesIO()
        if img.mode in ("RGBA", "LA", "P"):
            img.convert("RGBA").save(out, "PNG", optimize=True)
        else:
            img.convert("RGB").save(out, "JPEG", quality=90)
        return out.getvalue()
    except Exception:  # SVG u otros formatos que Pillow no abre
        return None


def svg_from_src(ctx: BrowserContext, src: str) -> str | None:
    try:
        if src.startswith("data:image/svg"):
            header, _, payload = src.partition(",")
            from urllib.parse import unquote
            return base64.b64decode(payload).decode() if ";base64" in header else unquote(payload)
        if src.lower().split("?")[0].endswith(".svg"):
            resp = ctx.request.get(src, timeout=20000)
            return resp.text() if resp.ok else None
    except Exception:  # noqa: BLE001
        return None
    return None


def iter_nodes(nodes):
    for n in nodes:
        yield n
        yield from iter_nodes(n.get("children", []))


def resolve_images(page: Page, ctx: BrowserContext, tree: dict, store: ImageStore) -> None:
    for node in iter_nodes(tree["children"]):
        if node["type"] == "IMAGE":
            src = node.get("src")
            ref = None
            if src:
                svg = svg_from_src(ctx, src)
                if svg:
                    node["type"], node["svg"] = "SVG", svg
                    continue
                ref = store.from_src(ctx, src)
            if ref is None and node.get("marker"):
                # Respaldo: captura del elemento tal como se ve en pantalla
                try:
                    shot = page.locator(f'[data-f2d="{node["marker"]}"]').first.screenshot(timeout=5000)
                    ref = store.add_bytes(shot)
                except Exception:  # noqa: BLE001
                    pass
            node["imageRef"] = ref
        elif node["type"] == "FRAME" and node.get("bgImage"):
            node["bgImage"]["imageRef"] = store.from_src(ctx, urljoin(page.url, node["bgImage"]["src"]))
        node.pop("marker", None)
        node.pop("src", None)


def reference_tiles(page: Page, store: ImageStore, full_page: bool = True) -> list[dict]:
    """Captura de página completa partida en tiras (Figma limita imágenes a 4096 px)."""
    shot = page.screenshot(full_page=full_page)
    if Image is None:
        ref = store.add_bytes(shot)
        return [{"y": 0, "imageRef": ref}] if ref else []
    img = Image.open(io.BytesIO(shot))
    tiles = []
    for top in range(0, img.height, REFERENCE_TILE):
        part = img.crop((0, top, img.width, min(img.height, top + REFERENCE_TILE)))
        buf = io.BytesIO()
        part.convert("RGB").save(buf, "JPEG", quality=80)
        tiles.append({"y": top, "w": part.width, "h": part.height, "imageRef": store.add_bytes(buf.getvalue())})
    return tiles


# --------------------------------------------------------------------------- navegación
def settle(page: Page, wait_ms: int) -> None:
    """Desplaza la página para activar lazy-load y animaciones 'whileInView', y vuelve arriba."""
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:  # noqa: BLE001
        pass
    height = page.evaluate("document.documentElement.scrollHeight")
    view = page.viewport_size["height"] if page.viewport_size else 900
    y = 0
    while y < height:
        page.evaluate(f"window.scrollTo(0, {y})")
        page.wait_for_timeout(120)
        y += int(view * 0.7)
        height = page.evaluate("document.documentElement.scrollHeight")
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(wait_ms)
    try:
        page.evaluate("document.fonts && document.fonts.ready")
    except Exception:  # noqa: BLE001
        pass


def run_actions(page: Page, actions: list[dict]) -> None:
    for act in actions or []:
        if "click" in act:
            page.locator(act["click"]).first.click(timeout=10000)
        elif "hover" in act:
            page.locator(act["hover"]).first.hover(timeout=10000)
        elif "fill" in act:
            page.locator(act["fill"]).first.fill(act.get("value", ""), timeout=10000)
        elif "press" in act:
            page.keyboard.press(act["press"])
        elif "goto" in act:
            page.goto(urljoin(page.url, act["goto"]))
        elif "scroll" in act:
            page.evaluate(f"window.scrollTo(0, {int(act['scroll'])})")
        elif "eval" in act:
            page.evaluate(act["eval"])
        if "wait" in act:
            page.wait_for_timeout(int(act["wait"]))
        else:
            page.wait_for_timeout(300)


def capture_frame(page: Page, ctx: BrowserContext, store: ImageStore, reference: bool, fonts: dict | None = None,
                  viewport_only: bool = False) -> dict:
    tree = page.evaluate(WALKER_JS, {"fonts": fonts or {}, "viewportOnly": viewport_only})
    resolve_images(page, ctx, tree, store)
    if reference:
        tree["reference"] = reference_tiles(page, store, full_page=not viewport_only)
    return tree


def launch(p, browser_path: str | None):
    kwargs = {"headless": True}
    if browser_path:
        kwargs["executable_path"] = browser_path
    try:
        return p.chromium.launch(**kwargs)
    except Exception as exc:  # noqa: BLE001
        if browser_path:
            raise
        log(f"No se encontró el Chromium de Playwright ({exc.__class__.__name__}); probando con Google Chrome instalado…")
        return p.chromium.launch(headless=True, channel="chrome")


def discover_links(page: Page, base_url: str) -> list[dict]:
    hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => [e.href, (e.innerText||e.getAttribute('aria-label')||'').trim()])")
    base = urlparse(base_url)
    seen, pages = set(), []
    for href, text in hrefs:
        u = urlparse(href)
        if u.netloc != base.netloc or u.scheme not in ("http", "https"):
            continue
        path = (u.path or "/") + (f"?{u.query}" if u.query else "") + (f"#{u.fragment}" if u.fragment.startswith("/") else "")
        if path in seen:
            continue
        seen.add(path)
        pages.append({"name": text.split("\n")[0][:40] or path, "path": path})
    if "/" not in seen:
        pages.insert(0, {"name": "Inicio", "path": "/"})
    return pages


# --------------------------------------------------------------------------- comandos
def cmd_inspect(args) -> None:
    with sync_playwright() as p:
        browser = launch(p, args.browser_path)
        page = browser.new_page(viewport={"width": args.width, "height": 900})
        page.goto(args.url)
        settle(page, 500)
        items = page.evaluate("""() => {
          const out = [];
          document.querySelectorAll('a, button, [role=tab], [role=link], [role=button]').forEach(el => {
            const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
            const t = (el.innerText || el.getAttribute('aria-label') || '').trim().split('\\n')[0];
            if (t) out.push({tag: el.tagName.toLowerCase(), text: t.slice(0, 50), href: el.getAttribute('href')});
          });
          return out;
        }""")
        browser.close()
    print("Elementos clicables encontrados (útiles para armar pages.json):\n")
    for it in items:
        href = f"  → {it['href']}" if it.get("href") else ""
        print(f"  [{it['tag']}] {it['text']}{href}")
    print('\nEjemplo de acción: {"click": "text=Contacto"}  o  {"click": "button:has-text(\'Contacto\')"}')


def load_config(args) -> dict:
    if args.config:
        cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    else:
        if not args.url:
            sys.exit("Indica --config pages.json o --url URL")
        cfg = {"base_url": args.url, "pages": [{"name": "Inicio", "path": "/"}]}
    if args.url:
        cfg["base_url"] = args.url
    cfg.setdefault("viewports", [{"name": "Desktop", "width": args.width, "height": 900}])
    cfg.setdefault("wait_ms", 800)
    return cfg


def cmd_extract(args) -> None:
    cfg = load_config(args)
    store = ImageStore()
    result = {"version": 1, "source": cfg["base_url"], "generated": time.strftime("%Y-%m-%d %H:%M"), "pages": []}
    with sync_playwright() as p:
        browser = launch(p, args.browser_path)
        if args.discover:
            pg = browser.new_page()
            pg.goto(cfg["base_url"])
            settle(pg, 300)
            cfg["pages"] = discover_links(pg, cfg["base_url"])
            pg.close()
            log(f"Rutas descubiertas: {', '.join(x['path'] for x in cfg['pages'])}")
        groups: dict[str, dict] = {}
        for spec in cfg["pages"]:
            group = spec.get("group", spec["name"])
            if group not in groups:
                groups[group] = {"name": group, "frames": []}
                result["pages"].append(groups[group])
            page_out = groups[group]
            frame_label = spec["name"] if spec["name"] == group else spec["name"]
            for vp in cfg["viewports"]:
                log(f"• {group}" + ("" if spec["name"] == group else f" › {spec['name']}") + f" [{vp['name']} {vp['width']}px]")
                ctx = browser.new_context(viewport={"width": vp["width"], "height": vp.get("height", 900)},
                                          device_scale_factor=1, reduced_motion="reduce",
                                          is_mobile=vp.get("mobile", False), has_touch=vp.get("mobile", False))
                page = ctx.new_page()
                try:
                    page.goto(urljoin(cfg["base_url"], spec.get("path", "/")))
                    settle(page, cfg["wait_ms"])
                    run_actions(page, spec.get("actions"))
                    if spec.get("viewport_only"):
                        page.wait_for_timeout(cfg["wait_ms"])
                    else:
                        settle(page, cfg["wait_ms"])
                    frame = capture_frame(page, ctx, store, reference=not args.no_reference, fonts=cfg.get("fonts"),
                                          viewport_only=bool(spec.get("viewport_only")))
                    multi_vp = len(cfg["viewports"]) > 1
                    frame["name"] = frame_label + (f" — {vp['name']}" if multi_vp else "")
                    page_out["frames"].append(frame)
                except Exception as exc:  # noqa: BLE001
                    log(f"    ! se omitió este estado: {exc.__class__.__name__}: {str(exc).splitlines()[0][:120]}")
                ctx.close()
        browser.close()
    result["images"] = store.images
    if not args.no_vector_text:
        log("Generando contornos vectoriales de los textos (respaldo para Figma sin fuentes)…")
        from textvec import vectorize_design
        log(f"  {vectorize_design(result, log)} textos vectorizados")
    out = Path(args.output)
    out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    n_nodes = sum(1 for pg in result["pages"] for fr in pg["frames"] for _ in iter_nodes(fr["children"]))
    log(f"\n✔ {out} — {len(result['pages'])} páginas, {n_nodes} capas, {len(store.images)} imágenes "
        f"({out.stat().st_size / 1e6:.1f} MB)")


def cmd_explore(args) -> None:
    from explore import explore
    cfg = load_config(args)
    states = explore(cfg, args.browser_path, log, max_depth=args.depth, workers=args.workers)
    out_cfg = {k: v for k, v in cfg.items() if k != "pages"}
    out_cfg["pages"] = states
    Path(args.output).write_text(json.dumps(out_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"✔ {args.output} — {len(states)} estados en {len({s.get('group', s['name']) for s in states})} pantallas. "
        f"Revísalo (puedes borrar estados que no quieras) y luego corre: extract --config {args.output}")


def cmd_vectorize(args) -> None:
    from textvec import vectorize_design
    path = Path(args.input)
    design = json.loads(path.read_text(encoding="utf-8"))
    n = vectorize_design(design, log)
    out = Path(args.output or args.input)
    out.write_text(json.dumps(design, ensure_ascii=False), encoding="utf-8")
    log(f"✔ {out} — {n} textos vectorizados ({out.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Figma Make → Figma Design (una página por pantalla)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--browser-path", help="Ruta a Chrome/Chromium si no usas el de Playwright")
    common.add_argument("--width", type=int, default=1440, help="Ancho del viewport (por defecto 1440)")

    i = sub.add_parser("inspect", parents=[common], help="Lista enlaces y botones para armar pages.json")
    i.add_argument("url")
    i.set_defaults(func=cmd_inspect)

    e = sub.add_parser("extract", parents=[common], help="Extrae las pantallas a design.json")
    e.add_argument("--config", help="Archivo pages.json")
    e.add_argument("--url", help="URL base (sobrescribe base_url del config)")
    e.add_argument("--discover", action="store_true", help="Descubre rutas siguiendo los <a href> del sitio")
    e.add_argument("--no-reference", action="store_true", help="No incluir la captura de referencia por pantalla")
    e.add_argument("--no-vector-text", action="store_true", help="No incluir contornos vectoriales de los textos")
    e.add_argument("-o", "--output", default="design.json")
    e.set_defaults(func=cmd_extract)

    x = sub.add_parser("explore", parents=[common], help="Descubre pestañas, menús y modales y genera un pages.json completo")
    x.add_argument("--config", required=True, help="pages.json con las pantallas base")
    x.add_argument("--url", help="URL base (sobrescribe base_url del config)")
    x.add_argument("--depth", type=int, default=2, help="Niveles de secciones a explorar (por defecto 2)")
    x.add_argument("--workers", type=int, default=4, help="Pantallas exploradas en paralelo (por defecto 4)")
    x.add_argument("-o", "--output", default="pages.full.json")
    x.set_defaults(func=cmd_explore)

    v = sub.add_parser("vectorize", help="Agrega contornos vectoriales de los textos a un design.json existente")
    v.add_argument("input")
    v.add_argument("-o", "--output", help="Archivo de salida (por defecto sobrescribe la entrada)")
    v.set_defaults(func=cmd_vectorize)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
