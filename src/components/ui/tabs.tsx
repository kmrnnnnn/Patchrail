import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "./utils";

export type TabItem = {
  label: ReactNode;
  href: string;
  active?: boolean;
  count?: number;
};

export function Tabs({
  items,
  label = "Sections",
  className,
}: {
  items: TabItem[];
  label?: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("tabs", className)}>
      {items.map((item) => (
        <Link
          aria-current={item.active ? "page" : undefined}
          className={cn("tabs__item", item.active && "tabs__item--active")}
          href={item.href}
          key={item.href}
        >
          {item.label}
          {typeof item.count === "number" ? (
            <span className="tabs__count">{item.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
