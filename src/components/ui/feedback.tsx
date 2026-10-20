import type { ReactNode } from "react";
import { TONE_CLASSES, type Tone } from "./badge";
import { AlertIcon, CheckIcon, InfoIcon, XCircleIcon } from "./icons";

type CalloutTone = Extract<Tone, "info" | "success" | "warning" | "danger">;

const ICON: Record<CalloutTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CheckIcon,
  warning: AlertIcon,
  danger: XCircleIcon,
};

/** Inline message with an optional next action. */
export function Callout({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = ICON[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={`flex flex-wrap items-start gap-3 rounded-xl px-4 py-3 text-sm ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      <Icon className="mt-0.5 h-4 w-4" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Full empty state: what is missing, why it matters, and what to do. */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-700">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-sm text-muted">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
