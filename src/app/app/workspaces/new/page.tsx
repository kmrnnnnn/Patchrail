import { ArrowRight } from "lucide-react";
import { ButtonLink, Card, Field, Input, PageHeader, SubmitButton } from "@/components/ui";
import { createWorkspaceAction } from "@/server/workspaces";
import { getWorkspaceContext } from "@/server/session";

export default async function NewWorkspacePage() {
  await getWorkspaceContext();
  return (
    <div className="product-page product-page--narrow">
      <PageHeader
        eyebrow="Workspaces"
        title="Create another workspace"
        description="Repositories, runs, billing, and usage stay isolated between workspaces."
      />
      <Card className="form-card">
        <form action={createWorkspaceAction} className="stack-form">
          <Field htmlFor="workspace-name" label="Workspace name">
            <Input
              autoComplete="organization"
              autoFocus
              id="workspace-name"
              maxLength={80}
              minLength={2}
              name="name"
              placeholder="Platform team"
              required
            />
          </Field>
          <div className="form-actions">
            <ButtonLink href="/app" variant="ghost">
              Cancel
            </ButtonLink>
            <SubmitButton pendingLabel="Creating workspace…">
              Create workspace <ArrowRight size={16} />
            </SubmitButton>
          </div>
        </form>
      </Card>
    </div>
  );
}
