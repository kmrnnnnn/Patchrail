import { describe, expect, it } from "vitest";
import type {
  ParsedResponseFunctionToolCall,
  ParsedResponseOutputItem,
} from "openai/resources/responses/responses";
import { executeRepositoryFunctionCall, executeRepositoryFunctionCalls } from "@/ai/agent";
import type { RepositoryWorkspace } from "@/ai/repository";
import { buildToolContinuation, serializeToolResponseOutput } from "@/ai/tool-continuation";

function functionCall(
  callId: string,
  name = "read_file",
  path = "src/index.ts",
): ParsedResponseFunctionToolCall {
  return {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify({ path }),
    parsed_arguments: { path },
    status: "completed",
  };
}

function reasoning(id: string): ParsedResponseOutputItem<unknown> {
  return {
    id,
    type: "reasoning",
    summary: [],
    encrypted_content: `encrypted-${id}`,
    status: "completed",
  };
}

describe("OpenAI Responses tool continuation", () => {
  it("uses a parsed call locally while retaining Zod validation of raw arguments", async () => {
    const reads: string[] = [];
    const workspace = {
      readFile: async (path: string) => {
        reads.push(path);
        return { path, content: "export {};" };
      },
    } as unknown as RepositoryWorkspace;
    const call = functionCall("call_read", "read_file", "src/api.ts");

    await expect(executeRepositoryFunctionCall(workspace, call)).resolves.toMatchObject({
      path: "src/api.ts",
    });
    expect(call.parsed_arguments).toEqual({ path: "src/api.ts" });
    expect(reads).toEqual(["src/api.ts"]);

    await expect(
      executeRepositoryFunctionCall(workspace, {
        ...call,
        arguments: JSON.stringify({ path: "" }),
      }),
    ).rejects.toThrow();
  });

  it("never sends SDK-only parsed fields across the wire boundary", () => {
    const serialized = serializeToolResponseOutput([
      functionCall("call_1"),
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Working",
            annotations: [],
            parsed: { sdkOnly: true },
          },
        ],
      },
    ]);
    const wireJson = JSON.stringify(serialized);

    expect(wireJson).not.toContain("parsed_arguments");
    expect(wireJson).not.toContain('"parsed"');
    expect(wireJson).not.toContain("output_parsed");
    expect(serialized[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      arguments: '{"path":"src/index.ts"}',
    });
    expect(() =>
      serializeToolResponseOutput([
        { id: "rs_missing", type: "reasoning", summary: [], status: "completed" },
      ]),
    ).toThrow("omitted encrypted reasoning state");
  });

  it("builds a valid read_file continuation with the exact call ID and JSON output", () => {
    const continuation = buildToolContinuation(
      [reasoning("rs_1"), functionCall("call_read", "read_file", "package.json")],
      [{ callId: "call_read", value: { ok: true, result: { content: "{}" } } }],
    );

    expect(continuation).toEqual([
      expect.objectContaining({
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted-rs_1",
      }),
      expect.objectContaining({
        type: "function_call",
        call_id: "call_read",
        name: "read_file",
      }),
      {
        type: "function_call_output",
        call_id: "call_read",
        output: '{"ok":true,"result":{"content":"{}"}}',
      },
    ]);
    expect(typeof (continuation[2] as { output: unknown }).output).toBe("string");
  });

  it("retains state across two sequential tool rounds without leaking parsed fields", () => {
    const input = [
      ...buildToolContinuation(
        [reasoning("rs_1"), functionCall("call_1", "read_file", "package.json")],
        [{ callId: "call_1", value: { ok: true, result: "manifest" } }],
      ),
      ...buildToolContinuation(
        [reasoning("rs_2"), functionCall("call_2", "read_file", "src/index.ts")],
        [{ callId: "call_2", value: { ok: true, result: "source" } }],
      ),
    ];

    expect(input.filter((item) => item.type === "function_call_output")).toEqual([
      expect.objectContaining({ call_id: "call_1" }),
      expect.objectContaining({ call_id: "call_2" }),
    ]);
    expect(input.filter((item) => item.type === "reasoning")).toHaveLength(2);
    expect(JSON.stringify(input)).not.toContain("parsed_arguments");
  });

  it("pairs multiple results to provider calls by call_id", () => {
    const continuation = buildToolContinuation(
      [functionCall("call_a"), functionCall("call_b", "read_file", "README.md")],
      [
        { callId: "call_b", value: { ok: true, result: "B" } },
        { callId: "call_a", value: { ok: true, result: "A" } },
      ],
    );
    const outputs = continuation.filter((item) => item.type === "function_call_output");

    expect(outputs).toEqual([
      {
        type: "function_call_output",
        call_id: "call_a",
        output: '{"ok":true,"result":"A"}',
      },
      {
        type: "function_call_output",
        call_id: "call_b",
        output: '{"ok":true,"result":"B"}',
      },
    ]);
    expect(() =>
      buildToolContinuation(
        [functionCall("call_a")],
        [{ callId: "wrong_call", value: { ok: true } }],
      ),
    ).toThrow("Missing repository tool result for call call_a");
  });

  it("executes every function call returned in one response before continuing", async () => {
    const reads: string[] = [];
    const workspace = {
      readFile: async (path: string) => {
        reads.push(path);
        return { path, content: path };
      },
    } as unknown as RepositoryWorkspace;
    const calls = [
      functionCall("call_a", "read_file", "src/a.ts"),
      functionCall("call_b", "read_file", "src/b.ts"),
    ];

    const results = await executeRepositoryFunctionCalls(workspace, calls);

    expect(reads).toEqual(["src/a.ts", "src/b.ts"]);
    expect(results).toEqual([
      {
        callId: "call_a",
        value: { ok: true, result: expect.objectContaining({ path: "src/a.ts" }) },
      },
      {
        callId: "call_b",
        value: { ok: true, result: expect.objectContaining({ path: "src/b.ts" }) },
      },
    ]);
    expect(
      buildToolContinuation(calls, results).filter((item) => item.type === "function_call_output"),
    ).toHaveLength(2);
  });
});
