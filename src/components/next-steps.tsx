import Link from "next/link";
import type { NextStep, StepTone } from "@/lib/insights/next-steps";
import { buttonClass } from "./ui/button";
import { AlertIcon, ArrowRightIcon, InfoIcon, XCircleIcon } from "./ui/icons";

const TONE: Record<
  StepTone,
  { icon: typeof InfoIcon; wrap: string; label: string }
> = {
  danger: {
    icon: XCircleIcon,
    wrap: "bg-danger-50 text-danger-700",
    label: "Urgent",
  },
  warning: {
    icon: AlertIcon,
    wrap: "bg-warning-50 text-warning-700",
    label: "Needs attention",
  },
  brand: {
    icon: ArrowRightIcon,
    wrap: "bg-brand-50 text-brand-700",
    label: "Get set up",
  },
  info: {
    icon: InfoIcon,
    wrap: "bg-info-50 text-info-700",
    label: "Suggestion",
  },
};

/** Ranked, actionable steps. `showWebsite` adds the site name (organization view). */
export function NextStepList({
  steps,
  showWebsite = false,
}: {
  steps: NextStep[];
  showWebsite?: boolean;
}) {
  return (
    <ol className="divide-y divide-line">
      {steps.map((s) => {
        const t = TONE[s.tone];
        const Icon = t.icon;
        return (
          <li
            key={`${s.websiteId}-${s.id}`}
            className="flex items-start gap-3 px-4 py-3.5 sm:px-5"
          >
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${t.wrap}`}
              aria-hidden
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {t.label}
                </p>
                <p className="mt-0.5 text-sm font-medium text-ink">
                  {s.title}
                  {showWebsite && (
                    <span className="font-normal text-muted">
                      {" "}
                      · {s.websiteName}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-sm text-muted">{s.reason}</p>
              </div>
              <Link
                href={s.action.href}
                className={buttonClass("secondary", "sm", "self-start")}
              >
                {s.action.label}
              </Link>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
