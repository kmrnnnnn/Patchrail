import type { ModelUsage } from "@/runs/types";

export type ModelPricing = {
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  longContextThresholdTokens: number;
  longContextInputUsdPer1M: number;
  longContextCachedInputUsdPer1M: number;
  longContextOutputUsdPer1M: number;
  webSearchUsdPerCall: number;
};

export type AppliedModelPricing = Pick<
  ModelPricing,
  "inputUsdPer1M" | "cachedInputUsdPer1M" | "outputUsdPer1M"
>;

export function modelPricingForInputTokens(
  inputTokens: number,
  pricing: ModelPricing,
): AppliedModelPricing {
  if (inputTokens <= pricing.longContextThresholdTokens) {
    return {
      inputUsdPer1M: pricing.inputUsdPer1M,
      cachedInputUsdPer1M: pricing.cachedInputUsdPer1M,
      outputUsdPer1M: pricing.outputUsdPer1M,
    };
  }

  return {
    inputUsdPer1M: pricing.longContextInputUsdPer1M,
    cachedInputUsdPer1M: pricing.longContextCachedInputUsdPer1M,
    outputUsdPer1M: pricing.longContextOutputUsdPer1M,
  };
}

export function maximumModelPricingForInputLimit(
  inputTokenLimit: number,
  pricing: ModelPricing,
): AppliedModelPricing {
  const standard = modelPricingForInputTokens(0, pricing);
  const maximum = modelPricingForInputTokens(inputTokenLimit, pricing);
  return {
    inputUsdPer1M: Math.max(standard.inputUsdPer1M, maximum.inputUsdPer1M),
    cachedInputUsdPer1M: Math.max(standard.cachedInputUsdPer1M, maximum.cachedInputUsdPer1M),
    outputUsdPer1M: Math.max(standard.outputUsdPer1M, maximum.outputUsdPer1M),
  };
}

export function calculateModelCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    webSearchCalls: number;
  },
  pricing: ModelPricing,
): number {
  const appliedPricing = modelPricingForInputTokens(usage.inputTokens, pricing);
  const cachedInput = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens));
  const uncachedInput = Math.max(0, usage.inputTokens - cachedInput);
  return (
    (uncachedInput / 1_000_000) * appliedPricing.inputUsdPer1M +
    (cachedInput / 1_000_000) * appliedPricing.cachedInputUsdPer1M +
    (usage.outputTokens / 1_000_000) * appliedPricing.outputUsdPer1M +
    usage.webSearchCalls * pricing.webSearchUsdPerCall
  );
}

export function totalModelCost(usages: ModelUsage[]): number {
  return usages.reduce((total, usage) => total + usage.estimatedCostUsd, 0);
}
