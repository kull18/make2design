// Plugin "Make → Design (páginas)": dibuja design.json en Figma Design.
// Escrito en JS simple (sin build, sin ?. ni spread de objetos) para que corra tal cual.

figma.showUI(__html__, { width: 360, height: 440, themeColors: true });

var IMAGES = {};
var TEXT_MODE = "text"; // "text" | "vector"
var VECTORS = {};
var imageHashCache = {};
var fontIndex = null;
var fontCache = {};
var stats = { nodes: 0, svgFail: 0, fontFallback: {}, errors: 0, firstError: null };

function progress(text) { figma.ui.postMessage({ type: "progress", text: text }); }

// ------------------------------------------------------------------ fuentes
function styleWeight(style) {
  var s = style.toLowerCase().replace(/[-_]/g, " ");
  if (/thin|hairline/.test(s)) return 100;
  if (/extra ?light|ultra ?light/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/semi ?bold|demi ?bold/.test(s)) return 600;
  if (/extra ?bold|ultra ?bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}

async function buildFontIndex() {
  fontIndex = {};
  var list = [];
  try { list = (await figma.listAvailableFontsAsync()) || []; } catch (e) { list = []; }
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var fn = item && (item.fontName || item);
    if (!fn || typeof fn.family !== "string" || typeof fn.style !== "string") continue;
    var key = fn.family.toLowerCase();
    if (!fontIndex[key]) fontIndex[key] = [];
    fontIndex[key].push({ fontName: { family: fn.family, style: fn.style }, weight: styleWeight(fn.style), italic: /italic|oblique/i.test(fn.style) });
  }
}

var STYLE_NAMES = {
  100: ["Thin", "Hairline"], 200: ["Extra Light", "ExtraLight", "Ultra Light"], 300: ["Light"],
  400: ["Regular", "Normal", "Book"], 500: ["Medium"], 600: ["Semi Bold", "SemiBold", "Demi Bold"],
  700: ["Bold"], 800: ["Extra Bold", "ExtraBold", "Ultra Bold"], 900: ["Black", "Heavy"]
};

function candidatesFor(family, weight, italic) {
  var out = [];
  var key = (family || "").toLowerCase();
  var options = fontIndex[key];
  if (options && options.length) {
    var sorted = options.slice().sort(function (a, b) {
      return (Math.abs(a.weight - weight) + (a.italic === !!italic ? 0 : 1000)) -
             (Math.abs(b.weight - weight) + (b.italic === !!italic ? 0 : 1000));
    });
    for (var i = 0; i < Math.min(3, sorted.length); i++) out.push(sorted[i].fontName);
  } else if (family) {
    // Sin lista disponible: se prueban nombres de estilo habituales
    var w = Math.min(900, Math.max(100, Math.round((weight || 400) / 100) * 100));
    var names = (STYLE_NAMES[w] || []).concat(STYLE_NAMES[400]);
    for (var j = 0; j < names.length; j++) {
      var st = names[j];
      if (italic) out.push({ family: family, style: st === "Regular" ? "Italic" : st + " Italic" });
      out.push({ family: family, style: st });
    }
  }
  return out;
}

async function loadFont(spec) {
  spec = spec || {};
  var family = spec.family || "Inter", weight = spec.weight || 400, italic = !!spec.italic;
  var key = family + "|" + weight + "|" + italic;
  if (fontCache[key]) return fontCache[key];
  var tries = candidatesFor(family, weight, italic);
  if (family !== "Inter") { stats.fontFallbackTry = true; tries = tries.concat(candidatesFor("Inter", weight, italic)); }
  tries.push({ family: "Inter", style: "Regular" }, { family: "Roboto", style: "Regular" });
  var anyKey = Object.keys(fontIndex)[0];
  if (anyKey) tries.push(fontIndex[anyKey][0].fontName);
  for (var i = 0; i < tries.length; i++) {
    try {
      await figma.loadFontAsync(tries[i]);
      if (tries[i].family.toLowerCase() !== family.toLowerCase()) stats.fontFallback[family] = true;
      fontCache[key] = tries[i];
      return tries[i];
    } catch (e) { stats.lastFontError = tries[i].family + " " + tries[i].style + " → " + (e && e.message ? e.message : String(e)); }
  }
  throw new Error("No se pudo cargar ninguna fuente (ni " + family + " ni Inter). Último error: " + stats.lastFontError);
}

// ------------------------------------------------------------------ pinturas
function solid(c) {
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a === undefined ? 1 : c.a };
}

function gradientPaint(g) {
  // CSS: 0deg = hacia arriba, 90deg = hacia la derecha. Figma: identidad = izquierda→derecha.
  var phi = (g.angle - 90) * Math.PI / 180;
  var c = Math.cos(phi), s = Math.sin(phi);
  return {
    type: "GRADIENT_LINEAR",
    gradientTransform: [
      [c, s, 0.5 - 0.5 * c - 0.5 * s],
      [-s, c, 0.5 + 0.5 * s - 0.5 * c]
    ],
    gradientStops: (g.stops || []).map(function (st) {
      return { position: st.position, color: { r: st.color.r, g: st.color.g, b: st.color.b, a: st.color.a } };
    })
  };
}

function imageHash(ref) {
  if (!ref || !IMAGES[ref]) return null;
  if (imageHashCache[ref]) return imageHashCache[ref];
  try {
    var img = figma.createImage(figma.base64Decode(IMAGES[ref]));
    imageHashCache[ref] = img.hash;
    return img.hash;
  } catch (e) { return null; }
}

function imagePaint(ref, fit) {
  var h = imageHash(ref);
  if (!h) return null;
  return { type: "IMAGE", imageHash: h, scaleMode: fit === "contain" ? "FIT" : "FILL" };
}

function applyRadius(node, r) {
  if (!r) return;
  if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) { node.cornerRadius = r[0]; return; }
  node.topLeftRadius = r[0]; node.topRightRadius = r[1];
  node.bottomRightRadius = r[2]; node.bottomLeftRadius = r[3];
}

function effectsOf(n) {
  var fx = [];
  (n.shadows || []).forEach(function (s) {
    fx.push({
      type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      offset: { x: s.x, y: s.y }, radius: Math.max(0, s.blur), spread: s.spread,
      visible: true, blendMode: "NORMAL"
    });
  });
  if (n.backgroundBlur) fx.push({ type: "BACKGROUND_BLUR", radius: n.backgroundBlur, visible: true });
  return fx;
}

function size(node, w, h) { node.resize(Math.max(0.01, w), Math.max(0.01, h)); }

function sortByZ(children) {
  return children.map(function (c, i) { return { c: c, i: i }; })
    .sort(function (a, b) { return ((a.c.z || 0) - (b.c.z || 0)) || (a.i - b.i); })
    .map(function (o) { return o.c; });
}

// ------------------------------------------------------------------ nodos
async function buildNode(n, parent, origin) {
  try { return await buildNodeUnsafe(n, parent, origin); }
  catch (e) {
    stats.errors++;
    if (!stats.firstError) stats.firstError = (n && n.type) + (n && n.characters ? ' "' + String(n.characters).slice(0, 30) + '"' : '') + ': ' + (e && e.message ? e.message : e);
    return null;
  }
}

async function buildNodeUnsafe(n, parent, origin) {
  stats.nodes++;
  if (stats.nodes % 150 === 0) { progress("Creando capas… " + stats.nodes); await new Promise(function (r) { setTimeout(r, 0); }); }
  var rx = n.x - origin.x, ry = n.y - origin.y;

  if (n.type === "FRAME") {
    var f = figma.createFrame();
    f.name = n.name || "frame";
    size(f, n.w, n.h);
    f.x = rx; f.y = ry;
    var fills = [];
    if (n.fill) fills.push(solid(n.fill));
    (n.gradients || []).forEach(function (g) { fills.push(gradientPaint(g)); });
    if (n.bgImage && n.bgImage.imageRef) {
      var ip = imagePaint(n.bgImage.imageRef, n.bgImage.size === "contain" ? "contain" : "cover");
      if (ip) fills.push(ip);
    }
    f.fills = fills;
    f.clipsContent = !!n.clip;
    applyRadius(f, n.radius);
    if (n.stroke) {
      f.strokes = [solid(n.stroke.color)];
      f.strokeAlign = "INSIDE";
      var s = n.stroke;
      if (s.top === s.right && s.right === s.bottom && s.bottom === s.left) f.strokeWeight = s.top;
      else { f.strokeTopWeight = s.top; f.strokeRightWeight = s.right; f.strokeBottomWeight = s.bottom; f.strokeLeftWeight = s.left; }
    }
    var fx = effectsOf(n);
    if (fx.length) f.effects = fx;
    if (n.opacity !== undefined) f.opacity = n.opacity;
    parent.appendChild(f);
    var kids = sortByZ(n.children || []);
    for (var i = 0; i < kids.length; i++) await buildNode(kids[i], f, n);
    return f;
  }

  if (n.type === "TEXT" && TEXT_MODE === "vector") {
    if (!n.vector) throw new Error("este texto no tiene contorno vectorial");
    var svgText = n.vector.svg || (VECTORS && VECTORS[n.vector.ref]);
    if (!svgText) throw new Error("contorno vectorial no encontrado");
    var holder = figma.createNodeFromSvg(svgText);
    parent.appendChild(holder);
    holder.x = rx; holder.y = ry;               // la caja del SVG empieza donde empezaba el texto
    holder.fills = []; holder.clipsContent = false;
    var label = String(n.characters || "texto").replace(/\s+/g, " ").slice(0, 60);
    var vnode = holder;
    try {
      // Un solo vector por texto: más limpio en el panel de capas
      if (holder.children && holder.children.length) {
        var flat = figma.flatten(holder.children.slice(), holder);
        var ax = holder.x + flat.x, ay = holder.y + flat.y;
        parent.appendChild(flat);
        flat.x = ax; flat.y = ay;
        holder.remove();
        vnode = flat;
      }
    } catch (e) { vnode = holder; }
    vnode.name = label;
    if (n.opacity !== undefined) vnode.opacity = n.opacity;
    return vnode;
  }

  if (n.type === "TEXT") {
    var font = await loadFont(n.font);
    var t = figma.createText();
    try {
      t.fontName = font;
      t.characters = String(n.characters || "");
    } catch (e) { t.remove(); throw e; }
    t.fontSize = Math.max(1, n.fontSize);
    if (n.lineHeight) t.lineHeight = { unit: "PIXELS", value: n.lineHeight };
    if (n.letterSpacing) t.letterSpacing = { unit: "PIXELS", value: n.letterSpacing };
    t.fills = n.gradient ? [gradientPaint(n.gradient)] : [solid(n.color || { r: 0, g: 0, b: 0, a: 1 })];
    t.textAlignHorizontal = n.align || "LEFT";
    t.textCase = n.textCase || "ORIGINAL";
    t.textDecoration = n.decoration || "NONE";
    if (n.opacity !== undefined) t.opacity = n.opacity;
    parent.appendChild(t);
    if (!(n.lines > 1) || String(n.characters || "").indexOf("\n") !== -1) {
      // Una línea o saltos ya fijados: ancho automático y se reubica según la alineación,
      // así el texto conserva exactamente los renglones del original
      t.textAutoResize = "WIDTH_AND_HEIGHT";
      var dx = n.align === "CENTER" ? (n.w - t.width) / 2 : n.align === "RIGHT" ? n.w - t.width : 0;
      t.x = rx + dx; t.y = ry;
    } else {
      t.resize(Math.max(1, n.w + 2), Math.max(1, n.h));
      t.textAutoResize = "HEIGHT";
      t.x = rx; t.y = ry;
    }
    return t;
  }

  if (n.type === "SVG") {
    try {
      var v = figma.createNodeFromSvg(n.svg);
      v.name = n.name || "icono";
      parent.appendChild(v);
      if (Math.abs(v.width - n.w) > 0.5 || Math.abs(v.height - n.h) > 0.5) v.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
      v.x = rx; v.y = ry;
      return v;
    } catch (e) {
      stats.svgFail++;
      n = Object.assign({}, n, { type: "IMAGE", imageRef: null, name: "svg (no se pudo convertir)" });
    }
  }

  if (n.type === "IMAGE") {
    var r = figma.createRectangle();
    r.name = n.name || "imagen";
    size(r, n.w, n.h);
    r.x = rx; r.y = ry;
    var p = imagePaint(n.imageRef, n.fit);
    r.fills = p ? [p] : [solid({ r: 0.85, g: 0.86, b: 0.88, a: 1 })];
    if (!p) r.name += " (sin imagen)";
    applyRadius(r, n.radius);
    if (n.opacity !== undefined) r.opacity = n.opacity;
    parent.appendChild(r);
    return r;
  }
}

async function buildReference(fr, page, x, y) {
  var g = figma.createFrame();
  g.name = "📸 Referencia — " + fr.name;
  size(g, fr.width, fr.height);
  g.x = x; g.y = y;
  g.fills = [];
  (fr.reference || []).forEach(function (tile) {
    var p = imagePaint(tile.imageRef, "cover");
    if (!p) return;
    var r = figma.createRectangle();
    r.name = "captura y=" + tile.y;
    size(r, tile.w || fr.width, tile.h || fr.height);
    r.y = tile.y;
    r.fills = [p];
    g.appendChild(r);
  });
  g.locked = true;
  page.appendChild(g);
  return g;
}


// Comprueba que Figma deje cargar fuentes antes de crear nada
async function fontSelfTest() {
  var report = [];
  var count = Object.keys(fontIndex).length;
  report.push("Familias disponibles para el plugin: " + count + (count ? " (ej. " + Object.keys(fontIndex).slice(0, 4).join(", ") + ")" : ""));
  var probe = figma.createText();
  var def = probe.fontName;
  probe.remove();
  var tries = [];
  if (def && typeof def === "object" && def.family) tries.push(def);
  tries.push({ family: "Inter", style: "Regular" }, { family: "Roboto", style: "Regular" });
  var anyKey = Object.keys(fontIndex)[0];
  if (anyKey) tries.push(fontIndex[anyKey][0].fontName);
  for (var i = 0; i < tries.length; i++) {
    try { await figma.loadFontAsync(tries[i]); report.push("OK: " + tries[i].family + " " + tries[i].style); return { ok: true, report: report }; }
    catch (e) { report.push("Falla " + tries[i].family + " " + tries[i].style + ": " + (e && e.message ? e.message : String(e))); }
  }
  return { ok: false, report: report };
}

// ------------------------------------------------------------------ importación
async function run(data, options) {
  IMAGES = data.images || {};
  VECTORS = data.vectors || {};
  stats = { nodes: 0, svgFail: 0, fontFallback: {}, errors: 0, firstError: null };
  progress("Leyendo fuentes disponibles…");
  await buildFontIndex();
  var test = await fontSelfTest();
  var hasVectors = !!data.vectorText;
  TEXT_MODE = "text";
  if (options.vectorText && hasVectors) TEXT_MODE = "vector";
  if (!test.ok) {
    if (!hasVectors) {
      figma.ui.postMessage({ type: "error", text: "⚠ Figma no permitió cargar ninguna fuente y este design.json no trae textos vectoriales, así que no se importó nada.\n" +
        "Genera el archivo de nuevo con la versión actual de make2design.py (o corre: python make2design.py vectorize design.json).\n\n" + test.report.join("\n") });
      return;
    }
    TEXT_MODE = "vector";
  }

  var startPage = figma.currentPage;
  var firstPage = null, firstFrame = null, pagesCreated = 0, pageLimitHit = false;
  var cursorX = 0;
  // En modo "todo en una página", colocar a la derecha de lo que ya exista
  if (!options.pages) {
    startPage.children.forEach(function (c) { cursorX = Math.max(cursorX, c.x + c.width + 400); });
  }

  for (var p = 0; p < data.pages.length; p++) {
    var pg = data.pages[p];
    var target = startPage;
    if (options.pages && !pageLimitHit) {
      try { target = figma.createPage(); target.name = pg.name; pagesCreated++; }
      catch (e) { pageLimitHit = true; target = startPage; }
    }
    if (!firstPage) firstPage = target;
    // Cuadrícula: la pantalla principal arriba; sus pestañas y modales en filas debajo
    var originX = target === startPage ? cursorX : 0;
    var perRow = options.reference ? 2 : 3;
    var x = originX, y = 0, rowH = 0, col = 0, blockW = 0;
    for (var k = 0; k < pg.frames.length; k++) {
      var fr = pg.frames[k];
      var withRef = options.reference && fr.reference && fr.reference.length;
      if (k === 1 || (k > 1 && col >= perRow)) { y += rowH + 400; x = originX; rowH = 0; col = 0; }
      progress("Pantalla " + (p + 1) + "/" + data.pages.length + " · " + (k + 1) + "/" + pg.frames.length + ": " + fr.name);
      var root = figma.createFrame();
      root.name = fr.name;
      size(root, fr.width, fr.height);
      root.x = x; root.y = y;
      root.fills = [solid(fr.background)];
      root.clipsContent = true;
      target.appendChild(root);
      var kids = sortByZ(fr.children || []);
      for (var i = 0; i < kids.length; i++) await buildNode(kids[i], root, { x: 0, y: 0 });
      if (!firstFrame) firstFrame = root;
      x += fr.width + 120;
      if (withRef) {
        await buildReference(fr, target, x, y);
        x += fr.width + 120;
      }
      x += 200;
      col++;
      rowH = Math.max(rowH, fr.height);
      blockW = Math.max(blockW, x - originX);
    }
    if (target === startPage) cursorX = originX + blockW + 600;
  }

  if (firstPage && firstPage !== figma.currentPage) await figma.setCurrentPageAsync(firstPage);
  if (firstFrame) figma.viewport.scrollAndZoomIntoView([firstFrame]);

  var msg = "Listo: " + data.pages.length + " pantallas, " + stats.nodes + " capas" +
    (TEXT_MODE === "vector" ? " (textos como vectores" + (test.ok ? ")" : ": tu Figma no da fuentes a los plugins)") : "") +
    (options.pages ? ", " + pagesCreated + " páginas nuevas" : "") + ".";
  if (pageLimitHit) msg += "\n⚠ Tu plan no permitió crear más páginas; las restantes quedaron como frames en la página actual.";
  var missing = TEXT_MODE === "vector" ? [] : Object.keys(stats.fontFallback);
  if (missing.length) msg += "\nFuentes no encontradas (se usó Inter): " + missing.join(", ");
  if (stats.svgFail) msg += "\n" + stats.svgFail + " íconos SVG no se pudieron convertir.";
  if (stats.errors) msg += "\n⚠ " + stats.errors + " capas se omitieron por error. Primero: " + stats.firstError;
  figma.notify(msg.split("\n")[0]);
  figma.ui.postMessage({ type: "done", text: msg });
}

figma.ui.onmessage = function (msg) {
  if (msg.type !== "import") return;
  run(msg.data, msg.options).catch(function (e) {
    figma.ui.postMessage({ type: "error", text: "Error: " + (e && e.message ? e.message : e) + (e && e.stack ? "\n" + String(e.stack).split("\n").slice(0, 4).join("\n") : "") });
  });
};
