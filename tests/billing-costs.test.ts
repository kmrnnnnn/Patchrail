import { describe, expect, it } from "vitest";
import {
  calculateBudgetAvailability,
  calculateReservationAccounting,
  microsToUsd,
  usdToMicros,
  utcCalendarMonth,
  validateCumulativeRunCost,
} from "@/billing/cost-policy";

describe("billing cost policy", () => {
  it("calculates remaining budget in integer micro-dollars", () => {
    expect(
      calculateBudgetAvailability({
        budgetUsd: "10.000000",
        spentUsd: "2.100001",
        reservedUsd: "3.200002",
        requestedUsd: "4.699997",
      }),
    ).toMatchObject({ remainingMicros: 4_699_997, requestedMicros: 4_699_997, allowed: true });
  });

  it("rejects even a one-micro-dollar oversubscription", () => {
    const result = calculateBudgetAvailability({
      budgetUsd: "1.000000",
      spentUsd: "0.500000",
      reservedUsd: "0.400000",
      requestedUsd: "0.100001",
    });
    expect(result.allowed).toBe(false);
    expect(microsToUsd(result.remainingMicros)).toBe("0.100000");
  });

  it("rounds external numeric amounts to the database precision", () => {
    expect(usdToMicros(0.0000006)).toBe(1);
    expect(microsToUsd(1)).toBe("0.000001");
  });

  it("creates UTC calendar boundaries", () => {
    expect(utcCalendarMonth(new Date("2026-08-13T22:00:00-04:00"))).toEqual({
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("keeps incurred spend and unused authorization committed while paused", () => {
    const accounting = calculateReservationAccounting({
      status: "RESERVED",
      authorizedUsd: "10.000000",
      incurredUsd: "2.750000",
    });
    expect(accounting).toMatchObject({ spentMicros: 2_750_000, reservedMicros: 7_250_000 });
    expect(accounting.spentMicros + accounting.reservedMicros).toBe(accounting.authorizedMicros);
  });

  it("releases only unused authorization after final settlement", () => {
    expect(
      calculateReservationAccounting({
        status: "SETTLED",
        authorizedUsd: "10.000000",
        incurredUsd: "4.125000",
      }),
    ).toMatchObject({ spentMicros: 4_125_000, reservedMicros: 0 });
  });

  it("prevents a resumed run from decreasing already-incurred cost", () => {
    expect(() =>
      validateCumulativeRunCost({
        authorizedUsd: "10.000000",
        previouslyIncurredUsd: "2.750000",
        cumulativeActualUsd: "2.749999",
      }),
    ).toThrow("cannot decrease");
  });

  it("prevents a resumed run from exceeding its original authorization", () => {
    expect(() =>
      validateCumulativeRunCost({
        authorizedUsd: "10.000000",
        previouslyIncurredUsd: "2.750000",
        cumulativeActualUsd: "10.000001",
      }),
    ).toThrow("cannot exceed");
  });

  it("allows an idempotent or increasing cumulative checkpoint", () => {
    expect(
      validateCumulativeRunCost({
        authorizedUsd: "10.000000",
        previouslyIncurredUsd: "2.750000",
        cumulativeActualUsd: "2.750000",
      }).reservedMicros,
    ).toBe(7_250_000);
    expect(
      validateCumulativeRunCost({
        authorizedUsd: "10.000000",
        previouslyIncurredUsd: "2.750000",
        cumulativeActualUsd: "4.000000",
      }).reservedMicros,
    ).toBe(6_000_000);
  });
});
