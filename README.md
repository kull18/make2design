# make2design — Figma Make → Figma Design, una página por pantalla

Dos piezas:

| Pieza | Lenguaje | Qué hace |
|---|---|---|
| `extractor/make2design.py` | Python + Playwright | Abre tu app de Make, recorre cada pantalla y guarda el diseño en `design.json` |
| `figma-plugin/` | JS (plugin de Figma) | Lee `design.json` y crea **una página de Figma por pantalla**, con frames, textos, íconos SVG, imágenes, degradados, sombras y bordes editables |

¿Por qué son dos piezas? La REST API de Figma no permite crear capas. Solo un plugin puede escribir en un archivo.

---

## 1. Correr tu app de Figma Make en local

En Figma Make, descarga el código del proyecto (o expórtalo a GitHub) y luego:

```bash
npm install
npm run dev        # normalmente queda en http://localhost:5173
```

También funciona con la URL publicada de tu Make, si es pública.

## 2. Instalar el extractor

```bash
cd extractor
pip install -r requirements.txt
playwright install chromium
```

## 3. Saber cómo se navega tu app

Las apps de Make casi siempre cambian de pantalla **con estado de React** (`useState`), no con URLs. Por eso cada pantalla se describe con **acciones** (clics).

```bash
python make2design.py inspect http://localhost:5173
```

Esto lista los botones y enlaces visibles. Con eso armas tu `pages.json` (copia `pages.example.json`):

```json
{
  "base_url": "http://localhost:5173",
  "viewports": [
    { "name": "Desktop", "width": 1440, "height": 900 },
    { "name": "Móvil",   "width": 390,  "height": 844 }
  ],
  "pages": [
    { "name": "Inicio",   "path": "/" },
    { "name": "Mapa",     "path": "/", "actions": [{ "click": "nav >> text=Mapa" }] },
    { "name": "Contacto", "path": "/", "actions": [{ "click": "text=Contacto" }] }
  ]
}
```

- Cada elemento de `pages` se convierte en **una página de Figma**.
- Cada `viewport` se convierte en un frame dentro de esa página (Desktop y Móvil lado a lado). Si solo quieres desktop, deja uno.
- Acciones disponibles: `click`, `hover`, `fill` (+`value`), `press`, `goto`, `scroll`, `eval` (JS), y `wait` (ms) en cualquiera de ellas.
- Los selectores son de Playwright: `text=Algo`, `button:has-text('Algo')`, `#id`, `nav >> text=Algo`…
- `fonts` (opcional) define qué fuente de Figma usar cuando la app usa la fuente del sistema: `{"sans": "Inter", "mono": "JetBrains Mono"}`.
- Si tu app sí usa rutas (`<a href>`), puedes saltarte el config: `--url http://localhost:5173 --discover`.

## 3b. (Opcional) Descubrir pestañas, menús y modales automáticamente

```bash
python make2design.py explore --config pages.json -o pages.full.json
```

Parte de tus pantallas base y prueba cada botón desde un estado limpio. Si un botón abre un **modal**, cambia de **pestaña o sección**, o abre un **menú** (como "⋯") cuyas opciones abren modales, lo agrega como estado nuevo. Las pantallas se exploran en paralelo (`--workers 4`). Con `--depth` controlas cuántos niveles de secciones explora (por defecto 2).

Revisa `pages.full.json`: si hay estados que no quieres, borra su bloque. Luego usa ese archivo en el paso 4.

Cada estado lleva `"group"` con el nombre de su pantalla. En Figma todos los estados de una pantalla quedan en **la misma página**: la pantalla principal arriba y sus pestañas y modales en filas debajo. Los modales se capturan del tamaño de la ventana (`"viewport_only": true`).

## 4. Extraer

```bash
python make2design.py extract --config pages.json -o design.json
```

Opciones: `--no-reference` (no incluir capturas de comparación), `--width 1280`, `--browser-path` (para usar tu Chrome instalado).

## 5. Importar en Figma

1. Abre la **app de escritorio** de Figma (los plugins en desarrollo solo se importan ahí).
2. Abre o crea un archivo de **Figma Design** (no de Make).
3. Menú → **Plugins → Development → Import plugin from manifest…** → elige `figma-plugin/manifest.json`.
4. Ejecuta **Plugins → Development → Make → Design (páginas)**, arrastra `design.json` y dale a **Importar**.

Cada pantalla queda en su propia página. Al lado de cada frame aparece la captura original (**📸 Referencia**, bloqueada) para comparar. Cuando ya no la necesites, la borras.

> **Linux / Figma sin fuentes:** si tu Figma no deja a los plugins cargar fuentes, el plugin lo detecta y dibuja los textos como **vectores** (idénticos a la vista, pero no editables como texto). El `design.json` ya trae esos contornos. Si tienes un design.json viejo: `python make2design.py vectorize design.json`. También puedes forzarlo con la casilla "Textos como vectores".

> **Plan gratuito (Starter):** Figma limita el número de páginas por archivo. Si se llega al límite, el plugin pone las pantallas restantes como frames en la página actual y te avisa. También puedes desmarcar "Una página por pantalla".

---

## Qué se convierte y qué no

**Sí:** layout (posiciones exactas), colores (incluye `oklch` de Tailwind v4), degradados lineales (también en texto), bordes por lado, radios, sombras, blur de fondo, opacidad, tipografía (familia, peso, tamaño, interlineado, tracking, alineación, mayúsculas), íconos SVG (lucide) como vectores editables, imágenes (webp → png automáticamente), inputs con placeholder y z-index (headers fijos arriba).

**Limitaciones (v1):**
- Las capas usan **posición absoluta**, no Auto Layout. Es fiel visualmente, pero si quieres que sean responsivas en Figma tienes que aplicar Auto Layout tú (Shift+A sobre cada grupo).
- No se pasan interacciones ni prototipado, ni componentes o variantes.
- Los degradados radiales o cónicos se aproximan con su primer color.
- Si una fuente no está en Figma, se usa Inter (el plugin te dice cuál faltó).
- Los textos conservan los saltos de línea exactos del original (si editas un párrafo en Figma, ajusta los saltos a mano).
- La flechita nativa de los `<select>` no se copia (el navegador la dibuja fuera del DOM).
- El texto partido por etiquetas inline (`Hola <b>mundo</b>`) queda como capas de texto separadas.
