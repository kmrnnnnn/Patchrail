import type { ModelUsage } from "@/runs/types";

export type ModelPricing = {
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  webSearchUsdPerCall: number;
};

export function calculateModelCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    webSearchCalls: number;
  },
  pricing: ModelPricing,
): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedInput / 1_000_000) * pricing.inputUsdPer1M +
    (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputUsdPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputUsdPer1M +
    usage.webSearchCalls * pricing.webSearchUsdPerCall
  );
}

export function totalModelCost(usages: ModelUsage[]): number {
  return usages.reduce((total, usage) => total + usage.estimatedCostUsd, 0);
}
