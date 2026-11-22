"""
explore — recorre la app automáticamente para encontrar pestañas/secciones, menús y modales.

Parte de las pantallas base del pages.json. En cada una prueba los botones visibles, uno por
uno y siempre desde un estado limpio (contexto nuevo), y clasifica lo que pasa:

  • modal   → aparece una capa fija que cubre la pantalla (o role="dialog")
  • menú    → aparece un menú pequeño con opciones; se prueban sus opciones (p. ej. "… → Reasignar")
  • sección → cambian los títulos visibles de la pantalla (pestañas, sub-vistas); se explora dentro
  • navegación a otra pantalla, o nada visible → se ignora

El resultado es un pages.json con todos los estados, agrupados por pantalla.
"""
from __future__ import annotations

import json
import re
import time
from urllib.parse import urljoin

HELPERS_JS = r"""
() => {
  const VW = innerWidth, VH = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
    return true;
  };
  const cssPath = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      let i = 1, s = el;
      while ((s = s.previousElementSibling)) i++;
      parts.unshift(`${el.tagName.toLowerCase()}:nth-child(${i})`);
      el = el.parentElement;
    }
    return "body > " + parts.join(" > ");
  };
  const labelOf = (el) => {
    const t = (el.innerText || "").trim().split("\n").map((x) => x.trim()).filter(Boolean)[0];
    if (t) return t.slice(0, 50);
    const a = el.getAttribute("aria-label") || el.getAttribute("title");
    if (a) return a.slice(0, 50);
    const svg = el.querySelector("svg[class*=lucide-]");
    const icon = svg && [...svg.classList].find((c) => c.startsWith("lucide-") && c !== "lucide-icon");
    return icon ? `ícono ${icon.replace("lucide-", "")}` : "";
  };
  const isFixedLayer = (el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") return null;
    const r = el.getBoundingClientRect();
    return { r, fixed: cs.position === "fixed" };
  };
  window.__f2d = {
    mark() { document.querySelectorAll("*").forEach((e) => e.setAttribute("data-f2d-seen", "1")); },
    signature() {
      const aside = document.querySelector("aside");
      const nav = aside ? [...aside.querySelectorAll("button, a")].map((b) => b.className).join("|") : "";
      const heads = [...document.querySelectorAll("h1, h2, h3, h4")]
        .filter((h) => visible(h) && !h.closest("aside") && !h.closest("[role=dialog]"))
        .map((h) => h.innerText.trim()).filter(Boolean);
      return { url: location.pathname + location.search + location.hash, nav, heads };
    },
    candidates() {
      const out = [], seen = new Set();
      const els = document.querySelectorAll("button, [role=tab], [role=button], a:not([href]), a[href='#']");
      for (const el of els) {
        if (el.closest("aside") || el.disabled || !visible(el)) continue;
        const label = labelOf(el);
        if (!label || /imprimir|descargar|exportar|guardar pdf|print/i.test(label)) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;        // filas repetidas: basta la primera
        seen.add(key);
        out.push({ path: cssPath(el), label });
      }
      return out;
    },
    newLayer() {
      // capas nuevas: modal grande o menú pequeño
      let modal = null, menu = null;
      for (const el of document.querySelectorAll("body *:not([data-f2d-seen])")) {
        if (!visible(el)) continue;
        const dialog = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
        const L = isFixedLayer(el);
        if (dialog || (L && L.fixed && L.r.width * L.r.height > VW * VH * 0.5)) {
          const root = dialog ? el : el;
          const h = root.querySelector("h1, h2, h3, h4, [id*=title]");
          const title = (h && h.innerText.trim()) || labelOf(root.querySelector("strong, b, p") || root) || "Modal";
          modal = { title: title.split("\n")[0].slice(0, 60) };
          break;
        }
        if (!menu && L && L.r.width * L.r.height < VW * VH * 0.25) {
          const items = [...el.querySelectorAll("button, [role=menuitem], a")].filter(visible);
          if (items.length >= 2) menu = { items: items.map((i) => ({ path: cssPath(i), label: labelOf(i) })).filter((i) => i.label) };
        }
      }
      return { modal, menu };
    },
  };
}
"""


def _fresh(browser, base_url, actions, viewport, wait_ms, run_actions):
    ctx = browser.new_context(viewport=viewport, device_scale_factor=1, reduced_motion="reduce")
    page = ctx.new_page()
    page.goto(base_url)
    page.wait_for_timeout(wait_ms)
    run_actions(page, actions)
    page.wait_for_timeout(250)
    page.evaluate(HELPERS_JS)
    return ctx, page


def _click(page, path) -> bool:
    loc = page.locator("css=" + path).first
    try:
        loc.click(timeout=2500)
    except Exception:  # noqa: BLE001
        try:
            loc.click(timeout=1500, force=True)
        except Exception:  # noqa: BLE001
            return False
    page.wait_for_timeout(450)
    return True


def explore_screen(browser, cfg: dict, base: dict, run_actions, log, max_depth: int = 2) -> list[dict]:
    """Explora una pantalla base. Cada estado lleva '_key' para quitar duplicados entre pantallas."""
    viewport = {"width": cfg["viewports"][0]["width"], "height": cfg["viewports"][0].get("height", 900)}
    wait_ms = 700
    group = base.get("group", base["name"])
    url = urljoin(cfg["base_url"], base.get("path", "/"))
    base_actions = base.get("actions", [])
    states: list[dict] = []
    seen_sigs: set[str] = set()
    seen_modals: set[str] = set()
    queue = [(base["name"], base_actions, max_depth)]
    first = True

    while queue:
        label_prefix, actions, depth = queue.pop(0)
        ctx, page = _fresh(browser, url, actions, viewport, wait_ms, run_actions)
        sig0 = page.evaluate("__f2d.signature()")
        seen_sigs.add("|".join(sig0["heads"]))
        cands = page.evaluate("__f2d.candidates()")
        ctx.close()
        if first:
            states.append({"name": base["name"], "group": group, "path": base.get("path", "/"),
                           "actions": base_actions, "_key": "S:" + "|".join(sig0["heads"])})
            first = False

        for c in cands:
            ctx, page = _fresh(browser, url, actions, viewport, wait_ms, run_actions)
            page.evaluate("__f2d.mark()")
            before = page.evaluate("__f2d.signature()")
            if not _click(page, c["path"]):
                ctx.close()
                continue
            after = page.evaluate("__f2d.signature()")
            layer = page.evaluate("__f2d.newLayer()")
            step = {"click": "css=" + c["path"], "label": c["label"]}

            if after["url"] != before["url"] or after["nav"] != before["nav"]:
                pass  # navegó a otra pantalla: ya se captura como pantalla base
            elif layer["modal"]:
                key = layer["modal"]["title"].lower()
                if key not in seen_modals:
                    seen_modals.add(key)
                    name = f"{_short(label_prefix, base['name'])}Modal: {layer['modal']['title']}"
                    states.append({"name": name, "group": group, "path": base.get("path", "/"),
                                   "actions": actions + [step], "viewport_only": True, "_key": "M:" + group + "|" + key})
            elif layer["menu"]:
                for item in layer["menu"]["items"][:8]:
                    ctx2, p2 = _fresh(browser, url, actions, viewport, wait_ms, run_actions)
                    if _click(p2, c["path"]):
                        p2.evaluate("__f2d.mark()")
                        b2 = p2.evaluate("__f2d.signature()")
                        if _click(p2, item["path"]):
                            a2 = p2.evaluate("__f2d.signature()")
                            l2 = p2.evaluate("__f2d.newLayer()")
                            if l2["modal"] and a2["nav"] == b2["nav"]:
                                key = l2["modal"]["title"].lower()
                                if key not in seen_modals:
                                    seen_modals.add(key)
                                    name = f"{_short(label_prefix, base['name'])}Menú › {item['label']} › Modal: {l2['modal']['title']}"
                                    states.append({"name": name, "group": group, "path": base.get("path", "/"),
                                                   "actions": actions + [step, {"click": "css=" + item["path"], "label": item["label"]}],
                                                   "viewport_only": True, "_key": "M:" + group + "|" + key})
                    ctx2.close()
            elif depth > 0:
                new_heads = [h for h in after["heads"] if h not in before["heads"]]
                sig = "|".join(after["heads"])
                if new_heads and sig not in seen_sigs:
                    seen_sigs.add(sig)
                    name = f"{_short(label_prefix, base['name'])}{re.sub(r'\s*\(\d+\)$', '', c['label'])}"
                    states.append({"name": name, "group": group, "path": base.get("path", "/"),
                                   "actions": actions + [step], "_key": "S:" + sig})
                    queue.append((name, actions + [step], depth - 1))
            ctx.close()
    log(f"  ✓ {base['name']}: {len(states)} estados")
    return states


def _worker(job):
    cfg, base, browser_path, depth = job
    from playwright.sync_api import sync_playwright
    import make2design as m
    with sync_playwright() as p:
        browser = m.launch(p, browser_path)
        try:
            return explore_screen(browser, cfg, base, m.run_actions, m.log, depth)
        finally:
            browser.close()


def dedupe(per_screen: list[list[dict]]) -> list[dict]:
    """Quita estados repetidos entre pantallas (p. ej. 'Volver al directorio' = otra pantalla)."""
    seen: set[str] = set()
    out: list[dict] = []
    # las pantallas base se registran primero para que una sección igual a otra pantalla se descarte
    for states in per_screen:
        if states:
            seen.add(states[0]["_key"])
    for states in per_screen:
        dropped: list[list] = []
        for i, st in enumerate(states):
            is_desc = any(st["actions"][:len(d)] == d for d in dropped)
            if i > 0 and (is_desc or st["_key"] in seen):
                if st["_key"].startswith("S:"):
                    dropped.append(st["actions"])
                continue
            seen.add(st["_key"])
            out.append({k: v for k, v in st.items() if k != "_key"})
    return out


def explore(cfg: dict, browser_path: str | None, log, max_depth: int = 2, workers: int = 4) -> list[dict]:
    from concurrent.futures import ProcessPoolExecutor
    t0 = time.time()
    jobs = [(cfg, base, browser_path, max_depth) for base in cfg["pages"]]
    log(f"Explorando {len(jobs)} pantallas ({workers} en paralelo)…")
    with ProcessPoolExecutor(max_workers=workers) as pool:
        per_screen = list(pool.map(_worker, jobs))
    states = dedupe(per_screen)
    log(f"Exploración terminada en {time.time() - t0:.0f} s: {len(states)} estados.")
    return states


def _short(prefix: str, base_name: str) -> str:
    """Nombre relativo a la pantalla (el grupo ya lleva el nombre de la pantalla)."""
    if prefix == base_name:
        return ""
    rest = prefix[len(base_name) + 3:] if prefix.startswith(base_name + " › ") else prefix
    return rest + " › "
