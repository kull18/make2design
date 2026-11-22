// Se inyecta en la página con Playwright. Recorre el DOM renderizado y devuelve
// un árbol de capas con coordenadas absolutas (px) listo para el plugin de Figma.
(opts) => {
  opts = opts || {};
  const FONT_MAP = Object.assign({ sans: "Inter", mono: null, serif: "Noto Serif" }, opts.fonts || {});
  if (!FONT_MAP.mono) {
    const loaded = document.fonts ? [...document.fonts].map((f) => f.family.replace(/["']/g, "")) : [];
    FONT_MAP.mono = loaded.find((f) => /mono/i.test(f)) || "Roboto Mono";
  }
  // ---------- Colores: cualquier formato CSS (rgb, oklch, color-mix...) -> RGBA 0..1
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const colorCache = new Map();
  function toRGBA(str) {
    if (!str || str === "transparent" || str === "none") return null;
    if (colorCache.has(str)) return colorCache.get(str);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = str;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    // ImageData no está premultiplicado: los canales ya son el color real
    const a = d[3] / 255;
    const c = a === 0 ? null : { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a };
    colorCache.set(str, c);
    return c;
  }
  const cssRgb = (c) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

  // Divide por comas de nivel superior (respeta paréntesis)
  function splitTop(str, sep = ",") {
    const out = []; let depth = 0, cur = "";
    for (const ch of str) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  const COLOR_RE = /(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:transparent|white|black|currentcolor)\b)/i;

  // ---------- Gradientes lineales
  function parseLinearGradient(str) {
    const m = str.match(/^(?:repeating-)?linear-gradient\((.*)\)$/s);
    if (!m) return null;
    const parts = splitTop(m[1]);
    let angle = 180; // CSS por defecto: hacia abajo
    const first = parts[0].replace(/\s+in\s+[a-z-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/i, "").trim();
    const dirs = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
      "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
      "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315 };
    let stopsParts = parts;
    if (first === "" || dirs[first] !== undefined || /^-?[\d.]+(deg|turn|rad|grad)$/.test(first)) {
      if (dirs[first] !== undefined) angle = dirs[first];
      else if (first.endsWith("turn")) angle = parseFloat(first) * 360;
      else if (first.endsWith("grad")) angle = parseFloat(first) * 0.9;
      else if (first.endsWith("rad")) angle = parseFloat(first) * 180 / Math.PI;
      else if (first.endsWith("deg")) angle = parseFloat(first);
      stopsParts = parts.slice(1);
    }
    const stops = [];
    stopsParts.forEach((p, i) => {
      const cm = p.match(COLOR_RE);
      if (!cm) return;
      const color = toRGBA(cm[0]) || { r: 0, g: 0, b: 0, a: 0 };
      const pm = p.replace(cm[0], "").match(/(-?[\d.]+)%/);
      const pos = pm ? parseFloat(pm[1]) / 100 : (stopsParts.length > 1 ? i / (stopsParts.length - 1) : 0);
      stops.push({ color, position: Math.max(0, Math.min(1, pos)) });
    });
    if (stops.length < 2) return null;
    return { type: "LINEAR", angle, stops };
  }

  // ---------- Sombras
  function parseShadows(str) {
    if (!str || str === "none") return [];
    const out = [];
    for (const s of splitTop(str)) {
      const cm = s.match(COLOR_RE);
      const color = cm ? toRGBA(cm[0]) : { r: 0, g: 0, b: 0, a: 1 };
      if (!color || color.a === 0) continue;
      const nums = s.replace(cm ? cm[0] : "", "").match(/-?[\d.]+px|-?[\d.]+(?=\s|$)/g) || [];
      const [x = 0, y = 0, blur = 0, spread = 0] = nums.map(parseFloat);
      out.push({ inset: /\binset\b/.test(s), color, x, y, blur, spread });
    }
    return out;
  }

  function px(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function radius(v, w, h) {
    if (!v) return 0;
    const first = v.split(" ")[0];
    const r = first.endsWith("%") ? parseFloat(first) / 100 * Math.min(w, h) : px(first);
    return Math.min(r, Math.min(w, h) / 2);
  }
  function fontFamily(ff) {
    const fams = ff.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    const low = fams.map((f) => f.toLowerCase());
    // Pilas de fuentes del sistema: en Figma se usa la equivalente configurada
    if (low.some((f) => /^(ui-monospace|sfmono-regular|sf mono|menlo|monaco|consolas)$/.test(f)) || low[0] === "monospace") return FONT_MAP.mono;
    if (low.some((f) => /^(-apple-system|blinkmacsystemfont|system-ui|ui-sans-serif)$/.test(f)) || low[0] === "sans-serif") return FONT_MAP.sans;
    if (low[0] === "serif" || low[0] === "ui-serif") return FONT_MAP.serif;
    const generic = /^(sans-serif|serif|monospace|cursive|fantasy|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji)$/i;
    return fams.find((f) => !generic.test(f)) || FONT_MAP.sans;
  }

  const sx = window.scrollX, sy = window.scrollY;
  const ROOT = [];
  let uid = 0;
  const box = (r) => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });

  function labelOf(el) {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute("aria-label") || el.getAttribute("alt") || el.id;
    return aria ? `${tag} · ${aria}`.slice(0, 60) : tag;
  }

  function frameStyle(el, cs, b) {
    const s = {};
    const bg = toRGBA(cs.backgroundColor);
    if (bg) s.fill = bg;
    const bi = cs.backgroundImage;
    const clipText = cs.webkitBackgroundClip === "text" || cs.backgroundClip === "text";
    if (bi && bi !== "none" && !clipText) {
      for (const layer of splitTop(bi).reverse()) {
        const g = parseLinearGradient(layer);
        if (g) { (s.gradients = s.gradients || []).push(g); continue; }
        const u = layer.match(/^url\(["']?(.*?)["']?\)$/);
        if (u) s.bgImage = { src: u[1], size: cs.backgroundSize };
        else if (/gradient\(/.test(layer)) { // radial/conic -> color promedio aproximado
          const cm = layer.match(COLOR_RE); const c = cm && toRGBA(cm[0]);
          if (c && !s.fill) s.fill = c;
        }
      }
    }
    const sides = ["Top", "Right", "Bottom", "Left"].map((k) => ({
      w: cs[`border${k}Style`] === "none" ? 0 : px(cs[`border${k}Width`]),
      c: toRGBA(cs[`border${k}Color`]),
    }));
    const visibleSide = sides.find((d) => d.w > 0 && d.c);
    if (visibleSide) {
      s.stroke = { color: visibleSide.c, top: sides[0].c ? sides[0].w : 0, right: sides[1].c ? sides[1].w : 0,
        bottom: sides[2].c ? sides[2].w : 0, left: sides[3].c ? sides[3].w : 0 };
    }
    const rr = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
      .map((v) => radius(v, b.w, b.h));
    if (rr.some((v) => v > 0)) s.radius = rr;
    const sh = parseShadows(cs.boxShadow);
    if (sh.length) s.shadows = sh;
    const op = parseFloat(cs.opacity);
    if (op < 1) s.opacity = op;
    const overflows = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    if (/(hidden|clip|auto|scroll)/.test(cs.overflow) && (s.fill || s.radius || s.bgImage || s.gradients || overflows)) s.clip = true;
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    const bm = bf && bf.match(/blur\(([\d.]+)px\)/);
    if (bm) s.backgroundBlur = parseFloat(bm[1]);
    return s;
  }

  function zOf(cs, inherited) {
    if (cs.position !== "static" && cs.zIndex !== "auto") return parseInt(cs.zIndex, 10) || 0;
    if (cs.position === "fixed" || cs.position === "sticky") return Math.max(inherited, 1);
    return inherited;
  }

  // Devuelve el texto con los saltos de línea tal como el navegador lo partió,
  // para que en Figma quede igual aunque la fuente mida distinto.
  function splitVisualLines(tn, cs) {
    const text = tn.textContent;
    const pre = /pre/.test(cs.whiteSpace);
    const rg = document.createRange();
    const out = [];
    let cur = "", lastTop = null;
    const tol = Math.max(2, px(cs.fontSize) * 0.4);
    for (let i = 0; i < text.length; i++) {
      rg.setStart(tn, i); rg.setEnd(tn, i + 1);
      const rc = rg.getClientRects()[0];
      if (!rc || (rc.width === 0 && /\s/.test(text[i]))) { cur += text[i]; continue; }
      if (lastTop !== null && Math.abs(rc.top - lastTop) > tol) { out.push(cur); cur = ""; }
      lastTop = rc.top;
      cur += text[i];
    }
    out.push(cur);
    const lines = out.map((l) => (pre ? l : l.replace(/\s+/g, " ").trim())).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
    return lines.length ? lines.join("\n") : null;
  }

  function textNode(tn, cs, z) {
    let raw = tn.textContent;
    if (!/pre/.test(cs.whiteSpace)) raw = raw.replace(/\s+/g, " ");
    if (!raw.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(tn);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    let r = range.getBoundingClientRect();
    // Texto truncado con "…" (clase truncate de Tailwind): solo se conserva lo visible
    let truncated = null;
    let host = null;
    for (let a = tn.parentElement, i = 0; a && i < 3; i++, a = a.parentElement) {
      const hcs = getComputedStyle(a);
      if (hcs.textOverflow === "ellipsis" && hcs.overflowX !== "visible") { host = a; break; }
    }
    if (host && host.scrollWidth > host.clientWidth + 1) {
      const hcs = getComputedStyle(host);
      const hr = host.getBoundingClientRect();
      const right = hr.right - px(hcs.paddingRight) - px(hcs.borderRightWidth);
      if (r.right > right + 1) {
        const limit = right - px(cs.fontSize) * 0.85;
        const full = tn.textContent;
        let lo = 0, hi = full.length;
        const sub = document.createRange();
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          sub.setStart(tn, 0); sub.setEnd(tn, mid);
          if (sub.getBoundingClientRect().right <= limit) lo = mid; else hi = mid - 1;
        }
        truncated = full.slice(0, Math.max(1, lo)).replace(/\s+$/, "") + "…";
        r = { left: r.left, top: r.top, width: Math.max(1, Math.min(r.width, right - r.left)), height: r.height };
      }
    }
    // Texto con degradado (bg-clip-text): el color suele ser transparent, el degradado puede venir de un ancestro
    let gradient = null;
    for (let a = tn.parentElement; a && !gradient; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if ((acs.webkitBackgroundClip === "text" || acs.backgroundClip === "text") && acs.backgroundImage !== "none") {
        gradient = parseLinearGradient(splitTop(acs.backgroundImage)[0]);
        if (!gradient) { // radial/cónico: se usa su primer color como sólido
          const cm = acs.backgroundImage.match(COLOR_RE); const c0 = cm && toRGBA(cm[0]);
          if (c0) gradient = { type: "LINEAR", angle: 90, stops: [{ color: c0, position: 0 }, { color: c0, position: 1 }] };
        }
        break;
      }
      if (a === document.body) break;
    }
    let color = toRGBA(cs.color);
    if (!color && !gradient) return null;
    if (!color) color = { r: 0, g: 0, b: 0, a: 1 };
    const fs = px(cs.fontSize);
    const lines = rects.reduce((acc, rc) => (acc.some((t) => Math.abs(t - rc.top) < 2) ? acc : [...acc, rc.top]), []).length;
    let chars = raw;
    if (truncated) chars = truncated.replace(/\s+/g, " ").trim();
    else if (lines === 1) chars = raw.trim();
    else chars = splitVisualLines(tn, cs) || raw.replace(/^\s+|\s+$/g, "");
    return {
      type: "TEXT", id: ++uid, z, ...box(r), characters: chars,
      font: { family: fontFamily(cs.fontFamily), weight: parseInt(cs.fontWeight, 10) || 400, italic: cs.fontStyle === "italic" },
      fontSize: fs,
      lineHeight: cs.lineHeight === "normal" ? null : px(cs.lineHeight),
      letterSpacing: cs.letterSpacing === "normal" ? 0 : px(cs.letterSpacing),
      color: gradient ? null : color, gradient,
      align: { start: "LEFT", left: "LEFT", center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" }[cs.textAlign] || "LEFT",
      textCase: { uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE" }[cs.textTransform] || "ORIGINAL",
      decoration: /underline/.test(cs.textDecorationLine) ? "UNDERLINE" : /line-through/.test(cs.textDecorationLine) ? "STRIKETHROUGH" : "NONE",
      lines, opacity: parseFloat(cs.opacity) < 1 ? parseFloat(cs.opacity) : undefined,
    };
  }

  function svgNode(el, cs, b, z) {
    const clone = el.cloneNode(true);
    const origAll = [el, ...el.querySelectorAll("*")];
    const cloneAll = [clone, ...clone.querySelectorAll("*")];
    origAll.forEach((o, i) => {
      const c = cloneAll[i];
      const ocs = getComputedStyle(o);
      for (const prop of ["fill", "stroke"]) {
        const v = ocs[prop];
        if (!v) continue;
        if (v === "none") c.setAttribute(prop, "none");
        else { const col = toRGBA(v); if (col) { c.setAttribute(prop, cssRgb(col)); if (col.a < 1) c.setAttribute(`${prop}-opacity`, col.a.toFixed(3)); } else c.setAttribute(prop, "none"); }
      }
      if (ocs.strokeWidth) c.setAttribute("stroke-width", ocs.strokeWidth.replace("px", ""));
      if (ocs.opacity && parseFloat(ocs.opacity) < 1) c.setAttribute("opacity", ocs.opacity);
      c.removeAttribute("class");
      c.removeAttribute("style");
    });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(b.w));
    clone.setAttribute("height", String(b.h));
    const col = toRGBA(cs.color);
    let markup = new XMLSerializer().serializeToString(clone);
    if (col) markup = markup.replace(/currentColor/gi, cssRgb(col));
    return { type: "SVG", id: ++uid, z, name: el.getAttribute("aria-label") || "icono", ...b, svg: markup };
  }

  function walk(el, out, zInherited) {
    if (el.nodeType !== 1) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return;
    if (parseFloat(cs.opacity) === 0) return;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "head", "meta", "link"].includes(tag)) return;
    const r = el.getBoundingClientRect();
    const b = box(r);
    const z = zOf(cs, zInherited);
    const visibleBox = b.w > 0.5 && b.h > 0.5;

    if (tag === "svg") { if (visibleBox) out.push(svgNode(el, cs, b, z)); return; }
    if (tag === "img" || tag === "picture" || tag === "video" || tag === "canvas") {
      const img = tag === "picture" ? el.querySelector("img") : el;
      if (visibleBox) {
        const marker = `f2d-${++uid}`;
        el.setAttribute("data-f2d", marker);
        out.push({ type: "IMAGE", id: uid, z, name: labelOf(el), ...b, marker,
          src: img && img.currentSrc ? img.currentSrc : (img && img.src) || (tag === "video" ? el.poster : null),
          fit: cs.objectFit || "fill", radius: frameStyle(el, cs, b).radius, opacity: parseFloat(cs.opacity) < 1 ? parseFloat(cs.opacity) : undefined });
      }
      return;
    }

    const style = visibleBox ? frameStyle(el, cs, b) : {};
    const isField = ["input", "textarea", "select"].includes(tag);
    const semantic = ["header", "nav", "main", "section", "footer", "aside", "form", "button", "article"].includes(tag);
    const makeFrame = visibleBox && (isField || semantic || style.fill || style.gradients || style.bgImage || style.stroke || style.shadows || style.opacity || style.clip || style.backgroundBlur);

    // Los elementos fijos (modales, overlays) flotan sobre toda la página en el navegador:
    // se suben al nivel principal para que en Figma no queden atrapados dentro de su contenedor.
    if (cs.position === "fixed" && out !== ROOT) out = ROOT;
    let target = out;
    if (makeFrame) {
      const node = { type: "FRAME", id: ++uid, z, name: labelOf(el), ...b, ...style, children: [] };
      if (style.bgImage) { node.marker = `f2d-${uid}`; el.setAttribute("data-f2d", node.marker); }
      out.push(node);
      target = node.children;
    }

    if (isField) {
      if (tag === "input" && ["checkbox", "radio"].includes(el.type)) return;
      const value = tag === "select" ? (el.options[el.selectedIndex] || {}).text : el.value;
      const text = value || el.placeholder || "";
      if (text) {
        const pl = px(cs.paddingLeft), pt = px(cs.paddingTop), pb = px(cs.paddingBottom);
        const color = value ? toRGBA(cs.color) : (toRGBA(getComputedStyle(el, "::placeholder").color) || toRGBA(cs.color));
        const fs = px(cs.fontSize);
        const lh = cs.lineHeight === "normal" ? fs * 1.25 : px(cs.lineHeight);
        target.push({ type: "TEXT", id: ++uid, z, x: b.x + pl, y: tag === "textarea" ? b.y + pt : b.y + (b.h - lh) / 2 + (pt - pb) / 2,
          w: Math.max(1, b.w - pl - px(cs.paddingRight)), h: lh, characters: text,
          font: { family: fontFamily(cs.fontFamily), weight: parseInt(cs.fontWeight, 10) || 400, italic: false },
          fontSize: fs, lineHeight: lh, letterSpacing: 0, color, align: "LEFT", textCase: "ORIGINAL", decoration: "NONE", lines: 1 });
      }
      return;
    }

    // Pseudo-elementos ::before/::after con fondo (decoraciones comunes)
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content && ps.content !== "none" && ps.display !== "none") {
        const pbg = toRGBA(ps.backgroundColor);
        const w = px(ps.width), h = px(ps.height);
        if (pbg && w > 0 && h > 0 && ps.position === "absolute") {
          const left = ps.left !== "auto" ? b.x + px(ps.left) : b.x + b.w - px(ps.right) - w;
          const top = ps.top !== "auto" ? b.y + px(ps.top) : b.y + b.h - px(ps.bottom) - h;
          target.push({ type: "FRAME", id: ++uid, z, name: pseudo, x: left, y: top, w, h, fill: pbg,
            radius: [ps.borderTopLeftRadius, ps.borderTopRightRadius, ps.borderBottomRightRadius, ps.borderBottomLeftRadius].map((v) => radius(v, w, h)), children: [] });
        }
      }
    }

    for (const child of el.childNodes) {
      if (child.nodeType === 3) { const t = textNode(child, cs, z); if (t) target.push(t); }
      else if (child.nodeType === 1) walk(child, target, z);
    }
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, target, z);
  }

  const doc = document.documentElement;
  const width = Math.max(doc.clientWidth, window.innerWidth);
  const height = opts.viewportOnly ? window.innerHeight
    : Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
  const bodyBg = toRGBA(getComputedStyle(document.body).backgroundColor) || toRGBA(getComputedStyle(doc).backgroundColor) || { r: 1, g: 1, b: 1, a: 1 };
  const children = ROOT;
  walk(document.body, children, 0);
  return { width, height, background: bodyBg, title: document.title, children };
}
