import type { ReactNode } from "react";

/**
 * Progressive disclosure on native <details>: keyboard and screen-reader
 * support come from the browser, and the content stays in the page (print,
 * find-in-page). The summary always says what is inside.
 */
export function Disclosure({
  summary,
  children,
  open = false,
  className = "",
}: {
  /** What the section holds, e.g. "Evidence, how to fix and verification". */
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  className?: string;
}) {
  return (
    <details open={open} className={`group/disclosure ${className}`}>
      <summary className="inline-flex list-none items-center gap-1.5 rounded text-sm font-medium text-brand-600 hover:text-brand-700 [&::-webkit-details-marker]:hidden">
        <Chevron />
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** Right-pointing chevron that turns down when its <details> is open. */
export function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={`h-3.5 w-3.5 shrink-0 transition-transform group-open/disclosure:rotate-90 group-open:rotate-90 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
