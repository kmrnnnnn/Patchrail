import { ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Brand } from "@/components/brand";

import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./menu";
import { cn } from "./utils";

export type NavigationItem = {
  label: string;
  href: string;
  icon?: ReactNode;
  active?: boolean;
  badge?: ReactNode;
};

export type WorkspaceOption = {
  id: string;
  name: string;
  href?: string;
  onSelect?: () => void;
  active?: boolean;
};

export function WorkspaceSwitcher({
  current,
  workspaces = [],
}: {
  current: string;
  workspaces?: WorkspaceOption[];
}) {
  return (
    <Menu
      align="start"
      className="workspace-switcher"
      label={
        <span className="workspace-switcher__label">
          <span aria-hidden="true" className="workspace-switcher__avatar">
            {current.slice(0, 1).toUpperCase()}
          </span>
          <span className="workspace-switcher__name">{current}</span>
          <ChevronsUpDown aria-hidden="true" className="workspace-switcher__chevrons" size={14} />
        </span>
      }
    >
      <MenuLabel>Workspaces</MenuLabel>
      {workspaces.map((workspace) => (
        <MenuItem href={workspace.href} key={workspace.id} onClick={workspace.onSelect}>
          <span className="workspace-switcher__option">
            <span aria-hidden="true" className="workspace-switcher__option-avatar">
              {workspace.name.slice(0, 1).toUpperCase()}
            </span>
            <span>{workspace.name}</span>
            {workspace.active ? <span className="workspace-switcher__current">Current</span> : null}
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem href="/app/workspaces/new" icon={<Plus size={15} />}>
        Create workspace
      </MenuItem>
    </Menu>
  );
}

export function Sidebar({
  currentWorkspace,
  workspaces,
  navigation,
  secondaryNavigation,
  account,
  className,
}: {
  currentWorkspace: string;
  workspaces?: WorkspaceOption[];
  navigation: NavigationItem[];
  secondaryNavigation?: NavigationItem[];
  account?: ReactNode;
  className?: string;
}) {
  return (
    <aside className={cn("sidebar", className)}>
      <div className="sidebar__brand">
        <Brand />
      </div>
      <WorkspaceSwitcher current={currentWorkspace} workspaces={workspaces} />
      <SidebarNavigation items={navigation} label="Workspace" />
      <div className="sidebar__spacer" />
      {secondaryNavigation ? (
        <SidebarNavigation items={secondaryNavigation} label="Settings" />
      ) : null}
      {account ? <div className="sidebar__account">{account}</div> : null}
    </aside>
  );
}

export function SidebarNavigation({ items, label }: { items: NavigationItem[]; label: string }) {
  return (
    <nav aria-label={label} className="sidebar-nav">
      {items.map((item) => (
        <Link
          aria-current={item.active ? "page" : undefined}
          className={cn("sidebar-nav__item", item.active && "sidebar-nav__item--active")}
          href={item.href}
          key={item.href}
        >
          {item.icon ? <span className="sidebar-nav__icon">{item.icon}</span> : null}
          <span>{item.label}</span>
          {item.badge ? <span className="sidebar-nav__badge">{item.badge}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
