import type {
  AiSearchMentionStatus,
  AiSearchRecommendationStatus,
} from "@/generated/prisma/enums";

/** RECONSTRUCTED answer analysis for AI Search results. */

export type Source = { url: string; title: string | null };

export type BrandProfile = {
  brandName: string;
  legalName: string | null;
  aliases: string[];
};

export type Competitor = {
  id: string;
  name: string;
  domain: string | null;
  aliases: string[];
};

export type CompetitorSignal = {
  competitorId: string;
  name: string;
  mentioned: boolean;
  cited: boolean;
};

export type AnswerAnalysis = {
  mentionStatus: AiSearchMentionStatus;
  recommendationStatus: AiSearchRecommendationStatus;
  websiteCited: boolean | null;
  citationCount: number;
  relevantCitationCount: number;
  competitorSignals: CompetitorSignal[];
};

export function normalizeQueryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?.!\s]+$/, "")
    .trim();
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-term, case-insensitive match that tolerates punctuation around names. */
function termPattern(terms: string[]): RegExp | null {
  const clean = [
    ...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2)),
  ];
  if (!clean.length) return null;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])(${clean.map(escape).join("|")})(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  );
}

function bareHost(value: string): string | null {
  try {
    const host = value.includes("://") ? new URL(value).hostname : value;
    return (
      host
        .toLowerCase()
        .replace(/^www\./, "")
        .replace(/\.$/, "") || null
    );
  } catch {
    return null;
  }
}

/** True if `url` is on `domain` or one of its subdomains. */
export function urlMatchesDomain(url: string, domain: string | null): boolean {
  const host = bareHost(url);
  const target = domain ? bareHost(domain) : null;
  return Boolean(
    host && target && (host === target || host.endsWith(`.${target}`)),
  );
}

const POSITIVE =
  /\b(recommend(ed|s)?|top (pick|choice)|best|highly rated|great (option|choice)|consider|stands out|leading|well[- ]regarded|popular choice)\b/i;
const NEGATIVE =
  /\b(avoid|not recommend(ed)?|don't recommend|poor reviews|complaints|scam|worst)\b/i;

function sentencesWith(answer: string, pattern: RegExp): string[] {
  return answer.split(/(?<=[.!?])\s+|\n+/).filter((s) => pattern.test(s));
}

export function analyzeAnswer(input: {
  answer: string | null;
  sources: Source[];
  profile: BrandProfile;
  websiteDomain: string;
  competitors: Competitor[];
}): AnswerAnalysis {
  const { answer, sources, profile, websiteDomain, competitors } = input;
  const brandTerms = [
    profile.brandName,
    profile.legalName ?? "",
    ...profile.aliases,
    websiteDomain,
    websiteDomain.replace(/^www\./, ""),
  ];
  const brand = termPattern(brandTerms);
  const websiteCited = sources.some((s) =>
    urlMatchesDomain(s.url, websiteDomain),
  );

  const competitorSignals = competitors.map((c) => {
    const p = termPattern([
      c.name,
      ...c.aliases,
      ...(c.domain ? [c.domain] : []),
    ]);
    return {
      competitorId: c.id,
      name: c.name,
      mentioned: Boolean(answer && p?.test(answer)),
      cited: sources.some((s) => urlMatchesDomain(s.url, c.domain)),
    };
  });

  const relevantCitationCount = sources.filter(
    (s) =>
      urlMatchesDomain(s.url, websiteDomain) ||
      competitors.some((c) => urlMatchesDomain(s.url, c.domain)),
  ).length;

  if (answer === null) {
    return {
      mentionStatus: "UNKNOWN",
      recommendationStatus: "UNKNOWN",
      websiteCited: null,
      citationCount: sources.length,
      relevantCitationCount,
      competitorSignals,
    };
  }

  const mentioned = Boolean(brand?.test(answer));
  let recommendationStatus: AiSearchRecommendationStatus = "NOT_MENTIONED";
  if (mentioned && brand) {
    const context = sentencesWith(answer, brand).join(" ");
    if (NEGATIVE.test(context))
      recommendationStatus = "MENTIONED_NOT_RECOMMENDED";
    else if (POSITIVE.test(context)) recommendationStatus = "RECOMMENDED";
    else recommendationStatus = "UNCLEAR";
  }
  return {
    mentionStatus: mentioned ? "BRAND_MENTIONED" : "BRAND_NOT_MENTIONED",
    recommendationStatus,
    websiteCited,
    citationCount: sources.length,
    relevantCitationCount,
    competitorSignals,
  };
}
