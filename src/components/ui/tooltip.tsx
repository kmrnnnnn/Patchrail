import { useId, type ReactNode } from "react";

import { cn } from "./utils";

export function Tooltip({
  children,
  content,
  side = "top",
  className,
}: {
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  const id = useId();
  return (
    <span aria-describedby={id} className={cn("tooltip", className)} tabIndex={0}>
      {children}
      <span className={cn("tooltip__content", `tooltip__content--${side}`)} id={id} role="tooltip">
        {content}
      </span>
    </span>
  );
}
