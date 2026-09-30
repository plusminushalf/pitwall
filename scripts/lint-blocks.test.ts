import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintBlocks } from "./lint-blocks";

// A throwaway blocks folder: one clean block, one that breaks every rule.
const root = mkdtempSync(join(tmpdir(), "lint-blocks-"));
const write = (path: string, code: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), code);
};

write(
  "speed-gear/index.tsx",
  `import { useState } from "react";
import { jsx } from "react/jsx-runtime";
import { defineBlock, useCar, type Telemetry } from "block-kit";
import { Stat } from "./Stat";
import helpers from "./lib/helpers";
// import { clock } from "../../store"; (a comment, not an import)
export default defineBlock({} as never);
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
export type { Telemetry } from "block-kit/internal";
const later = () => import("node:fs");
type Chart = typeof import("../speed-gear/chart");
export const B = () => <div />;
`,
);
write("stray.ts", `export const x = 1;`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("block import lint", () => {
  const problems = lintBlocks(root);
  const inFile = (name: string) => problems.filter((p) => p.file.endsWith(name));
  const about = (spec: string) => problems.find((p) => p.message.startsWith(`"${spec}"`));

  test("a block using only react, block-kit and its own files passes", () => {
    expect(problems.filter((p) => p.file.includes("speed-gear"))).toEqual([]);
  });

  test("forbidden packages are caught, including type-only and unused imports", () => {
    for (const spec of ["zustand", "lodash", "block-kit/internal", "node:fs"]) {
      expect(about(spec)?.message).toContain("may only import react, block-kit");
    }
  });

  test("imports that escape the block's folder are caught, type-only too", () => {
    expect(about("../../store")?.message).toContain("leaves the block's folder");
    expect(about("../../data/session")?.message).toContain("leaves the block's folder");
    expect(about("../../store")?.line).toBe(1);
    expect(about("../../data/session")?.line).toBe(2);
  });

  test("blocks can't import each other", () => {
    expect(about("../speed-gear/Stat")?.message).toContain("imports another block (speed-gear)");
    expect(about("../speed-gear/chart")?.message).toContain("imports another block (speed-gear)");
  });

  test("files outside a block folder are flagged", () => {
    expect(inFile("stray.ts")[0].message).toBe("not inside a block folder");
  });

  test("the CLI exits non-zero with file:line messages", () => {
    const run = Bun.spawnSync(["bun", join(import.meta.dir, "lint-blocks.ts"), root]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toMatch(/bad\/index\.tsx:1: "\.\.\/\.\.\/store"/);
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "lint-blocks.ts"), join(root, "speed-gear-none")]).exitCode).toBe(0);
  });
});
