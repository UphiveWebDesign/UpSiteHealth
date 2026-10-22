import { z } from "zod";
import type {
  BusinessFactKind,
  BusinessFactSource,
  BusinessFactStatus,
} from "@/generated/prisma/enums";
import { BUSINESS_TYPES, type BusinessType } from "@/lib/knowledge/catalogue";

/**
 * Business facts: what a website's business offers, where, for whom and
 * what it wants visitors to do. Each fact records who supplied it and
 * whether a person approved it. Only approved facts reach coverage and
 * recommendations; pending, rejected and inferred facts never do.
 */

export type Fact = {
  id: string;
  kind: BusinessFactKind;
  value: string;
  synonyms: string[];
  source: BusinessFactSource;
  status: BusinessFactStatus;
};

/** Kinds in display order, with the wording used on the profile page. */
export const FACT_KINDS: Array<{
  kind: BusinessFactKind;
  label: string;
  hint: string;
  /** Matched against pages, so other wording (synonyms) is useful. */
  matched: boolean;
}> = [
  {
    kind: "BUSINESS_TYPE",
    label: "Business type",
    hint: "Decides whether location pages are expected.",
    matched: false,
  },
  {
    kind: "SERVICE",
    label: "Services and products",
    hint: "What the business offers. Each approved one is looked for on the site.",
    matched: true,
  },
  {
    kind: "LOCATION",
    label: "Locations",
    hint: "Physical premises customers can visit (town or neighbourhood).",
    matched: true,
  },
  {
    kind: "SERVICE_AREA",
    label: "Service areas",
    hint: "Places served without premises there.",
    matched: true,
  },
  {
    kind: "AUDIENCE",
    label: "Audiences",
    hint: "Who the customers are, for context in the plan.",
    matched: false,
  },
  {
    kind: "GOAL",
    label: "Goals",
    hint: "What visitors should do on the site.",
    matched: false,
  },
  {
    kind: "CONSTRAINT",
    label: "Constraints",
    hint: "Limits the team must respect, e.g. “no pricing on the site”.",
    matched: false,
  },
  {
    kind: "EXCLUDED",
    label: "Not offered",
    hint: "Services or places the business does not offer. Pages that mention them are flagged for review.",
    matched: true,
  },
];

export const KIND_LABEL = Object.fromEntries(
  FACT_KINDS.map((k) => [k.kind, k.label]),
) as Record<BusinessFactKind, string>;

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  "local-service": "Local service business",
  "multi-location": "Several physical locations",
  ecommerce: "Online shop",
  hospitality: "Hotel, hospitality or tourism",
  b2b: "Business-to-business",
};

export const GOALS = ["calls", "leads", "bookings", "sales", "visits"] as const;
export type Goal = (typeof GOALS)[number];
export const GOAL_LABEL: Record<Goal, string> = {
  calls: "Phone calls",
  leads: "Enquiries (forms or email)",
  bookings: "Bookings or appointments",
  sales: "Online sales",
  visits: "Visits to the premises",
};
/** Goals that need an obvious way to get in touch. */
export const CONTACT_GOALS: Goal[] = ["calls", "leads", "bookings"];

export const SOURCE_LABEL: Record<BusinessFactSource, string> = {
  CLIENT: "From the client",
  TEAM: "From our team",
  IMPORT: "Imported",
  INFERENCE: "Suggested by UpSiteHealth",
};
export const STATUS_LABEL: Record<BusinessFactStatus, string> = {
  PENDING: "Awaiting review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

/** One fact per kind and wording: trimmed, single-spaced, lower-case. */
export function normalizeFactValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** How a stored value is shown (fixed lists show their label). */
export function factLabel(f: Pick<Fact, "kind" | "value">): string {
  if (f.kind === "BUSINESS_TYPE")
    return BUSINESS_TYPE_LABEL[f.value as BusinessType] ?? f.value;
  if (f.kind === "GOAL") return GOAL_LABEL[f.value as Goal] ?? f.value;
  return f.value;
}

const text = z
  .string()
  .trim()
  .min(1, "Enter a value.")
  .max(160, "Keep it under 160 characters.");

/** Validates a new fact from the profile form. */
export const factInput = z
  .object({
    kind: z.enum([
      "BUSINESS_TYPE",
      "SERVICE",
      "LOCATION",
      "SERVICE_AREA",
      "AUDIENCE",
      "GOAL",
      "CONSTRAINT",
      "EXCLUDED",
    ]),
    value: text,
    synonyms: z.array(text).max(10, "At most 10 other wordings."),
    // People enter facts; IMPORT and INFERENCE are never chosen in a form.
    source: z.enum(["CLIENT", "TEAM"]),
    approve: z.boolean(),
  })
  .superRefine((f, ctx) => {
    if (
      f.kind === "BUSINESS_TYPE" &&
      !(BUSINESS_TYPES as readonly string[]).includes(f.value)
    )
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Choose a business type.",
      });
    if (f.kind === "GOAL" && !(GOALS as readonly string[]).includes(f.value))
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Choose a goal.",
      });
    if (
      f.synonyms.length &&
      !FACT_KINDS.find((k) => k.kind === f.kind)?.matched
    )
      ctx.addIssue({
        code: "custom",
        path: ["synonyms"],
        message:
          "Other wordings apply only to services, places and exclusions.",
      });
  });
export type FactInput = z.infer<typeof factInput>;

/** Only facts a person approved. */
export const approved = <T extends Pick<Fact, "status">>(facts: T[]) =>
  facts.filter((f) => f.status === "APPROVED");

/** Approved business types (an unknown value is ignored, never guessed). */
export function approvedTypes(facts: Fact[]): BusinessType[] {
  return approved(facts)
    .filter((f) => f.kind === "BUSINESS_TYPE")
    .map((f) => f.value)
    .filter((v): v is BusinessType =>
      (BUSINESS_TYPES as readonly string[]).includes(v),
    );
}
