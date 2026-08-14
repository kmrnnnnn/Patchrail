"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "./utils";

export function Menu({
  label,
  children,
  align = "end",
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <details className={cn("menu", `menu--${align}`, className)}>
      <summary className="menu__trigger">
        {label}
        <ChevronDown aria-hidden="true" size={15} />
      </summary>
      <div className="menu__content">{children}</div>
    </details>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="menu__label">{children}</p>;
}

export function MenuSeparator() {
  return <div aria-hidden="true" className="menu__separator" />;
}

type MenuItemProps = {
  children: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  href?: string;
  danger?: boolean;
  onClick?: () => void;
};

export function MenuItem({ children, icon, description, href, danger, onClick }: MenuItemProps) {
  const content = (
    <>
      {icon ? <span className="menu-item__icon">{icon}</span> : null}
      <span className="menu-item__body">
        <span>{children}</span>
        {description ? <span className="menu-item__description">{description}</span> : null}
      </span>
    </>
  );
  const className = cn("menu-item", danger && "menu-item--danger");

  return href ? (
    <Link
      className={className}
      href={href}
      onClick={(event) => {
        let details = event.currentTarget.closest("details");
        while (details) {
          details.removeAttribute("open");
          details = details.parentElement?.closest("details") ?? null;
        }
      }}
    >
      {content}
    </Link>
  ) : (
    <button
      className={className}
      onClick={(event) => {
        let details = event.currentTarget.closest("details");
        while (details) {
          details.removeAttribute("open");
          details = details.parentElement?.closest("details") ?? null;
        }
        onClick?.();
      }}
      type="button"
    >
      {content}
    </button>
  );
}

export const Dropdown = Menu;
