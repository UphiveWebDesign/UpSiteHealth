"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "./form";

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
  children,
  className = "flex flex-col gap-3",
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  submitLabel: string;
  pendingLabel?: string;
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
        <Button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {(state?.error || fieldErrors.length > 0) && (
          <span role="alert" className="text-sm text-red-600 dark:text-red-400">
            {[state?.error, ...fieldErrors].filter(Boolean).join(" ")}
          </span>
        )}
        {state?.ok && (
          <span
            role="status"
            className="text-sm text-emerald-700 dark:text-emerald-400"
          >
            {state.ok}
          </span>
        )}
      </div>
    </form>
  );
}

export const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
