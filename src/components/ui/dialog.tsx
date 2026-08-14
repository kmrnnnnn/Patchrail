"use client";

import { X } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";

import { IconButton } from "./button";
import { cn } from "./utils";

type DialogProps = {
  trigger: ReactElement<{ onClick?: (event: MouseEvent) => void }>;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function Dialog({ trigger, title, description, children, footer, className }: DialogProps) {
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();

  function open(event: MouseEvent) {
    trigger.props.onClick?.(event);
    if (!event.defaultPrevented) {
      const dialog = document.getElementById(dialogId);
      if (dialog instanceof HTMLDialogElement) dialog.showModal();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  function close() {
    const dialog = document.getElementById(dialogId);
    if (dialog instanceof HTMLDialogElement) dialog.close();
  }

  return (
    <>
      {isValidElement(trigger) ? cloneElement(trigger, { onClick: open }) : trigger}
      <dialog
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        className={cn("dialog", className)}
        id={dialogId}
        onClick={handleBackdrop}
      >
        <div className="dialog__panel">
          <div className="dialog__header">
            <div>
              <h2 className="dialog__title" id={titleId}>
                {title}
              </h2>
              {description ? (
                <p className="dialog__description" id={descriptionId}>
                  {description}
                </p>
              ) : null}
            </div>
            <IconButton aria-label="Close dialog" onClick={close}>
              <X size={18} />
            </IconButton>
          </div>
          {children ? <div className="dialog__content">{children}</div> : null}
          {footer ? <div className="dialog__footer">{footer}</div> : null}
        </div>
      </dialog>
    </>
  );
}

export function DialogClose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <form className={className} method="dialog">
      {children}
    </form>
  );
}
