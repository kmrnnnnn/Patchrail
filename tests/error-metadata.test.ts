import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { GitHubIntegrationError } from "@/github/errors";
import { classifyRunError } from "@/runs/error-metadata";

describe("run error classification", () => {
  it("uses structured provider and repository context instead of incidental message words", () => {
    const providerError = new OpenAI.BadRequestError(
      400,
      {
        code: "invalid_json_schema",
        message: "Invalid schema for response_format 'patchrail_repository_result'",
        param: "text.format.schema",
        type: "invalid_request_error",
      },
      undefined,
      new Headers(),
    );

    expect(classifyRunError(providerError, "FINDING_APIS")).toMatchObject({
      code: "AI_SCHEMA_INVALID",
    });
    expect(
      classifyRunError(new Error("A repository research verification cost model failed"), "QUEUED"),
    ).toMatchObject({ code: "RUN_FAILED" });
    expect(
      classifyRunError(
        new GitHubIntegrationError("GitHub repository archive could not be read", "ARCHIVE_FAILED"),
        "FINDING_APIS",
      ),
    ).toMatchObject({ code: "REPOSITORY_READ_FAILED" });
    expect(
      classifyRunError(new Error("Archive extraction failed"), "READING_REPOSITORY"),
    ).toMatchObject({ code: "REPOSITORY_READ_FAILED" });
  });
});
