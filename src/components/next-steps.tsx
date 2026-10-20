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
            className="flex items-start gap-3 px-5 py-4"
          >
            <span
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${t.wrap}`}
            >
              <Icon className="h-4 w-4" />
              <span className="sr-only">{t.label}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
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
              className={buttonClass("secondary", "sm", "shrink-0")}
            >
              {s.action.label}
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
