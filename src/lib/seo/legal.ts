/**
 * Legal pages (privacy policy, terms, cookie and refund policies): shared by
 * page classification (business/pages.ts) and the SEO rules, so both agree
 * on what a legal page is. Deliberately narrow: a URL path segment from a
 * fixed list, and policy wording in the title or main heading.
 */

/** Path segments of legal pages (WooCommerce's default refund page included). */
export const LEGAL_SEGMENT =
  /^(privacy|privacy-policy|terms|terms-and-conditions|terms-of-service|terms-of-use|cookies?|cookie-policy|legal|imprint|disclaimer|refund-policy|refund_returns|return-policy|returns-policy|shipping-policy)$/;

/** Policy wording in a title or heading. */
export const POLICY_HEADING =
  /\b(privacy policy|terms (and|&) conditions|terms of (service|use)|cookie policy|refund (and returns )?policy|returns? policy|shipping policy)\b/i;

export type LegalSignals = {
  /** A path segment names a legal page. */
  url: boolean;
  /** The title or an H1 uses policy wording. */
  heading: boolean;
};

export function legalSignals(p: {
  path: string;
  title: string | null;
  h1: string[];
}): LegalSignals {
  return {
    url: p.path
      .split("/")
      .filter(Boolean)
      .some((seg) => LEGAL_SEGMENT.test(seg.toLowerCase())),
    heading: [p.title ?? "", ...p.h1].some((t) => POLICY_HEADING.test(t)),
  };
}

/** Both signals agree: the page is a legal page. */
export function isLegalPage(p: {
  path: string;
  title: string | null;
  h1: string[];
}): boolean {
  const s = legalSignals(p);
  return s.url && s.heading;
}
