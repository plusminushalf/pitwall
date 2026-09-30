// Block import check (H3.13, and later H3.15's CI check): files in a block folder may import only
// react, react/*, block-kit and files inside their own folder. So blocks can't import each other.
//
//   bun scripts/lint-blocks.ts [dir]      dir holds one folder per block (default src/blocks)
//
// Bun's scanImports finds value imports (static, dynamic, require) but, like TypeScript, drops type-only
// and unused imports, so a pass over the source (comments and other strings blanked) adds every `from "x"`, `import("x")`,
// `import "x"` and `require("x")`. It catches mistakes, not a determined author (review does that).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const CODE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const LOADER: Record<string, "ts" | "tsx" | "js" | "jsx"> = { ".tsx": "tsx", ".jsx": "jsx", ".js": "js", ".mjs": "js", ".cjs": "js" };
const ALLOWED = (spec: string) => spec === "react" || spec.startsWith("react/") || spec === "block-kit";

export interface Problem {
  file: string;
  line: number;
  message: string;
}

/** Right before a module specifier string. */
const BEFORE_SPECIFIER = /(\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*$/;

/**
 * The source with comments and strings blanked, except strings that follow `from`, `import`, `import(`
 * or `require(`. Newlines are kept, so offsets keep their line.
 */
function blankNonImports(code: string): string {
  let out = "";
  let i = 0;
  const blank = (to: number) => {
    for (; i < to; i++) out += code[i] === "\n" ? "\n" : " ";
  };
  while (i < code.length) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      blank(end < 0 ? code.length : end);
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      blank(end < 0 ? code.length : end + 2);
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      // Template literals may span lines; a quote that never closes (a regex literal) ends at the line.
      while (j < code.length && code[j] !== c && (c === "`" || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
      if (c !== "`" && BEFORE_SPECIFIER.test(out.slice(-40))) {
        out += code.slice(i, j + 1);
        i = j + 1;
      } else {
        out += c;
        i++;
        blank(j);
        if (i < code.length) (out += code[i]), i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SPECIFIER = /\bfrom\s*(["'])([^"'\n]+)\1|\bimport\s*\(\s*(["'])([^"'\n]+)\3|\bimport\s*(["'])([^"'\n]+)\5|\brequire\s*\(\s*(["'])([^"'\n]+)\7/g;

/** Every module a file imports, with the line it's on (1 when only the transpiler saw it). */
export function importsOf(code: string, ext: string): { spec: string; line: number }[] {
  const found = new Map<string, number>();
  const src = blankNonImports(code);
  for (const m of src.matchAll(SPECIFIER)) {
    const spec = m[2] ?? m[4] ?? m[6] ?? m[8];
    if (!found.has(spec)) found.set(spec, src.slice(0, m.index).split("\n").length);
  }
  const transpiler = new Bun.Transpiler({ loader: LOADER[ext] ?? "ts" });
  for (const { path } of transpiler.scanImports(code)) if (!found.has(path)) found.set(path, 1);
  return [...found].map(([spec, line]) => ({ spec, line }));
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : CODE.has(extname(name)) ? [path] : [];
  });
}

/** Import problems in every block under `dir` (none if it doesn't exist). */
export function lintBlocks(dir: string): Problem[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const problems: Problem[] = [];
  for (const file of filesIn(root)) {
    const [block, ...rest] = relative(root, file).split(sep);
    const shown = relative(process.cwd(), file);
    if (rest.length === 0) {
      problems.push({ file: shown, line: 1, message: "not inside a block folder" });
      continue;
    }
    const blockDir = join(root, block);
    for (const { spec, line } of importsOf(readFileSync(file, "utf8"), extname(file))) {
      if (ALLOWED(spec)) continue;
      const add = (message: string) => problems.push({ file: shown, line, message: `"${spec}": ${message}` });
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        add("blocks may only import react, block-kit and files in their own folder");
        continue;
      }
      const target = resolve(file, "..", spec);
      if (target === blockDir || target.startsWith(blockDir + sep)) continue;
      const rel = relative(root, target);
      const other = rel.split(sep)[0];
      const intoBlock = rel !== "" && !rel.startsWith("..") && existsSync(join(root, other)) && statSync(join(root, other)).isDirectory();
      add(intoBlock ? `imports another block (${other}); blocks never import each other` : `leaves the block's folder (${block}/)`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "src/blocks";
  const problems = lintBlocks(dir);
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} import problem${problems.length === 1 ? "" : "s"} in ${dir}`);
    process.exit(1);
  }
  console.log(`Block imports OK (${dir})`);
}
