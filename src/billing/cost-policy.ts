const USD_SCALE = 1_000_000;

export type BudgetCalculation = {
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
  remainingMicros: number;
  requestedMicros: number;
  allowed: boolean;
};

export type ReservationAccounting = {
  authorizedMicros: number;
  incurredMicros: number;
  reservedMicros: number;
  spentMicros: number;
};

export type ReservationStatus = "RESERVED" | "SETTLED" | "RELEASED";

export function usdToMicros(value: string | number): number {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError("USD amount must be a finite, non-negative number");
  }

  const micros = Math.round(normalized * USD_SCALE);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError("USD amount is too large");
  }
  return micros;
}

export function microsToUsd(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new TypeError("Micro-dollar amount must be a non-negative safe integer");
  }
  return (micros / USD_SCALE).toFixed(6);
}

export function calculateBudgetAvailability(input: {
  budgetUsd: string | number;
  spentUsd: string | number;
  reservedUsd: string | number;
  requestedUsd: string | number;
}): BudgetCalculation {
  const budgetMicros = usdToMicros(input.budgetUsd);
  const spentMicros = usdToMicros(input.spentUsd);
  const reservedMicros = usdToMicros(input.reservedUsd);
  const requestedMicros = usdToMicros(input.requestedUsd);
  const remainingMicros = Math.max(0, budgetMicros - spentMicros - reservedMicros);

  return {
    budgetMicros,
    spentMicros,
    reservedMicros,
    remainingMicros,
    requestedMicros,
    allowed: requestedMicros > 0 && requestedMicros <= remainingMicros,
  };
}

/**
 * Splits one reservation into the amount already incurred and the amount that
 * must remain unavailable to other runs. A RESERVED row can therefore survive
 * a human-input pause without either forgetting spend or authorizing it twice.
 */
export function calculateReservationAccounting(input: {
  status: ReservationStatus;
  authorizedUsd: string | number;
  incurredUsd: string | number | null;
}): ReservationAccounting {
  const authorizedMicros = usdToMicros(input.authorizedUsd);
  const incurredMicros = usdToMicros(input.incurredUsd ?? 0);
  if (incurredMicros > authorizedMicros) {
    throw new RangeError("Incurred cost cannot exceed the authorized run cost");
  }

  if (input.status === "RELEASED") {
    return { authorizedMicros, incurredMicros: 0, reservedMicros: 0, spentMicros: 0 };
  }
  if (input.status === "SETTLED") {
    return { authorizedMicros, incurredMicros, reservedMicros: 0, spentMicros: incurredMicros };
  }
  return {
    authorizedMicros,
    incurredMicros,
    reservedMicros: authorizedMicros - incurredMicros,
    spentMicros: incurredMicros,
  };
}

/** Enforces cumulative, monotonic cost reporting for checkpoints and settlement. */
export function validateCumulativeRunCost(input: {
  authorizedUsd: string | number;
  previouslyIncurredUsd: string | number | null;
  cumulativeActualUsd: string | number;
}): ReservationAccounting {
  const previousMicros = usdToMicros(input.previouslyIncurredUsd ?? 0);
  const accounting = calculateReservationAccounting({
    status: "RESERVED",
    authorizedUsd: input.authorizedUsd,
    incurredUsd: input.cumulativeActualUsd,
  });
  if (accounting.incurredMicros < previousMicros) {
    throw new RangeError("Cumulative run cost cannot decrease");
  }
  return accounting;
}

export function utcCalendarMonth(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}
