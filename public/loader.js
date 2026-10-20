// loader.js
// Compiles the raw Observable cells (cells.js) and runs them inside the
// Observable runtime, wiring named cells to DOM mount points.
//
// Libraries are loaded LOCALLY from /vendor (same-origin, edge-cached by
// Cloudflare) instead of a third-party CDN — faster first paint and no
// external runtime dependency. See vendor/README for how the files get there.

import { Runtime, Inspector } from "/vendor/runtime.js";
import { Library } from "/vendor/stdlib.js";
import { parseCell } from "/vendor/parser.js";
import { cellSources } from "/cells.js";

// ---------------------------------------------------------------------------
// Compile one Observable cell source string into a runtime definition.
// No cell logic is rewritten — we parse it, extract references + body, and
// define it in the runtime exactly as the original Quarto OJS runtime did.
// ---------------------------------------------------------------------------
function compileCell(source) {
  let ast;
  try {
    ast = parseCell(source);
  } catch (err) {
    console.error("PARSE FAILED on this cell:\n", source);
    throw err;
  }

  let name = null;
  let isViewof = false;
  let isMutable = false;
  if (ast.id) {
    if (ast.id.type === "ViewExpression") {
      isViewof = true;
      name = ast.id.id.name;
    } else if (ast.id.type === "MutableExpression") {
      isMutable = true;
      name = ast.id.id.name;
    } else if (ast.id.type === "Identifier") {
      name = ast.id.name;
    }
  }

  const inputs = (ast.references || []).map((r) => {
    if (r.type === "ViewExpression") return "viewof " + r.id.name;
    if (r.type === "MutableExpression") return "mutable " + r.id.name;
    return r.name;
  });

  // Map each input to a safe local identifier used inside the function.
  // Plain refs keep their name; viewof/mutable refs (which contain a space)
  // get a safe alias like "$view_radar_player" / "$mut_count".
  const localName = (inp) => {
    if (inp.startsWith("viewof ")) return "$view_" + inp.slice(7);
    if (inp.startsWith("mutable ")) return "$mut_" + inp.slice(8);
    return inp;
  };
  const params = inputs.map(localName);

  // Rewrite the body so any `viewof x` / `mutable x` reference text becomes its
  // safe alias. We use the parser's exact offsets so we never touch unrelated
  // text. References are processed right-to-left to keep offsets valid.
  const bodyStart = ast.body.start;
  let bodyText = source.slice(bodyStart, ast.body.end);
  const special = (ast.references || [])
    .filter((r) => r.type === "ViewExpression" || r.type === "MutableExpression")
    .map((r) => ({
      start: r.start - bodyStart,
      end: r.end - bodyStart,
      alias:
        r.type === "ViewExpression"
          ? "$view_" + r.id.name
          : "$mut_" + r.id.name,
    }))
    .sort((a, b) => b.start - a.start);
  for (const ref of special) {
    bodyText =
      bodyText.slice(0, ref.start) + ref.alias + bodyText.slice(ref.end);
  }

  const async = ast.async;
  const generator = ast.generator;

  const isBlock = ast.body.type === "BlockStatement";

  // Block body: run it as an inner IIFE so its own `const`s get a fresh scope,
  // separate from the parameters. Expression body: just return it.
  const inner = isBlock
    ? `return (${async ? "async " : ""}${generator ? "function*" : "function"} ()${bodyText})();`
    : `return (${bodyText});`;

  const fnBody = inner;

  let definition;
  try {
    if (async && generator) {
      const C = Object.getPrototypeOf(async function* () {}).constructor;
      definition = new C(...params, fnBody);
    } else if (async) {
      const C = Object.getPrototypeOf(async function () {}).constructor;
      definition = new C(...params, fnBody);
    } else if (generator) {
      const C = Object.getPrototypeOf(function* () {}).constructor;
      definition = new C(...params, fnBody);
    } else {
      definition = new Function(...params, fnBody);
    }
  } catch (err) {
    console.error("Failed to compile cell:", name || "(anonymous)", err);
    console.error(source);
    throw err;
  }

  return { name, isViewof, isMutable, inputs, definition };
}

// ---------------------------------------------------------------------------
// cells.js already holds exactly ONE cell per entry: the qmd is split at build
// time using the Observable parser itself to confirm each boundary, because a
// line-based splitter mis-reads the multi-line html`` templates this report is
// full of. There is therefore nothing to split here at runtime.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Define every cell in the runtime and mount the top-level UI cells.
// ---------------------------------------------------------------------------
export async function boot() {
  const library = new Library();
  const runtime = new Runtime(library);
  const main = runtime.module();

  const mounts = {
    scout_controls_bar: "#controls",
    scout_dashboard: "#dashboard",
    DashboardDownloader: "#downloads",
  };

  // One cell per entry (pre-split at build time) — just compile each.
  const compiled = cellSources.map(compileCell);

  for (const cell of compiled) {
    const { name, isViewof, isMutable, inputs, definition } = cell;

    if (isViewof) {
      main.variable().define("viewof " + name, inputs, definition);
      main
        .variable()
        .define(name, ["viewof " + name], (view) =>
          library.Generators.input(view)
        );
      continue;
    }

    if (isMutable) {
      main.variable().define("initial " + name, inputs, definition);
      main
        .variable()
        .define("mutable " + name, ["initial " + name], (init) =>
          new library.Mutable(init)
        );
      main.variable().define(name, ["mutable " + name], (m) => m.generator);
      continue;
    }

    if (name && mounts[name]) {
      const target = document.querySelector(mounts[name]);
      main.variable(new Inspector(target)).define(name, inputs, definition);
    } else if (name) {
      main.variable().define(name, inputs, definition);
    } else {
      main.variable().define(inputs, definition);
    }
  }

  return { runtime, main };
}
