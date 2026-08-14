import { ArrowRight } from "lucide-react";
import { Brand } from "@/components/brand";
import { Card, Field, Input, SubmitButton } from "@/components/ui";
import { createWorkspaceAction } from "@/server/workspaces";
import { getUserWorkspaces, requireSession } from "@/server/session";
import { redirect } from "next/navigation";

export default async function OnboardingPage() {
  const session = await requireSession();
  if ((await getUserWorkspaces(session.user.id)).length > 0) redirect("/app");

  return (
    <div className="onboarding-page">
      <Brand />
      <Card className="onboarding-card">
        <span className="eyebrow">One quick setup step</span>
        <h1>Create your workspace</h1>
        <p>
          Your workspace keeps repository access, runs, usage, and billing isolated. You can create
          more later.
        </p>
        <form action={createWorkspaceAction} className="stack-form">
          <Field
            htmlFor="workspace-name"
            hint="Usually your team or project name."
            label="Workspace name"
          >
            <Input
              autoComplete="organization"
              autoFocus
              id="workspace-name"
              maxLength={80}
              minLength={2}
              name="name"
              placeholder="Acme Engineering"
              required
            />
          </Field>
          <SubmitButton pendingLabel="Creating workspace…" size="lg">
            Create workspace <ArrowRight size={17} />
          </SubmitButton>
        </form>
      </Card>
      <p className="onboarding-note">Signed in as {session.user.email}</p>
    </div>
  );
}
