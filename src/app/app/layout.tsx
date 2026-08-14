import { cookies } from "next/headers";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/constants";
import { getUserWorkspaces, requireSession } from "@/server/session";
import "./product.css";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function ProductLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const workspaces = await getUserWorkspaces(session.user.id);
  if (workspaces.length === 0) return <div className="onboarding-frame">{children}</div>;

  const cookieStore = await cookies();
  const selectedId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const current = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0]!;
  return (
    <AppShell
      currentWorkspace={{ id: current.id, name: current.name }}
      user={{
        name: session.user.name,
        email: session.user.email,
        image: session.user.image,
      }}
      workspaces={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
    >
      {children}
    </AppShell>
  );
}
