import type { Metadata } from "next";
import { BillingPanel } from "@/components/billing";
import { PageHeader } from "@/components/ui";
import { getBillingPageData } from "@/billing";
import { getWorkspaceContext } from "@/server/session";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage() {
  const { workspace } = await getWorkspaceContext();
  const billing = await getBillingPageData(workspace.id);

  return (
    <div className="product-page">
      <PageHeader
        eyebrow="Settings"
        title="Billing"
        description="Manage the plan, payment method, invoices, and renewal for this workspace."
      />
      <BillingPanel initialData={billing} />
    </div>
  );
}
