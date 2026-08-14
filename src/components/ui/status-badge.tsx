import type { ReactNode } from "react";

import { cn } from "./utils";

export type StatusTone = "neutral" | "info" | "positive" | "warning" | "critical" | "accent";

export function StatusBadge({
  children,
  tone = "neutral",
  dot = false,
  className,
}: {
  children: ReactNode;
  tone?: StatusTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("status-badge", `status-badge--${tone}`, className)}>
      {dot ? <span aria-hidden="true" className="status-badge__dot" /> : null}
      {children}
    </span>
  );
}
