"use client";

import Link from "next/link";
import {
  createContext,
  useActionState,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { STATUS_TRANSITIONS } from "@/lib/recommendations/transitions";
import { Button } from "./ui/form";

/**
 * Reopening a verified fix that came back, from the agency Overview. It
 * submits exactly what the Recommendations page submits to the existing
 * status action (`status` PROPOSED, `from` COMPLETED): the same membership
 * and role check, tenant scope, stale-page check, Reopen guard and history
 * row. Nothing here changes a status by itself.
 *
 * A successful reopen refreshes the Overview, and the task leaves "Verified
 * fixes that came back", so its own message would vanish with it: results
 * are shown by `AttentionNotices`, which stays put above the list.
 */

type Notice = { tone: "success" | "error"; text: string; href: string };

const NoticeContext = createContext<(n: Notice) => void>(() => {});

/** Where reopen results appear; keeps the latest one until dismissed. */
export function AttentionNotices({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <NoticeContext value={setNotice}>
      <div aria-live="polite">
        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`mx-5 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm ${
              notice.tone === "error"
                ? "bg-danger-50 text-danger-700"
                : "bg-success-50 text-success-700"
            }`}
          >
            <span className="min-w-0 flex-1 basis-56">{notice.text}</span>
            <Link href={notice.href} className="underline">
              Open task
            </Link>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-xs underline"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      {children}
    </NoticeContext>
  );
}

const REOPEN = STATUS_TRANSITIONS.COMPLETED.find((t) => t.to === "PROPOSED")!;

/** One Reopen button for one task; disabled while its request runs. */
export function ReopenFromOverview({
  action,
  title,
  href,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  title: string;
  href: string;
}) {
  const notify = useContext(NoticeContext);
  // Reported from the action itself (not an effect): the refresh that comes
  // with a success can unmount this button before an effect would run.
  const [, formAction, pending] = useActionState(
    async (prev: FormState, formData: FormData) => {
      let result: FormState;
      try {
        result = await action(prev, formData);
      } catch {
        // The request failed: whether the server applied it is unknown, so
        // say so rather than claim nothing changed.
        result = {
          error:
            "The request did not complete. Open the task to check its status before trying again.",
        };
      }
      if (result?.ok)
        notify({
          tone: "success",
          text: `${result.ok} “${title}” is back on the to-do list.`,
          href,
        });
      else if (result?.error)
        notify({ tone: "error", text: `“${title}”: ${result.error}`, href });
      return result;
    },
    undefined,
  );
  return (
    <form action={formAction} className="mt-1" aria-label={`Reopen “${title}”`}>
      <input type="hidden" name="from" value="COMPLETED" />
      <input type="hidden" name="status" value={REOPEN.to} />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending ? "Reopening…" : REOPEN.label}
      </Button>
    </form>
  );
}
