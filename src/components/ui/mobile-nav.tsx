"use client";

import { Menu as MenuIcon, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Brand } from "@/components/brand";

import type { NavigationItem, WorkspaceOption } from "./sidebar";
import { WorkspaceSwitcher } from "./sidebar";

export function MobileNav({
  currentWorkspace,
  workspaces,
  navigation,
  account,
}: {
  currentWorkspace: string;
  workspaces?: WorkspaceOption[];
  navigation: NavigationItem[];
  account?: ReactNode;
}) {
  return (
    <header className="mobile-nav">
      <Brand compact />
      <details className="mobile-nav__details">
        <summary aria-label="Toggle navigation" className="mobile-nav__trigger">
          <MenuIcon aria-hidden="true" className="mobile-nav__open-icon" size={20} />
          <X aria-hidden="true" className="mobile-nav__close-icon" size={20} />
        </summary>
        <div className="mobile-nav__panel">
          <WorkspaceSwitcher current={currentWorkspace} workspaces={workspaces} />
          <nav aria-label="Workspace" className="mobile-nav__links">
            {navigation.map((item) => (
              <Link
                aria-current={item.active ? "page" : undefined}
                className="mobile-nav__link"
                href={item.href}
                key={`${item.href}-${item.label}`}
                onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge ? <span className="mobile-nav__badge">{item.badge}</span> : null}
              </Link>
            ))}
          </nav>
          {account ? <div className="mobile-nav__account">{account}</div> : null}
        </div>
      </details>
    </header>
  );
}
