import { describe, expect, it } from "vitest";
import { selectEnabledRepositoriesWithinLimit } from "@/billing/repository-entitlement-policy";

describe("repository entitlement policy", () => {
  it("keeps the first repositories in deterministic creation order", () => {
    expect(
      selectEnabledRepositoriesWithinLimit({
        orderedRepositoryIds: ["oldest", "middle", "newest"],
        activeRepositoryIds: new Set(),
        limit: 1,
      }),
    ).toEqual({ keepIds: ["oldest"], disableIds: ["middle", "newest"], activeExcess: 0 });
  });

  it("preserves active work before allocating remaining plan slots", () => {
    expect(
      selectEnabledRepositoriesWithinLimit({
        orderedRepositoryIds: ["old-idle", "active", "new-idle"],
        activeRepositoryIds: new Set(["active"]),
        limit: 2,
      }),
    ).toEqual({
      keepIds: ["old-idle", "active"],
      disableIds: ["new-idle"],
      activeExcess: 0,
    });
  });

  it("temporarily retains active runs beyond the limit but disables every idle repository", () => {
    expect(
      selectEnabledRepositoriesWithinLimit({
        orderedRepositoryIds: ["active-a", "idle", "active-b"],
        activeRepositoryIds: new Set(["active-a", "active-b"]),
        limit: 1,
      }),
    ).toEqual({
      keepIds: ["active-a", "active-b"],
      disableIds: ["idle"],
      activeExcess: 1,
    });
  });
});
