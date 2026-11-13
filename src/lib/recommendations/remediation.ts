import type { PlatformDetection } from "@/lib/crawler/platform";
import { formatDateTime } from "@/lib/format";
import {
  PLAYBOOK_VERSION,
  playbookFor,
  type Overlay,
} from "@/lib/knowledge/playbooks";
import type { RecommendationBasis } from "./generate";
import type { RecommendationMeta } from "./metadata";

/**
 * How to fix a technical SEO task: the rule's playbook (knowledge/
 * playbooks.ts), plus WordPress or WooCommerce steps when the latest
 * analysed crawl supports that platform (crawler/platform.ts). Shown with
 * the task; nothing here is stored, and verification stays the catalogue's.
 */

/** The platform evidence for one website, from its latest analysed crawl. */
export type PlatformEvidence = {
  /** When that crawl was analysed; null when the website has none. */
  analysedAt: Date | null;
  detection: PlatformDetection | null;
};

export type PlatformOverlay = Overlay & {
  platform: "wordpress" | "woocommerce";
  label: string;
};

export type Remediation = {
  ruleId: string;
  playbookVersion: string;
  steps: string[];
  prerequisites: string[];
  risks: string[];
  platform: PlatformEvidence;
  /** Platform steps shown; empty unless the detection supports the platform. */
  overlays: PlatformOverlay[];
};

const PLATFORM_LABEL = {
  wordpress: "WordPress",
  woocommerce: "WooCommerce",
} as const;

/** Whether the detection is strong enough for platform-specific steps. */
export const platformSupported = (d: PlatformDetection | null): boolean =>
  !!d && d.platform !== "unknown" && d.confidence !== null;

/** The remediation for a task, or null when it is not a technical SEO rule with a playbook. */
export function remediationFor(
  basis: RecommendationBasis,
  platform: PlatformEvidence,
): Remediation | null {
  if (basis.kind !== "seo-rule") return null;
  const playbook = playbookFor(basis.ruleId);
  if (!playbook) return null;
  const d = platform.detection;
  const shown: Array<"wordpress" | "woocommerce"> = !platformSupported(d)
    ? []
    : d!.platform === "woocommerce"
      ? ["wordpress", "woocommerce"]
      : ["wordpress"];
  const overlays = shown.flatMap((p) => {
    const o = playbook.platforms?.[p];
    return o ? [{ platform: p, label: PLATFORM_LABEL[p], ...o }] : [];
  });
  return {
    ruleId: basis.ruleId,
    playbookVersion: PLAYBOOK_VERSION,
    steps: playbook.steps,
    prerequisites: playbook.prerequisites,
    risks: playbook.risks,
    platform,
    overlays,
  };
}

const pages = (count: number) => `${count} ${count === 1 ? "page" : "pages"}`;

/**
 * What to say about the platform under the steps: whether platform steps
 * apply, why (or why not), and the signals behind it. Never stronger than
 * the detection: anything but a supported detection is "not detected".
 */
export function platformStatus(e: PlatformEvidence): {
  supported: boolean;
  text: string;
  signals: string[];
} {
  const d = e.detection;
  if (!d || !e.analysedAt)
    return {
      supported: false,
      text: "Platform not detected: there is no analysed crawl yet.",
      signals: [],
    };
  const when = `the crawl analysed ${formatDateTime(e.analysedAt)}`;
  const signals = [
    ...d.signals.map((s) => `${s.label}, on ${pages(s.pages)}`),
    ...(d.malformed > 0
      ? [`Unreadable platform data on ${pages(d.malformed)}`]
      : []),
  ];
  const others = d.otherPlatforms.join(", ");
  switch (d.reason) {
    case "detected":
      return {
        supported: platformSupported(d),
        text: `${PLATFORM_LABEL[d.platform as keyof typeof PLATFORM_LABEL]} detected (${d.confidence} confidence) from ${when}, checking ${pages(d.pagesChecked)}.`,
        signals,
      };
    case "not-recorded":
      return {
        supported: false,
        text: `Platform not detected: ${when} ran before platform detection was added. The next crawl records it.`,
        signals,
      };
    case "no-signals":
      return {
        supported: false,
        text: `Platform not detected: ${when} found no clear WordPress signals in ${pages(d.pagesWithSignals)}. That does not show the site uses another platform.`,
        signals,
      };
    case "weak":
      return {
        supported: false,
        text: `Platform not detected: ${when} found only one kind of signal, on one page, which is not enough for platform-specific steps.`,
        signals,
      };
    case "conflicting":
      return {
        supported: false,
        text: `Platform not detected: ${when} found WordPress signals and a generator tag naming ${others}, so platform-specific steps are not shown.`,
        signals,
      };
    case "other-platform":
      return {
        supported: false,
        text: `Platform not detected as WordPress: ${when} found a generator tag naming ${others}.`,
        signals,
      };
  }
}

/** Adds the remediation to a task's metadata (unchanged when there is none). */
export function withRemediation(
  meta: RecommendationMeta | null,
  basis: RecommendationBasis,
  platform: PlatformEvidence,
): RecommendationMeta | null {
  if (!meta) return null;
  const remediation = remediationFor(basis, platform);
  return remediation ? { ...meta, remediation } : meta;
}
