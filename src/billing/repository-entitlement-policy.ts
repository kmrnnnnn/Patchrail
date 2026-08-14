export function selectEnabledRepositoriesWithinLimit(input: {
  orderedRepositoryIds: string[];
  activeRepositoryIds: ReadonlySet<string>;
  limit: number;
}): { keepIds: string[]; disableIds: string[]; activeExcess: number } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
    throw new TypeError("Repository entitlement limit must be a non-negative integer");
  }

  const activeIds = input.orderedRepositoryIds.filter((id) => input.activeRepositoryIds.has(id));
  const inactiveSlots = Math.max(0, input.limit - activeIds.length);
  const inactiveIds = input.orderedRepositoryIds
    .filter((id) => !input.activeRepositoryIds.has(id))
    .slice(0, inactiveSlots);
  const keep = new Set([...activeIds, ...inactiveIds]);

  return {
    keepIds: input.orderedRepositoryIds.filter((id) => keep.has(id)),
    disableIds: input.orderedRepositoryIds.filter((id) => !keep.has(id)),
    // Active work is never invalidated mid-run. This temporary excess is
    // removed on the next entitlement check after those runs become terminal.
    activeExcess: Math.max(0, activeIds.length - input.limit),
  };
}
