"use client";

import { useActionState, useId } from "react";
import type { RecommendationStatus } from "@/generated/prisma/enums";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { STATUS_TRANSITIONS } from "@/lib/recommendations/transitions";
import { Button } from "./ui/form";

/**
 * A task's status buttons on the Recommendations page, as one form: the
 * clicked button sends its target status, and `from` tells the server which
 * status the page showed, so a change made meanwhile is reported rather than
 * overwritten. One form per task keeps the message beside that task even
 * when the page refreshes and the buttons change.
 */
export function TaskStatusActions({
  action,
  status,
  title,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  status: RecommendationStatus;
  title: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const messageId = useId();
  return (
    <form
      action={formAction}
      className="flex flex-wrap items-center gap-2"
      aria-label={`Change the status of “${title}”`}
    >
      <input type="hidden" name="from" value={status} />
      {STATUS_TRANSITIONS[status].map((t) => (
        <Button
          key={t.to}
          type="submit"
          name="status"
          value={t.to}
          variant={t.primary ? "primary" : "ghost"}
          size="sm"
          disabled={pending}
          aria-busy={pending || undefined}
          aria-describedby={state ? messageId : undefined}
        >
          {t.label}
        </Button>
      ))}
      {state?.error && (
        <span id={messageId} role="alert" className="text-sm text-danger-700">
          {state.error}
        </span>
      )}
      {state?.ok && (
        <span id={messageId} role="status" className="text-sm text-success-700">
          {state.ok}
        </span>
      )}
    </form>
  );
}
