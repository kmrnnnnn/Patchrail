import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_MAX_MODEL_CALLS,
  agentTurnPolicy,
  CLARIFICATION_MAX_MODEL_CALLS,
  deriveAgentCallPolicy,
  NORMAL_MAX_MODEL_CALLS,
  REPAIR_MAX_MODEL_CALLS,
  toolsForAgentTurn,
} from "@/ai/orchestration";
import type { RepositoryMap } from "@/ai/repository";

function repositoryMap(options: {
  fileCount: number;
  manifests?: number;
  treeTruncated?: boolean;
}): RepositoryMap {
  return {
    tree: Array.from({ length: options.fileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
      size: 10,
      kind: "file" as const,
    })),
    treeTruncated: options.treeTruncated ?? false,
    manifests: Array.from({ length: options.manifests ?? 0 }, (_, index) => ({
      path: `package-${index}.json`,
      summary: {},
    })),
    configurationFiles: [],
    observedDomains: [],
    observedImports: [],
    policy: {
      excludedDirectories: [],
      maxTextFileBytes: 512_000,
      maxReads: 80,
      maxFilesWritten: 20,
      maxContextBytes: 250_000,
    },
  };
}

describe("bounded AI agent orchestration", () => {
  it("gives a small manifested repository a practical analysis budget and reserves completion", () => {
    const policy = deriveAgentCallPolicy({
      repositoryMap: repositoryMap({ fileCount: 12, manifests: 1 }),
      availableModelCalls: ABSOLUTE_MAX_MODEL_CALLS,
      priorPhaseModelCalls: 0,
      repair: false,
      clarification: false,
    });

    expect(policy).toEqual({
      totalCalls: NORMAL_MAX_MODEL_CALLS,
      repositoryUnderstandingCalls: 10,
      researchAndPatchCalls: 3,
      finalSynthesisCalls: 1,
    });
    expect(policy.totalCalls).toBeGreaterThan(8);
  });

  it("preserves bounded clarification and repair phases within the absolute hard ceiling", () => {
    const map = repositoryMap({ fileCount: 12, manifests: 1 });
    const normal = deriveAgentCallPolicy({
      repositoryMap: map,
      availableModelCalls: ABSOLUTE_MAX_MODEL_CALLS,
      priorPhaseModelCalls: 0,
      repair: false,
      clarification: false,
    });
    const clarification = deriveAgentCallPolicy({
      repositoryMap: map,
      availableModelCalls: ABSOLUTE_MAX_MODEL_CALLS - normal.totalCalls,
      priorPhaseModelCalls: 0,
      repair: false,
      clarification: true,
    });
    const repair = deriveAgentCallPolicy({
      repositoryMap: map,
      availableModelCalls: ABSOLUTE_MAX_MODEL_CALLS - normal.totalCalls - clarification.totalCalls,
      priorPhaseModelCalls: 0,
      repair: true,
      clarification: false,
    });

    expect(clarification.totalCalls).toBe(CLARIFICATION_MAX_MODEL_CALLS);
    expect(clarification.repositoryUnderstandingCalls).toBe(3);
    expect(repair.totalCalls).toBe(REPAIR_MAX_MODEL_CALLS);
    expect(normal.totalCalls + clarification.totalCalls + repair.totalCalls).toBe(
      ABSOLUTE_MAX_MODEL_CALLS,
    );
    expect(
      deriveAgentCallPolicy({
        repositoryMap: map,
        availableModelCalls: 999,
        priorPhaseModelCalls: 0,
        repair: true,
        clarification: false,
      }).totalCalls,
    ).toBe(REPAIR_MAX_MODEL_CALLS);
  });

  it("caps normal and repair clarification resumes cumulatively by durable phase usage", () => {
    const map = repositoryMap({ fileCount: 12, manifests: 1 });
    const priorClarificationCalls = 2;
    const normalClarificationRetry = deriveAgentCallPolicy({
      repositoryMap: map,
      availableModelCalls:
        ABSOLUTE_MAX_MODEL_CALLS - NORMAL_MAX_MODEL_CALLS - priorClarificationCalls,
      priorPhaseModelCalls: priorClarificationCalls,
      repair: false,
      clarification: true,
    });
    const priorRepairCalls = 2;
    const repairClarificationRetry = deriveAgentCallPolicy({
      repositoryMap: map,
      availableModelCalls:
        ABSOLUTE_MAX_MODEL_CALLS -
        NORMAL_MAX_MODEL_CALLS -
        priorClarificationCalls -
        normalClarificationRetry.totalCalls -
        priorRepairCalls,
      priorPhaseModelCalls: priorRepairCalls,
      repair: true,
      clarification: true,
    });

    expect(normalClarificationRetry.totalCalls).toBe(2);
    expect(repairClarificationRetry.totalCalls).toBe(2);
    expect(
      NORMAL_MAX_MODEL_CALLS +
        priorClarificationCalls +
        normalClarificationRetry.totalCalls +
        priorRepairCalls +
        repairClarificationRetry.totalCalls,
    ).toBe(ABSOLUTE_MAX_MODEL_CALLS);
  });

  it("closes exploratory reads before the hard limit and disables every tool for synthesis", () => {
    const policy = deriveAgentCallPolicy({
      repositoryMap: repositoryMap({ fileCount: 12, manifests: 1 }),
      availableModelCalls: ABSOLUTE_MAX_MODEL_CALLS,
      priorPhaseModelCalls: 0,
      repair: false,
      clarification: false,
    });
    const toolFixtures = [
      { type: "function", name: "read_file" },
      { type: "function", name: "read_files" },
      { type: "function", name: "apply_patch" },
      { type: "function", name: "read_diff" },
      { type: "web_search" },
    ];

    const completion = agentTurnPolicy(policy, policy.repositoryUnderstandingCalls);
    expect(completion.phase).toBe("RESEARCH_AND_PATCH");
    expect(completion.instruction).toContain("INSUFFICIENT_EVIDENCE");
    expect(toolsForAgentTurn(toolFixtures, completion, 2)).toEqual([
      { type: "function", name: "apply_patch" },
      { type: "function", name: "read_diff" },
      { type: "web_search" },
    ]);

    const final = agentTurnPolicy(policy, policy.totalCalls - 1);
    expect(final).toMatchObject({
      phase: "FINAL_SYNTHESIS",
      allowTools: false,
      allowRepositoryExploration: false,
      toolChoice: "none",
    });
    expect(final.instruction).toContain("Return the required structured repository result now");
    expect(toolsForAgentTurn(toolFixtures, final, 2)).toEqual([]);
  });
});
