import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { customerEventMessage } from "@/runs/customer-presentation";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

const INTERNAL_ECONOMICS = [
  /model calls/i,
  /model tokens/i,
  /input tokens/i,
  /output tokens/i,
  /cached input tokens/i,
  /AI cost/i,
  /AI spend/i,
  /AI budget/i,
  /maximum AI spend/i,
  /actualCostUsd/,
  /estimatedCostUsd/,
  /modelUsage/,
  /maximumCostUsd/,
  /aiBudgetUsd/,
];

describe("customer presentation boundary", () => {
  it("keeps internal AI economics out of normal customer components", async () => {
    const customerSource = (
      await Promise.all([
        source("src/components/run-progress.tsx"),
        source("src/components/start-run-button.tsx"),
        source("src/components/billing/usage-panel.tsx"),
        source("src/components/billing/billing-panel.tsx"),
        source("src/app/app/repositories/[repositoryId]/page.tsx"),
        source("src/app/app/settings/usage/page.tsx"),
      ])
    ).join("\n");

    for (const forbidden of INTERNAL_ECONOMICS) {
      expect(customerSource).not.toMatch(forbidden);
    }
    for (const fact of [
      "Starting commit",
      "APIs found",
      "APIs updated",
      "Files changed",
      "Verification",
      "Draft PR",
      "Duration",
    ]) {
      expect(customerSource).toContain(fact);
    }
  });

  it("does not serialize internal run telemetry or event details to the run client", async () => {
    const queries = await source("src/server/queries.ts");
    const start = queries.indexOf("export async function getRunDetail");
    const runDetail = queries.slice(start);

    expect(runDetail).not.toContain("modelUsage");
    expect(runDetail).not.toContain("actualCostUsd");
    expect(runDetail).not.toContain("estimatedCostUsd");
    expect(runDetail).not.toContain("aiRunEvents.details");
    expect(runDetail).not.toMatch(/errorCode:\s*run\.run\.errorCode/);
    expect(runDetail).toContain("failure");
  });

  it("replaces persisted reservation language before run events reach the customer", () => {
    expect(
      customerEventMessage({
        stage: "QUEUED",
        kind: "INFO",
        message: "AI update queued; the maximum run cost is reserved",
        failure: null,
      }),
    ).toBe("Repository update queued");
  });

  it("describes commercial allowances without advertising provider economics", async () => {
    const marketingSource = (
      await Promise.all([
        source("src/app/(marketing)/page.tsx"),
        source("src/app/(marketing)/pricing/page.tsx"),
        source("src/app/(marketing)/security/page.tsx"),
      ])
    ).join("\n");

    for (const forbidden of INTERNAL_ECONOMICS.slice(0, 9)) {
      expect(marketingSource).not.toMatch(forbidden);
    }
    expect(marketingSource).toContain("Patchrail update allowance");
  });
});
