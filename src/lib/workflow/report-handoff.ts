import { reportQuery } from "./content-plan";
import type { PeriodKind } from "./progress";

/**
 * Report handoff: the team reviews the report, then opens the client-ready
 * view (what the PDF contains), saves it as a PDF, or copies a link for the
 * client to open after signing in. Everything is in the URL; nothing is
 * stored and nothing is sent.
 *
 * - `through=YYYY-MM-DD` fixes the reporting period (its last day), so a
 *   link opened later shows the same period. Without it the period is the
 *   last 7 or 28 whole UTC days before today. Invalid, future or very old
 *   dates are ignored.
 * - `view=client` (team only): the client-ready view, rendered with the
 *   client's data rules for tasks, without review controls or team notes.
 *   It is ignored for client members, who always get the client view.
 * - `pdf=1` (with `view=client`): opens the print dialog once.
 * - The client link carries the period only: the content plan and its
 *   selection are team-only in the app (client members see every website
 *   of the organization, docs/specs/client-access.md), so they reach the
 *   client in the PDF, never through the link.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Oldest fixed period end accepted, in days before today. */
export const MAX_THROUGH_AGE_DAYS = 400;

const today = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The exclusive end of a fixed period from `through` (its last day), or
 * null when absent or invalid: not a real date, not before today, or older
 * than MAX_THROUGH_AGE_DAYS.
 */
export function parseThrough(raw: unknown, now = new Date()): Date | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const last = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(last.getTime()) || iso(last) !== raw) return null;
  const end = new Date(last.getTime() + DAY);
  const limit = today(now);
  if (end > limit) return null;
  if (limit.getTime() - end.getTime() > MAX_THROUGH_AGE_DAYS * DAY) return null;
  return end;
}

/** The `through` value for a period (its last whole day). */
export const throughOf = (period: { end: Date }) =>
  iso(new Date(period.end.getTime() - DAY));

export type ReportView = "review" | "client";
export const parseView = (raw: unknown): ReportView =>
  raw === "client" ? "client" : "review";

type Choice = { explicit: boolean; ids: string[] };

/** A team URL: period, fixed end, plan choices, view and print request. */
export function handoffQuery(opts: {
  kind: PeriodKind;
  through: string | null;
  included: boolean;
  selection: Choice;
  view?: ReportView;
  pdf?: boolean;
}): string {
  const q = new URLSearchParams(
    reportQuery(opts.kind, opts.included, opts.selection).slice(1),
  );
  if (opts.through) q.set("through", opts.through);
  if (opts.view === "client") q.set("view", "client");
  if (opts.pdf) q.set("pdf", "1");
  return `?${q.toString()}`;
}

/**
 * The link the team gives the client: the report with its fixed period and
 * nothing else (no plan, selection, view or print parameters).
 */
export function clientLinkPath(
  reportPath: string,
  kind: PeriodKind,
  through: string,
): string {
  return `${reportPath}?${new URLSearchParams({ period: kind, through })}`;
}
