import { describe, expect, it } from "vitest";
import { inspectTestIntegrity } from "@/security/integrity";
import { boundedLog, redactSecrets } from "@/security/redaction";

describe("security boundaries", () => {
  it("redacts common provider secrets", () => {
    const log = redactSecrets(
      "Bearer abcdefghijklmnopqrstuvwxyz ghp_abcdefghijklmnopqrstuvwxyz123456 sk-test_abcdefghijklmnopqrstuvwxyz",
    );
    expect(log).not.toContain("ghp_");
    expect(log).not.toContain("Bearer abcdef");
  });

  it("redacts credentials embedded in infrastructure URLs", () => {
    const log = redactSecrets("postgresql://patchrail:super-secret@example.internal/database");
    expect(log).not.toContain("patchrail:super-secret");
    expect(log).toContain("[REDACTED_URL_CREDENTIALS]");
  });

  it("bounds persisted verification output", () => {
    expect(boundedLog("x".repeat(100), 20)).toBe(
      "x".repeat(20) + "\n[output truncated by Patchrail]",
    );
  });

  it("flags newly skipped tests", () => {
    const result = inspectTestIntegrity([
      {
        path: "src/example.test.ts",
        operation: "UPDATE",
        before: Buffer.from("test('works', () => expect(true).toBe(true));"),
        after: Buffer.from("test.skip('works', () => expect(true).toBe(true));"),
      },
    ]);
    expect(result.passed).toBe(false);
    expect(result.findings[0]?.toLowerCase()).toContain("skipped test");
  });

  it("flags test-file deletion", () => {
    const result = inspectTestIntegrity([
      {
        path: "tests/api.test.ts",
        operation: "DELETE",
        before: Buffer.from("expect(true).toBe(true)"),
        after: null,
      },
    ]);
    expect(result.findings).toContain("tests/api.test.ts: Test file deleted");
  });

  it("flags broad validation weakening outside test files", () => {
    const result = inspectTestIntegrity([
      {
        path: "tsconfig.json",
        operation: "UPDATE",
        before: Buffer.from('{"compilerOptions":{"strict":true}}'),
        after: Buffer.from('{"compilerOptions":{"strict":false}}'),
      },
    ]);
    expect(result.passed).toBe(false);
    expect(result.findings[0]).toContain("TypeScript validation weakened");
  });

  it("does not allow a patch to replace or remove existing verification scripts", () => {
    const result = inspectTestIntegrity([
      {
        path: "package.json",
        operation: "UPDATE",
        before: Buffer.from(
          JSON.stringify({ scripts: { test: "vitest run", build: "next build" } }),
        ),
        after: Buffer.from(JSON.stringify({ scripts: { test: "echo pass" } })),
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.findings).toEqual([
      "package.json: Existing test verification script changed or removed",
      "package.json: Existing build verification script changed or removed",
    ]);
  });

  it("allows unrelated package metadata changes while keeping verification scripts exact", () => {
    const result = inspectTestIntegrity([
      {
        path: "package.json",
        operation: "UPDATE",
        before: Buffer.from(JSON.stringify({ scripts: { test: "vitest run" }, version: "1.0.0" })),
        after: Buffer.from(JSON.stringify({ scripts: { test: "vitest run" }, version: "1.0.1" })),
      },
    ]);

    expect(result.passed).toBe(true);
  });

  it("rejects added verification lifecycle hooks and package-manager changes", () => {
    const result = inspectTestIntegrity([
      {
        path: "package.json",
        operation: "UPDATE",
        before: Buffer.from(
          JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run" } }),
        ),
        after: Buffer.from(
          JSON.stringify({
            packageManager: "pnpm@6.0.0",
            scripts: { pretest: "rm -rf tests", test: "vitest run" },
          }),
        ),
      },
    ]);

    expect(result.findings).toContain("package.json: Package-manager selection changed");
    expect(result.findings).toContain("package.json: test verification lifecycle hook changed");
  });

  it("rejects changes to known test-discovery configuration", () => {
    const result = inspectTestIntegrity([
      {
        path: "vitest.config.ts",
        operation: "UPDATE",
        before: Buffer.from("export default { test: { include: ['tests/**'] } };"),
        after: Buffer.from("export default { test: { include: [] } };"),
      },
    ]);

    expect(result.findings).toContain("vitest.config.ts: Verification configuration changed");
  });
});
