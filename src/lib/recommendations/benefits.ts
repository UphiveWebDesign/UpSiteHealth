/**
 * What kind of benefit a fix brings. These describe the category of value,
 * never a predicted gain: UpSiteHealth does not estimate ranking or traffic
 * changes, and measurement tools are never presented as ranking factors.
 */
export type BenefitCategory =
  | "availability"
  | "security-trust"
  | "crawling-indexing"
  | "search-appearance"
  | "content-quality"
  | "user-experience"
  | "search-insight"
  | "measurement"
  | "ai-visibility"
  | "business-coverage";

export const BENEFIT: Record<BenefitCategory, { label: string; text: string }> =
  {
    availability: {
      label: "Availability",
      text: "Keeps the site reachable for visitors and search engines.",
    },
    "security-trust": {
      label: "Security and trust",
      text: "Avoids browser security warnings and keeps connections private.",
    },
    "crawling-indexing": {
      label: "Crawling and indexing",
      text: "Helps search engines find, crawl and index the right pages.",
    },
    "search-appearance": {
      label: "Search appearance",
      text: "Affects how pages are described in search results.",
    },
    "content-quality": {
      label: "Content quality",
      text: "Makes pages more useful and easier to understand.",
    },
    "user-experience": {
      label: "User experience",
      text: "Makes pages faster and more stable for visitors.",
    },
    "search-insight": {
      label: "Search insight",
      text: "Gives you first-party search data (queries, indexing, errors). It does not change rankings by itself.",
    },
    measurement: {
      label: "Measurement",
      text: "Lets you measure visits and conversions. It does not affect search rankings.",
    },
    "ai-visibility": {
      label: "AI search visibility",
      text: "May help AI assistants mention and cite the site. Results vary between runs.",
    },
    "business-coverage": {
      label: "Business coverage",
      text: "Helps visitors and search engines find what the business offers and where. It does not promise rankings or traffic by itself.",
    },
  };
