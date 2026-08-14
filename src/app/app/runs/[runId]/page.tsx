import { notFound } from "next/navigation";
import { RunProgress } from "@/components/run-progress";
import { getRunDetail } from "@/server/queries";
import { getWorkspaceContext } from "@/server/session";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { workspace } = await getWorkspaceContext();
  const { runId } = await params;
  const detail = await getRunDetail(workspace.id, runId);
  if (!detail) notFound();
  return (
    <div className="product-page">
      <RunProgress initial={JSON.parse(JSON.stringify(detail))} />
    </div>
  );
}
