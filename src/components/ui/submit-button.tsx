"use client";

import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "./button";

export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  disabled,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();

  return (
    <Button disabled={disabled || pending} loading={pending} type="submit" {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
