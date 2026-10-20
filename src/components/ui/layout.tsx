import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button";

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>/</span>}
            {c.href ? (
              <Link href={c.href} className="hover:text-ink hover:underline">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink-2">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
  meta,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Small line under the title, e.g. status badges. */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
  footer,
  padded = true,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Set false for edge-to-edge content such as tables and lists. */
  padded?: boolean;
  className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-xl border border-line bg-surface shadow-card ${className}`}
    >
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold text-ink">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-muted">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
      {footer && (
        <div className="border-t border-line bg-subtle px-5 py-3 text-sm">
          {footer}
        </div>
      )}
    </section>
  );
}

/** Compact "nothing here" message for use inside a card. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children}</p>;
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  size = "md",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size)}>
      {children}
    </Link>
  );
}

export function Table({
  head,
  children,
}: {
  head: ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-subtle text-xs font-medium uppercase tracking-wide text-muted">
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="whitespace-nowrap px-4 py-2.5 font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export const td = "px-4 py-3 align-top";

/** Link-based filter tabs (server rendered; no client JS). */
export function FilterTabs({
  items,
  label = "Filter",
}: {
  items: Array<{
    href: string;
    label: ReactNode;
    active: boolean;
    count?: number;
  }>;
  label?: string;
}) {
  return (
    <nav
      aria-label={label}
      className="mb-4 inline-flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 shadow-card"
    >
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            t.active
              ? "bg-brand-50 text-brand-800"
              : "text-ink-2 hover:bg-slate-100 hover:text-ink"
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span
              className={`rounded-full px-1.5 text-xs tabular-nums ${t.active ? "bg-brand-100" : "bg-slate-100 text-muted"}`}
            >
              {t.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
