import type {
  ParsedResponseOutputItem,
  ResponseFunctionToolCall,
  ResponseFunctionWebSearch,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";

export type FunctionCallResult = {
  callId: string;
  value: unknown;
};

function serializeReasoningItem(item: ResponseReasoningItem): ResponseReasoningItem {
  if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    throw new Error("AI response omitted encrypted reasoning state for stateless continuation");
  }

  const serialized: ResponseReasoningItem = {
    id: item.id,
    summary: item.summary.map((summary) => ({
      type: "summary_text",
      text: summary.text,
    })),
    type: "reasoning",
    encrypted_content: item.encrypted_content,
  };

  if (item.content !== undefined) {
    serialized.content = item.content.map((content) => ({
      type: "reasoning_text",
      text: content.text,
    }));
  }
  if (item.status !== undefined) serialized.status = item.status;

  return serialized;
}

function serializeFunctionCall(item: ResponseFunctionToolCall): ResponseFunctionToolCall {
  const serialized: ResponseFunctionToolCall = {
    arguments: item.arguments,
    call_id: item.call_id,
    name: item.name,
    type: "function_call",
  };

  if (item.id !== undefined) serialized.id = item.id;
  if (item.status !== undefined) serialized.status = item.status;
  if (item.namespace !== undefined) serialized.namespace = item.namespace;
  if (item.caller !== undefined) {
    serialized.caller =
      item.caller?.type === "program"
        ? { type: "program", caller_id: item.caller.caller_id }
        : item.caller
          ? { type: "direct" }
          : null;
  }

  return serialized;
}

function serializeWebSearchAction(
  action: ResponseFunctionWebSearch["action"],
): ResponseFunctionWebSearch["action"] {
  switch (action.type) {
    case "search": {
      const serialized: ResponseFunctionWebSearch.Search = { type: "search" };
      if (action.queries !== undefined) serialized.queries = [...action.queries];
      if (action.query !== undefined) serialized.query = action.query;
      if (action.sources !== undefined) {
        serialized.sources = action.sources.map((source) => ({
          type: "url",
          url: source.url,
        }));
      }
      return serialized;
    }
    case "open_page":
      return action.url === undefined
        ? { type: "open_page" }
        : { type: "open_page", url: action.url };
    case "find_in_page":
      return {
        type: "find_in_page",
        pattern: action.pattern,
        url: action.url,
      };
  }
}

function serializeWebSearchCall(item: ResponseFunctionWebSearch): ResponseFunctionWebSearch {
  return {
    id: item.id,
    action: serializeWebSearchAction(item.action),
    status: item.status,
    type: "web_search_call",
  };
}

function serializeOutputMessage(item: ResponseOutputMessage): ResponseOutputMessage {
  const serialized: ResponseOutputMessage = {
    id: item.id,
    content: item.content.map((content) => {
      if (content.type === "refusal") {
        return { type: "refusal", refusal: content.refusal };
      }

      return {
        type: "output_text",
        text: content.text,
        annotations: content.annotations.map((annotation) => {
          switch (annotation.type) {
            case "file_citation":
              return {
                type: "file_citation",
                file_id: annotation.file_id,
                filename: annotation.filename,
                index: annotation.index,
              };
            case "url_citation":
              return {
                type: "url_citation",
                end_index: annotation.end_index,
                start_index: annotation.start_index,
                title: annotation.title,
                url: annotation.url,
              };
            case "container_file_citation":
              return {
                type: "container_file_citation",
                container_id: annotation.container_id,
                end_index: annotation.end_index,
                file_id: annotation.file_id,
                filename: annotation.filename,
                start_index: annotation.start_index,
              };
            case "file_path":
              return {
                type: "file_path",
                file_id: annotation.file_id,
                index: annotation.index,
              };
          }
        }),
      };
    }),
    role: "assistant",
    status: item.status,
    type: "message",
  };

  if (item.phase !== undefined) serialized.phase = item.phase;
  return serialized;
}

/**
 * Converts parsed SDK response items into the documented Responses API input
 * shapes. SDK-only conveniences such as `parsed_arguments` and output-text
 * `parsed` values are deliberately never copied across this boundary.
 */
export function serializeToolResponseOutput(
  output: ReadonlyArray<ParsedResponseOutputItem<unknown>>,
): ResponseInputItem[] {
  return output.map((item) => {
    switch (item.type) {
      case "reasoning":
        return serializeReasoningItem(item);
      case "function_call":
        return serializeFunctionCall(item);
      case "web_search_call":
        return serializeWebSearchCall(item);
      case "message":
        return serializeOutputMessage(item);
      default:
        throw new Error(`Unsupported AI response item in tool continuation: ${item.type}`);
    }
  });
}

function jsonFunctionCallOutput(
  callId: string,
  value: unknown,
): ResponseInputItem.FunctionCallOutput {
  const output = JSON.stringify(value);
  if (output === undefined) throw new Error(`Repository tool ${callId} returned no JSON value`);
  return { type: "function_call_output", call_id: callId, output };
}

/**
 * Builds one stateless continuation turn and validates that every function call
 * has exactly one result. Results are emitted in provider call order, regardless
 * of the order in which the host collected them.
 */
export function buildToolContinuation(
  output: ReadonlyArray<ParsedResponseOutputItem<unknown>>,
  results: ReadonlyArray<FunctionCallResult>,
): ResponseInputItem[] {
  const calls = output.filter(
    (item): item is Extract<ParsedResponseOutputItem<unknown>, { type: "function_call" }> =>
      item.type === "function_call",
  );
  const resultsByCallId = new Map<string, unknown>();

  for (const result of results) {
    if (resultsByCallId.has(result.callId)) {
      throw new Error(`Duplicate repository tool result for call ${result.callId}`);
    }
    resultsByCallId.set(result.callId, result.value);
  }
  if (resultsByCallId.size !== calls.length) {
    throw new Error("Repository tool results did not match the model's function calls");
  }

  const functionOutputs = calls.map((call) => {
    if (!resultsByCallId.has(call.call_id)) {
      throw new Error(`Missing repository tool result for call ${call.call_id}`);
    }
    return jsonFunctionCallOutput(call.call_id, resultsByCallId.get(call.call_id));
  });

  return [...serializeToolResponseOutput(output), ...functionOutputs];
}
