import { gte, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { costReservations } from "@/db/schema";
import {
  calculateBoundedRunReservation,
  calculateBudgetAvailability,
  calculateReservationAccounting,
  microsToUsd,
  usdToMicros,
  utcCalendarMonth,
  validateCumulativeRunCost,
} from "@/billing/cost-policy";

describe("billing cost policy", () => {
  it("encodes computed timestamp boundaries before postgres binding", () => {
    const boundary = new Date("2026-08-15T13:26:45.614Z");
    const accountedAt = sql<Date>`coalesce(${costReservations.settledAt}, ${costReservations.createdAt})`;
    const condition = gte(accountedAt, sql.param(boundary, costReservations.createdAt));

    expect(new PgDialect().sqlToQuery(condition).params).toEqual([boundary.toISOString()]);
  });

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

  it("counts prior provider-boundary spend once and bounds a fresh run to the remainder", () => {
    const failedRun = calculateReservationAccounting({
      status: "SETTLED",
      authorizedUsd: "5.000000",
      incurredUsd: "2.000000",
    });
    const freshRun = calculateBoundedRunReservation({
      budgetUsd: "5.000000",
      spentUsd: microsToUsd(failedRun.spentMicros),
      reservedUsd: microsToUsd(failedRun.reservedMicros),
      ceilingUsd: "5.000000",
    });

    expect(freshRun).toMatchObject({
      spentMicros: 2_000_000,
      ceilingMicros: 5_000_000,
      amountMicros: 3_000_000,
      remainingAfterMicros: 0,
      allowed: true,
    });
    expect(failedRun.spentMicros + freshRun.amountMicros).toBe(freshRun.budgetMicros);
  });

  it("does not create a bounded authorization when the workspace budget is exhausted", () => {
    expect(
      calculateBoundedRunReservation({
        budgetUsd: "5.000000",
        spentUsd: "2.000000",
        reservedUsd: "3.000000",
        ceilingUsd: "5.000000",
      }),
    ).toMatchObject({ amountMicros: 0, remainingAfterMicros: 0, allowed: false });
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
