"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ButtonSize, ButtonVariant } from "./button";
import { Button } from "./form";

export function SubmitButton({
  children,
  pendingLabel,
  variant,
  size,
  confirm,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Asks for confirmation before submitting (destructive actions). */
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </Button>
  );
}
