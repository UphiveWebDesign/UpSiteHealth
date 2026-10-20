"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/form";
import type { FormState } from "../../actions";

export function StartCrawlButton({
  action,
}: {
  action: (prev: FormState) => Promise<FormState>;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex items-center gap-3">
      <Button type="submit" disabled={pending}>
        {pending ? "Starting…" : "Start crawl"}
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
