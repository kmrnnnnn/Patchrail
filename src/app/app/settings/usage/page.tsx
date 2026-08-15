import type { Metadata } from "next";
import { getUsageSummary } from "@/billing";
import { UsagePanel } from "@/components/billing";
import { PageHeader } from "@/components/ui";
import { getWorkspaceContext } from "@/server/session";

export const metadata: Metadata = { title: "Usage" };

export default async function UsagePage() {
  const { workspace } = await getWorkspaceContext();
  const usage = await getUsageSummary(workspace.id);

  return (
    <div className="product-page">
      <PageHeader
        eyebrow="Settings"
        title="Usage"
        description="See this workspace’s Patchrail updates, outcomes, and recent repository activity."
      />
      <UsagePanel summary={usage} />
    </div>
  );
}
