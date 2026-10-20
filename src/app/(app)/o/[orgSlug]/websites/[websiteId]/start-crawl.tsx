"use client";

import { useActionState } from "react";
import type { ButtonSize, ButtonVariant } from "@/components/ui/button";
import { Button } from "@/components/ui/form";
import type { FormState } from "../../actions";

export function StartCrawlButton({
  action,
  label = "Start crawl",
  variant = "primary",
  size = "md",
}: {
  action: (prev: FormState) => Promise<FormState>;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <Button
        type="submit"
        variant={variant}
        size={size}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending ? "Starting…" : label}
      </Button>
      {state?.error && (
        <span className="text-sm text-danger-700">{state.error}</span>
      )}
      {state?.ok && (
        <span className="text-sm text-success-700">{state.ok}</span>
      )}
    </form>
  );
}
