import type { ComponentProps, ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button";

export const inputClass =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink shadow-sm placeholder:text-muted/70 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/15 disabled:bg-subtle disabled:text-muted";

export function Field({
  label,
  name,
  errors,
  hint,
  ...input
}: {
  label: string;
  name: string;
  errors?: string[];
  hint?: string;
} & ComponentProps<"input">) {
  const errorId = errors?.length ? `${name}-error` : undefined;
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={
          [errorId, hintId].filter(Boolean).join(" ") || undefined
        }
        className={`${inputClass} ${errorId ? "border-danger-500 focus:border-danger-500 focus:ring-danger-500/15" : ""}`}
        {...input}
      />
      {hint && !errorId && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {errorId && (
        <p id={errorId} className="text-sm text-danger-700">
          {errors?.join(" ")}
        </p>
      )}
    </div>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
} & ComponentProps<"button">) {
  return (
    <button className={buttonClass(variant, size, className)} {...props} />
  );
}

export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700"
    >
      {children}
    </p>
  );
}
