import { describe, expect, it } from "vitest";
import { calculateModelCost, maximumModelPricingForInputLimit, type ModelPricing } from "@/ai/cost";

const pricing: ModelPricing = {
  inputUsdPer1M: 2,
  cachedInputUsdPer1M: 0.2,
  outputUsdPer1M: 12,
  longContextThresholdTokens: 272_000,
  longContextInputUsdPer1M: 4,
  longContextCachedInputUsdPer1M: 0.4,
  longContextOutputUsdPer1M: 18,
  webSearchUsdPerCall: 0.01,
};

describe("AI model cost", () => {
  it("uses the standard tier at the threshold", () => {
    expect(
      calculateModelCost(
        {
          inputTokens: 272_000,
          cachedInputTokens: 72_000,
          outputTokens: 1_000,
          webSearchCalls: 2,
        },
        pricing,
      ),
    ).toBeCloseTo(0.4464, 10);
  });

  it("prices the full request at the long-context tier above the threshold", () => {
    expect(
      calculateModelCost(
        {
          inputTokens: 272_001,
          cachedInputTokens: 72_001,
          outputTokens: 1_000,
          webSearchCalls: 2,
        },
        pricing,
      ),
    ).toBeCloseTo(0.8668004, 10);
  });

  it("selects conservative token rates for a call that can cross the threshold", () => {
    expect(maximumModelPricingForInputLimit(400_000, pricing)).toEqual({
      inputUsdPer1M: 4,
      cachedInputUsdPer1M: 0.4,
      outputUsdPer1M: 18,
    });
  });
});
