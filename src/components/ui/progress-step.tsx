import { Check, Circle, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "./utils";

export type ProgressStatus = "pending" | "current" | "complete" | "error";

export function ProgressStep({
  title,
  description,
  status,
  last = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  status: ProgressStatus;
  last?: boolean;
  children?: ReactNode;
}) {
  const icon =
    status === "complete" ? (
      <Check size={15} />
    ) : status === "current" ? (
      <LoaderCircle className="progress-step__spinner" size={15} />
    ) : status === "error" ? (
      <X size={15} />
    ) : (
      <Circle size={10} />
    );

  return (
    <li
      aria-current={status === "current" ? "step" : undefined}
      className={cn("progress-step", `progress-step--${status}`)}
    >
      <div className="progress-step__rail" aria-hidden="true">
        <span className="progress-step__icon">{icon}</span>
        {!last ? <span className="progress-step__line" /> : null}
      </div>
      <div className="progress-step__body">
        <p className="progress-step__title">{title}</p>
        {description ? <p className="progress-step__description">{description}</p> : null}
        {children}
      </div>
    </li>
  );
}
