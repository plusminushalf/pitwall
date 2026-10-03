import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintWidgets } from "./lint-widgets";

// A throwaway widgets folder: one clean widget, one that breaks every rule.
const root = mkdtempSync(join(tmpdir(), "lint-widgets-"));
const write = (path: string, code: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), code);
};

write(
  "speed-gear/index.tsx",
  `import { useState } from "react";
import { jsx } from "react/jsx-runtime";
import { defineWidget, useCar, type Telemetry } from "widget-kit";
import { Stat } from "./Stat";
import helpers from "./lib/helpers";
// import { clock } from "../../store"; (a comment, not an import)
export default defineWidget({} as never);
`,
);
write("speed-gear/Stat.tsx", `export const Stat = () => <div>{"from '../elsewhere'"}</div>;`);
write("speed-gear/lib/helpers.ts", `import { x } from "../Stat";\nexport default 1;`);
write(
  "bad/index.tsx",
  `import { clock } from "../../store";
import type { Session } from "../../data/session";
import { type Lap } from "zustand";
import { unused } from "lodash";
import { Stat } from "../speed-gear/Stat";
export type { Telemetry } from "widget-kit/internal";
const later = () => import("node:fs");
type Chart = typeof import("../speed-gear/chart");
export const B = () => <div />;
`,
);
write("stray.ts", `export const x = 1;`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("widget import lint", () => {
  const problems = lintWidgets(root);
  const inFile = (name: string) => problems.filter((p) => p.file.endsWith(name));
  const about = (spec: string) => problems.find((p) => p.message.startsWith(`"${spec}"`));

  test("a widget using only react, widget-kit and its own files passes", () => {
    expect(problems.filter((p) => p.file.includes("speed-gear"))).toEqual([]);
  });

  test("forbidden packages are caught, including type-only and unused imports", () => {
    for (const spec of ["zustand", "lodash", "widget-kit/internal", "node:fs"]) {
      expect(about(spec)?.message).toContain("may only import react, widget-kit");
    }
  });

  test("imports that escape the widget's folder are caught, type-only too", () => {
    expect(about("../../store")?.message).toContain("leaves the widget's folder");
    expect(about("../../data/session")?.message).toContain("leaves the widget's folder");
    expect(about("../../store")?.line).toBe(1);
    expect(about("../../data/session")?.line).toBe(2);
  });

  test("widgets can't import each other", () => {
    expect(about("../speed-gear/Stat")?.message).toContain("imports another widget (speed-gear)");
    expect(about("../speed-gear/chart")?.message).toContain("imports another widget (speed-gear)");
  });

  test("files outside a widget folder are flagged", () => {
    expect(inFile("stray.ts")[0].message).toBe("not inside a widget folder");
  });

  test("the CLI exits non-zero with file:line messages", () => {
    const run = Bun.spawnSync(["bun", join(import.meta.dir, "lint-widgets.ts"), root]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toMatch(/bad\/index\.tsx:1: "\.\.\/\.\.\/store"/);
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "lint-widgets.ts"), join(root, "speed-gear-none")]).exitCode).toBe(0);
  });
});
