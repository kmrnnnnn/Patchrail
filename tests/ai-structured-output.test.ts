import { describe, expect, it } from "vitest";
import { openAiStrictJsonSchema, openAiTextFormat } from "@/ai/structured-output";
import { agentResultSchema } from "@/runs/types";

describe("OpenAI Structured Outputs boundary", () => {
  it("uses the supported provider subset while retaining absolute URL validation", () => {
    const format = openAiTextFormat(agentResultSchema, "patchrail_repository_result");
    const schemaJson = JSON.stringify(format.schema);
    expect(schemaJson).not.toContain('"format":"uri"');
    expect(schemaJson).not.toMatch(/"(?:minLength|maxLength)":/);

    const properties = format.schema.properties as Record<string, unknown>;
    const research = properties.research as {
      items: { properties: Record<string, unknown> };
    };
    expect(research.items.properties.url).toEqual({ type: "string" });

    const toolParameters = openAiStrictJsonSchema({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, format: "uri" },
      },
      required: ["query"],
      additionalProperties: false,
    });
    expect(toolParameters.properties.query).toEqual({ type: "string" });

    const result = {
      summary: "The current API usage was analyzed.",
      detectedApis: [],
      research: [
        {
          apiId: "example",
          url: "https://docs.example.com/reference",
          title: "Official API reference",
          sourceType: "OFFICIAL_API_REFERENCE",
          summary: "The reference documents the observed endpoint.",
          retrievedAt: "2026-08-15T00:00:00.000Z",
          relevance: "It covers the repository's API usage.",
          authoritative: true,
        },
      ],
      plan: null,
      needsInput: false,
      question: null,
    };

    expect(format.$parseRaw(JSON.stringify(result)).research[0]?.url).toBe(
      "https://docs.example.com/reference",
    );
    expect(() =>
      format.$parseRaw(
        JSON.stringify({
          ...result,
          research: [{ ...result.research[0], url: "not-an-absolute-url" }],
        }),
      ),
    ).toThrow();
  });
});
