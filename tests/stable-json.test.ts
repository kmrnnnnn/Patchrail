import { describe, expect, it } from "vitest";
import { stableJson } from "@/lib/stable-json";

describe("stable JSON equality", () => {
  it("ignores object key order introduced by PostgreSQL jsonb", () => {
    const original = [{ path: "src/a.ts", operation: "UPDATE", nested: { b: 2, a: 1 } }];
    const reordered = [{ nested: { a: 1, b: 2 }, operation: "UPDATE", path: "src/a.ts" }];

    expect(stableJson(original)).toBe(stableJson(reordered));
  });

  it("preserves array order", () => {
    expect(stableJson(["test", "build"])).not.toBe(stableJson(["build", "test"]));
  });
});
