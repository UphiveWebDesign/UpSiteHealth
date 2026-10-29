"use client";

import { useActionState, useId } from "react";
import type { SeoFindingStatus } from "@/generated/prisma/enums";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { FINDING_ACTION } from "@/lib/seo/finding-status";
import { Button } from "./ui/form";

/**
 * Ignore or reopen one finding, with the result beside it (the same pattern
 * as TaskStatusActions). `from` tells the server which status the page
 * showed, so a change made meanwhile is reported rather than overwritten.
 * Resolved findings have no action.
 */
export function FindingStatusAction({
  action,
  status,
  title,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  status: SeoFindingStatus;
  title: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const messageId = useId();
  const next = FINDING_ACTION[status];
  return (
    <form
      action={formAction}
      className="flex flex-wrap items-center justify-end gap-2"
      aria-label={`Change the status of “${title}”`}
    >
      <input type="hidden" name="from" value={status} />
      {next && (
        <Button
          type="submit"
          name="status"
          value={next.to}
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-busy={pending || undefined}
          aria-describedby={state ? messageId : undefined}
        >
          {next.label}
        </Button>
      )}
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
