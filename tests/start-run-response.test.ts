import { describe, expect, it } from "vitest";
import { readStartRunResponse } from "@/components/start-run-button";

describe("start-run response parsing", () => {
  it("reads a structured success response", async () => {
    const response = Response.json(
      { runId: "4f620dad-9ce0-41de-854f-9ef644260ddd" },
      { status: 201 },
    );

    await expect(readStartRunResponse(response)).resolves.toEqual({
      runId: "4f620dad-9ce0-41de-854f-9ef644260ddd",
    });
  });

  it("preserves a safe structured backend error", async () => {
    const response = Response.json(
      { error: "The AI budget is exhausted", code: "BUDGET_EXCEEDED" },
      { status: 402 },
    );

    await expect(readStartRunResponse(response)).resolves.toEqual({
      error: "The AI budget is exhausted",
      code: "BUDGET_EXCEEDED",
    });
  });

  it("rejects empty, non-JSON, and malformed JSON responses", async () => {
    await expect(readStartRunResponse(new Response(null, { status: 500 }))).resolves.toBeNull();
    await expect(
      readStartRunResponse(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      readStartRunResponse(
        new Response("{", { status: 500, headers: { "content-type": "application/json" } }),
      ),
    ).resolves.toBeNull();
  });
});
