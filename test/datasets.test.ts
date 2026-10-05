import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, findDataDir } from "../src/data/datasets.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("data directory", () => {
  it("resolves to the project's data/ from the source tree", () => {
    expect(DEFAULT_DATA_DIR).toBe(join(ROOT, "data"));
    expect(existsSync(join(DEFAULT_DATA_DIR, "manifest.json"))).toBe(true);
  });

  it("resolves to the project's data/ from the compiled dist/ tree too", () => {
    expect(findDataDir(join(ROOT, "dist", "src", "data"))).toBe(join(ROOT, "data"));
  });
});
