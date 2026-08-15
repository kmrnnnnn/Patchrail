import type { RepositoryMap } from "@/ai/repository";

export const ABSOLUTE_MAX_MODEL_CALLS = 22;
export const NORMAL_MAX_MODEL_CALLS = 14;
export const NORMAL_COMPLETION_RESERVE = 4;
export const CLARIFICATION_MAX_MODEL_CALLS = 4;
export const REPAIR_MAX_MODEL_CALLS = 4;

export const REPOSITORY_EXPLORATION_TOOLS = new Set([
  "list_tree",
  "read_file",
  "read_files",
  "read_file_range",
  "search_repository",
  "read_manifest",
]);

export type AgentCallPolicy = {
  totalCalls: number;
  repositoryUnderstandingCalls: number;
  researchAndPatchCalls: number;
  finalSynthesisCalls: number;
};

export type AgentTurnPolicy = {
  phase: "REPOSITORY_UNDERSTANDING" | "RESEARCH_AND_PATCH" | "FINAL_SYNTHESIS";
  allowRepositoryExploration: boolean;
  allowTools: boolean;
  toolChoice: "auto" | "none";
  instruction: string | null;
};

type ToolDescriptor = { type: string; name?: string };

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

/**
 * Scales a fresh normal analysis to 13 or 14 calls while preserving four calls
 * for the one permitted answered clarification and four calls for the one
 * permitted verification repair within the run-wide absolute maximum of 22.
 * Cost, token, research, repository-read, and elapsed-time authorization remain
 * independent hard ceilings and can stop the run sooner.
 */
export function deriveAgentCallPolicy(options: {
  repositoryMap: RepositoryMap;
  availableModelCalls: number;
  priorPhaseModelCalls: number;
  repair: boolean;
  clarification: boolean;
}): AgentCallPolicy {
  const available = clampInteger(options.availableModelCalls, 1, ABSOLUTE_MAX_MODEL_CALLS);
  const priorPhaseCalls = clampInteger(options.priorPhaseModelCalls, 0, ABSOLUTE_MAX_MODEL_CALLS);
  let desiredCalls: number;
  let completionReserve: number;

  if (options.repair) {
    const repairCallsAvailable = REPAIR_MAX_MODEL_CALLS - priorPhaseCalls;
    if (repairCallsAvailable <= 0) {
      throw new Error("AI verification-repair call budget is exhausted");
    }
    desiredCalls = Math.min(available, repairCallsAvailable);
    completionReserve = Math.min(1, desiredCalls);
  } else if (options.clarification) {
    const clarificationCallsAvailable = available - REPAIR_MAX_MODEL_CALLS;
    const clarificationPhaseCallsAvailable = CLARIFICATION_MAX_MODEL_CALLS - priorPhaseCalls;
    if (clarificationCallsAvailable <= 0 || clarificationPhaseCallsAvailable <= 0) {
      throw new Error("AI clarification call budget is exhausted; repair reserve preserved");
    }
    desiredCalls = Math.min(clarificationCallsAvailable, clarificationPhaseCallsAvailable);
    completionReserve = Math.min(1, desiredCalls);
  } else {
    const analysisCallsAvailable =
      available - REPAIR_MAX_MODEL_CALLS - CLARIFICATION_MAX_MODEL_CALLS;
    if (analysisCallsAvailable <= 0) {
      throw new Error("AI normal-analysis call budget is exhausted; repair reserve preserved");
    }
    const normalPhaseCallsAvailable = NORMAL_MAX_MODEL_CALLS - priorPhaseCalls;
    if (normalPhaseCallsAvailable <= 0) {
      throw new Error("AI normal-analysis phase call budget is exhausted");
    }
    const fileCount = options.repositoryMap.tree.filter((entry) => entry.kind === "file").length;
    const fileComplexity = Math.min(1, Math.ceil(fileCount / 400));
    const manifestComplexity = Math.min(1, options.repositoryMap.manifests.length);
    const truncationComplexity = options.repositoryMap.treeTruncated ? 1 : 0;
    desiredCalls = clampInteger(
      12 + fileComplexity + manifestComplexity + truncationComplexity,
      13,
      NORMAL_MAX_MODEL_CALLS,
    );
    desiredCalls = Math.min(analysisCallsAvailable, normalPhaseCallsAvailable, desiredCalls);
    completionReserve = Math.min(NORMAL_COMPLETION_RESERVE, Math.max(1, desiredCalls - 1));
  }

  const finalSynthesisCalls = Math.min(1, desiredCalls);
  const researchAndPatchCalls = Math.max(0, completionReserve - finalSynthesisCalls);
  return {
    totalCalls: desiredCalls,
    repositoryUnderstandingCalls: Math.max(0, desiredCalls - completionReserve),
    researchAndPatchCalls,
    finalSynthesisCalls,
  };
}

export function toolsForAgentTurn<ToolType extends ToolDescriptor>(
  allTools: readonly ToolType[],
  turn: AgentTurnPolicy,
  researchCallsRemaining: number,
): ToolType[] {
  if (!turn.allowTools) return [];
  return allTools.filter((tool) => {
    if (tool.type === "web_search" && researchCallsRemaining <= 0) return false;
    return !(
      !turn.allowRepositoryExploration &&
      tool.type === "function" &&
      tool.name !== undefined &&
      REPOSITORY_EXPLORATION_TOOLS.has(tool.name)
    );
  });
}

export function agentTurnPolicy(policy: AgentCallPolicy, callIndex: number): AgentTurnPolicy {
  if (!Number.isInteger(callIndex) || callIndex < 0 || callIndex >= policy.totalCalls) {
    throw new Error("AI call index is outside the bounded orchestration policy");
  }

  if (callIndex < policy.repositoryUnderstandingCalls) {
    return {
      phase: "REPOSITORY_UNDERSTANDING",
      allowRepositoryExploration: true,
      allowTools: true,
      toolChoice: "auto",
      instruction: null,
    };
  }

  const finalCallIndex = policy.totalCalls - policy.finalSynthesisCalls;
  if (callIndex < finalCallIndex) {
    return {
      phase: "RESEARCH_AND_PATCH",
      allowRepositoryExploration: false,
      allowTools: true,
      toolChoice: "auto",
      instruction:
        "Repository exploration is now closed. Use the evidence already collected, complete any essential official research or planned patch work, and produce the structured repository result as soon as possible. If the available evidence cannot support a conclusion, classify that API as INSUFFICIENT_EVIDENCE instead of requesting more repository files.",
    };
  }

  return {
    phase: "FINAL_SYNTHESIS",
    allowRepositoryExploration: false,
    allowTools: false,
    toolChoice: "none",
    instruction:
      "This is the reserved final synthesis response. No tools are available. Return the required structured repository result now from the evidence already collected. Use INSUFFICIENT_EVIDENCE for any conclusion that cannot be supported; do not request more information or tool calls.",
  };
}
