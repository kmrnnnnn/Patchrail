import { describe, expect, it } from "vitest";
import { isTerminalRunStatus, isUpdateRequired, runStatusSchema } from "@/runs/types";

describe("run state policy", () => {
  it.each(["SUCCEEDED", "FAILED", "NEEDS_INPUT"])("treats %s as terminal", (status) => {
    expect(isTerminalRunStatus(status)).toBe(true);
  });

  it.each(["QUEUED", "VERIFYING", "CREATING_PR"])("keeps %s pollable", (status) => {
    expect(isTerminalRunStatus(status)).toBe(false);
  });

  it("rejects undocumented run states", () => {
    expect(runStatusSchema.safeParse("MAGIC_PROGRESS").success).toBe(false);
  });

  it.each(["DEPRECATED_USAGE", "BREAKING_CHANGE_RELEVANT", "MIGRATION_REQUIRED"] as const)(
    "requires a patch for %s",
    (status) => expect(isUpdateRequired(status)).toBe(true),
  );

  it.each(["CURRENT", "UPDATE_AVAILABLE", "INSUFFICIENT_EVIDENCE"] as const)(
    "does not automatically patch %s",
    (status) => expect(isUpdateRequired(status)).toBe(false),
  );
});
