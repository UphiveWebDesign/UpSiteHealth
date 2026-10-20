"use client";

import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { XCircleIcon } from "@/components/ui/icons";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-xl border border-line bg-surface p-8 text-center shadow-card">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger-50 text-danger-700">
        <XCircleIcon className="h-5 w-5" />
      </div>
      <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
      <p className="mt-1 text-sm text-muted">
        The page could not be loaded. Try again; if it keeps happening, contact
        your organization owner
        {error.digest ? ` and mention reference ${error.digest}` : ""}.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <button onClick={reset} className={buttonClass("primary")}>
          Try again
        </button>
        <Link href="/dashboard" className={buttonClass("secondary")}>
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
