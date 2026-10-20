export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-700 text-white shadow-sm hover:bg-brand-800 disabled:bg-brand-700/60",
  secondary:
    "border border-line-strong bg-surface text-ink shadow-sm hover:bg-subtle hover:border-muted/40",
  ghost: "text-ink-2 hover:bg-slate-100 hover:text-ink",
  danger: "bg-danger-700 text-white shadow-sm hover:bg-danger-700/90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
};

/** Shared classes so <button>, <Link> and <a> render identically. */
export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra = "",
): string {
  return `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}
