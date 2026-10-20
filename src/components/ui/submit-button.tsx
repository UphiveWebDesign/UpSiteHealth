"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "./form";

export function SubmitButton({
  children,
  pendingLabel,
  variant,
  confirm,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "ghost";
  /** Asks for confirmation before submitting (destructive actions). */
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </Button>
  );
}
