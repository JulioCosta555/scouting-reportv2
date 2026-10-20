# Scouting Report v2 — Cloudflare Pages

A fully static, client-side football scouting dashboard, converted from the
Quarto report `player_radar.qmd`. The browser loads CSVs and parquet directly
from the `scouting-data2` R2 bucket and renders everything with d3 — there is
**no server**. Cloudflare Pages just serves the static files.

## Structure

```
scouting-reportv2/
├── .gitignore
├── README.md
└── public/                 <- this is the build output directory
    ├── index.html
    ├── app.js              entry point
    ├── loader.js           compiles the OJS cells into the Observable runtime
    ├── cells.js            the dashboard cells (raw Observable JS, logic untouched)
    ├── css/
    │   └── style.css
    └── vendor/             vendored libraries (same-origin, edge-cached)
        ├── runtime.js
        ├── stdlib.js
        ├── parser.js
        └── inspector.css
```

The `vendor/` files are already committed here, so the repo is self-contained —
no build step, no npm. (See `public/vendor/README.md` if they ever need
refreshing.)

## Data layout

All data comes from the `scouting-data2` bucket. The base URL lives in **one
place**: the `data_base` cell at the top of `public/cells.js`.

| What                   | Where                             |
| ---------------------- | --------------------------------- |
| CSVs (9 files)         | `<data_base>/Info/<name>.csv`     |
| Event parquet (7 files)| `<data_base>/<name>.parquet`      |

CSVs: `proccessdata.csv`, `Id_keys.csv`, `Pos_breakdown_info.csv`,
`mapping_resolved.csv`, `logo_fix.csv`, `leagues_mapping.csv`,
`team_names.csv`, `league_coeff.csv`, `kits.csv`

Parquet: `Conmebol.parquet`, `Other8.parquet`, `Scandinavia.parquet`,
`2ndDiv.parquet`, `Asia.parquet`, `concacaf.parquet`, `EngPyramid.parquet`

### How the original `FileAttachment` calls still work

The qmd reads its data through `FileAttachment("data/x.csv")`. Rather than
rewrite 17 call sites, `cells.js` defines a `FileAttachment` cell that shadows
the Observable stdlib builtin and maps those paths onto the bucket. The cell
logic from the qmd is therefore **unchanged**.

The shim also does the loading work that keeps this fast:

- **One request per file.** Each URL is fetched once, whole, with a single
  `fetch()`. Nothing issues small ranged reads.
- **Cached by URL.** The resulting `ArrayBuffer` is memoised, so `.csv()`,
  `.text()` and `.arrayBuffer()` on the same file never go back to the network.

Event parquet is parsed in the browser by hyparquet (loaded from jsDelivr),
reading from that single cached buffer — the same "fetch the whole file once,
then work locally" shape as v1.

## Cloudflare Pages settings

In the Pages project (Settings → Builds & deployments):

| Setting                | Value     |
| ---------------------- | --------- |
| Framework preset       | None      |
| Build command          | *(empty)* |
| Build output directory | `public`  |

Pages serves `public/` directly. No Node, no Express, no Wrangler config needed.

## Local preview

```bash
npx serve public
# or
python3 -m http.server -d public 8000
```

Open the printed URL. (You can't just double-click `index.html` — ES modules
need to be served over http, not file://.)

## Data / CORS

Everything is fetched from the browser, so the **bucket's CORS policy must
allow `GET` and `HEAD` from your Pages domain** (e.g. `your-project.pages.dev`
and any custom domain). If the dashboard loads but charts stay empty, open the
console — a CORS error on the CSV/parquet requests is the usual cause.

A few images are also pulled from GitHub / jsDelivr (player cut-outs, club and
league badges); those repos are public, so they need no configuration.

## Editing

- Point at a different bucket → edit the `data_base` cell at the top of
  `public/cells.js`.
- Change a chart / metric → edit the relevant entry in `public/cells.js`
  (each array element is exactly one Observable cell; reactivity is inferred
  from the references inside it).
- Move a chart on the page → edit the `mounts` map in `public/loader.js` and
  the matching `<section>` in `public/index.html`.
- Restyle → `public/css/style.css`.

### Note on cells.js

Each entry in `cellSources` is exactly one cell, already split at build time
using the Observable parser to confirm every boundary. A line-based splitter
mis-reads this report's multi-line `` html`` `` templates, so `loader.js` does
no splitting at runtime — it compiles each entry as-is.
