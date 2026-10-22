"use client";

import { useActionState, type ReactNode } from "react";
import type { ButtonSize, ButtonVariant } from "./button";
import { Button, inputClass } from "./form";

type State =
  | {
      error?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      ok?: string;
    }
  | undefined;

/** Generic form for server actions using useActionState; fields come in as children. */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  variant = "primary",
  size,
  children,
  className = "flex flex-col gap-4",
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  submitLabel: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const fieldErrors = Object.values(state?.fieldErrors ?? {})
    .flat()
    .filter(Boolean);
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant={variant}
          size={size}
          disabled={pending}
          aria-busy={pending || undefined}
        >
          {pending ? pendingLabel : submitLabel}
        </Button>
        {(state?.error || fieldErrors.length > 0) && (
          <span role="alert" className="text-sm text-danger-700">
            {[state?.error, ...fieldErrors].filter(Boolean).join(" ")}
          </span>
        )}
        {state?.ok && (
          <span role="status" className="text-sm text-success-700">
            {state.ok}
          </span>
        )}
      </div>
    </form>
  );
}

export { inputClass };
