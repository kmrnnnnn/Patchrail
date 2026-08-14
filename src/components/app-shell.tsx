"use client";

import {
  AlertTriangle,
  Boxes,
  CreditCard,
  Gauge,
  LayoutDashboard,
  LogOut,
  Settings,
  UserRound,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
import { authClient } from "@/auth/client";
import { MobileNav, Sidebar } from "@/components/ui";

type Workspace = { id: string; name: string };

export function AppShell({
  children,
  currentWorkspace,
  workspaces,
  user,
}: {
  children: ReactNode;
  currentWorkspace: Workspace;
  workspaces: Workspace[];
  user: { name: string; email: string; image?: string | null };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const isActive = (href: string) =>
    href === "/app" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const mainNavigation = [
    {
      label: "Overview",
      href: "/app",
      icon: <LayoutDashboard size={18} />,
      active: isActive("/app"),
    },
    {
      label: "Repositories",
      href: "/app/repositories",
      icon: <Boxes size={18} />,
      active: isActive("/app/repositories"),
    },
    {
      label: "Usage",
      href: "/app/settings/usage",
      icon: <Gauge size={18} />,
      active: isActive("/app/settings/usage"),
    },
    {
      label: "Settings",
      href: "/app/settings/integrations",
      icon: <Settings size={18} />,
      active: isActive("/app/settings/integrations"),
    },
  ];
  const settingsNavigation = [
    {
      label: "Billing",
      href: "/app/settings/billing",
      icon: <CreditCard size={17} />,
      active: isActive("/app/settings/billing"),
    },
    {
      label: "Account",
      href: "/app/settings/account",
      icon: <UserRound size={17} />,
      active: isActive("/app/settings/account"),
    },
  ];
  const workspaceOptions = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    onSelect:
      workspace.id === currentWorkspace.id
        ? undefined
        : async () => {
            setShellError(null);
            try {
              const response = await fetch(`/app/workspaces/${workspace.id}/select`, {
                method: "POST",
              });
              if (!response.ok) throw new Error("Workspace switch failed");
              router.push("/app");
              router.refresh();
            } catch {
              setShellError("Patchrail could not switch workspaces. Please try again.");
            }
          },
    active: workspace.id === currentWorkspace.id,
  }));
  const account = (
    <div className="app-account">
      <div className="app-account__avatar" aria-hidden="true">
        {user.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="app-account__identity">
        <strong>{user.name}</strong>
        <span>{user.email}</span>
      </div>
      <button
        aria-label="Sign out"
        className="app-account__signout"
        disabled={signingOut}
        title="Sign out"
        onClick={async () => {
          setSigningOut(true);
          setShellError(null);
          try {
            const result = await authClient.signOut();
            if (result.error) throw new Error(result.error.message);
            router.push("/");
            router.refresh();
          } catch {
            setShellError("Patchrail could not sign you out. Please try again.");
          } finally {
            setSigningOut(false);
          }
        }}
        type="button"
      >
        <LogOut size={17} />
      </button>
    </div>
  );

  return (
    <div className="app-frame">
      <a className="skip-link" href="#app-main-content">
        Skip to content
      </a>
      <Sidebar
        account={account}
        className="app-frame__sidebar"
        currentWorkspace={currentWorkspace.name}
        navigation={mainNavigation}
        secondaryNavigation={settingsNavigation}
        workspaces={workspaceOptions}
      />
      <MobileNav
        account={account}
        currentWorkspace={currentWorkspace.name}
        navigation={[...mainNavigation, ...settingsNavigation]}
        workspaces={workspaceOptions}
      />
      {shellError ? (
        <div className="app-shell-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} /> {shellError}
        </div>
      ) : null}
      <main className="app-main" id="app-main-content">
        {children}
      </main>
    </div>
  );
}
