import type { ComponentProps, ReactNode } from "react";

export function Field({
  label,
  name,
  errors,
  ...input
}: {
  label: string;
  name: string;
  errors?: string[];
} & ComponentProps<"input">) {
  const errorId = errors?.length ? `${name}-error` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-100"
        {...input}
      />
      {errorId && (
        <p id={errorId} className="text-sm text-red-600 dark:text-red-400">
          {errors?.join(" ")}
        </p>
      )}
    </div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: { variant?: "primary" | "ghost" } & ComponentProps<"button">) {
  const styles =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";
  return (
    <button
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
    >
      {children}
    </p>
  );
}
