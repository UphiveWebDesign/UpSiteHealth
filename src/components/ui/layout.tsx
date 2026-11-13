import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button";

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1.5 text-xs text-muted">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-line-strong">
                /
              </span>
            )}
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
    <header className="mb-5">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-anywhere text-[22px] font-semibold tracking-tight text-ink sm:text-2xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>
          )}
          {meta && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
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
      className={`overflow-hidden rounded-lg border border-line bg-surface shadow-card ${className}`}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3.5 sm:px-5">
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
      <div className={padded ? "p-4 sm:p-5" : ""}>{children}</div>
      {footer && (
        <div className="border-t border-line bg-subtle px-4 py-3 text-sm sm:px-5">
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
        <thead className="border-b border-line bg-subtle text-[11px] font-medium uppercase tracking-wider text-muted">
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
      className="mb-4 inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-line bg-surface p-1"
    >
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            t.active
              ? "bg-brand-700 text-white"
              : "text-ink-2 hover:bg-tint hover:text-ink"
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span
              className={`rounded px-1.5 text-xs tabular-nums ${t.active ? "bg-white/15 text-white" : "bg-tint text-muted"}`}
            >
              {t.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Heading for a page section that is not itself a card: a title, an
 * optional one-line description and an optional link or action.
 */
export function SectionHeader({
  id,
  title,
  description,
  action,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0 text-xs font-medium">{action}</div>}
    </div>
  );
}

/** A quiet text link in the brand colour, for "View all" style actions. */
export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="text-xs font-medium text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline"
    >
      {children}
    </Link>
  );
}

/**
 * A URL as technical text: monospace, wraps anywhere so it never widens the
 * page, with the host de-emphasised when `pathFirst` is set.
 */
export function UrlText({
  url,
  pathFirst = false,
  className = "",
}: {
  url: string;
  pathFirst?: boolean;
  className?: string;
}) {
  let host = "";
  let rest = url;
  try {
    const u = new URL(url);
    host = u.host;
    rest = `${u.pathname}${u.search}`;
  } catch {
    // Not a URL: shown as stored.
  }
  return (
    <span className={`break-anywhere font-mono text-[12.5px] ${className}`}>
      {host && pathFirst ? (
        <>
          <span className="text-ink">{rest}</span>
          <span className="text-muted"> · {host}</span>
        </>
      ) : (
        url
      )}
    </span>
  );
}
