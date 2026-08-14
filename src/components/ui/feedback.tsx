import { AlertCircle, CheckCircle2, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { ButtonLink } from "./button";
import { cn } from "./utils";

type AlertTone = "info" | "success" | "warning" | "critical";

const alertIcons: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  critical: AlertCircle,
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: AlertTone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = alertIcons[tone];
  return (
    <div className={cn("alert", `alert--${tone}`)} role={tone === "critical" ? "alert" : "status"}>
      <Icon aria-hidden="true" className="alert__icon" size={18} />
      <div className="alert__body">
        <p className="alert__title">{title}</p>
        {children ? <div className="alert__content">{children}</div> : null}
      </div>
      {action ? <div className="alert__action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton", className)} {...props} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty-state", className)}>
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__description">{description}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

export function NotFoundState() {
  return (
    <EmptyState
      action={<ButtonLink href="/app">Back to overview</ButtonLink>}
      title="Nothing here"
      description="This page may have moved, or you may not have access to it."
    />
  );
}
