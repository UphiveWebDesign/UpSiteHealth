import { approved, approvedTypes, type Fact } from "@/lib/business/facts";
import type { BusinessType } from "@/lib/knowledge/catalogue";

/**
 * The business profile the Organic Growth Starter works from, read from
 * approved business facts only (business/facts.ts). Nothing is inferred
 * from the website: a pending, rejected or suggested fact counts for
 * nothing, and an unknown answer stays unknown.
 */

export type BusinessModel =
  "local" | "ecommerce" | "saas" | "national-service" | "hybrid" | "other";

export const MODEL_LABEL: Record<BusinessModel, string> = {
  local: "Local business",
  ecommerce: "E-commerce",
  saas: "SaaS",
  "national-service": "National service",
  hybrid: "Hybrid",
  other: "Other",
};

const MODEL_OF: Record<BusinessType, Exclude<BusinessModel, "hybrid">> = {
  "local-service": "local",
  "multi-location": "local",
  hospitality: "local",
  ecommerce: "ecommerce",
  saas: "saas",
  "national-service": "national-service",
  b2b: "other",
  other: "other",
};

export type GrowthProfile = {
  /** Null until a business type is approved. */
  model: BusinessModel | null;
  /** The approved types behind `model` (several make it hybrid). */
  types: BusinessType[];
  /** Approved LOCATION facts: premises customers can visit. */
  premises: string[];
  /** Approved SERVICE_AREA facts: places served without premises there. */
  serviceAreas: string[];
  /** Approved goal "visits": customers come to the premises. */
  customerVisits: boolean;
  services: string[];
  audiences: string[];
  goals: string[];
};

export function growthProfile(facts: Fact[]): GrowthProfile {
  const ok = approved(facts);
  const values = (kind: Fact["kind"]) =>
    ok.filter((f) => f.kind === kind).map((f) => f.value);
  const types = approvedTypes(facts);
  const models = [...new Set(types.map((t) => MODEL_OF[t]))];
  return {
    model: models.length > 1 ? "hybrid" : (models[0] ?? null),
    types,
    premises: values("LOCATION"),
    serviceAreas: values("SERVICE_AREA"),
    customerVisits: values("GOAL").includes("visits"),
    services: values("SERVICE"),
    audiences: values("AUDIENCE"),
    goals: values("GOAL"),
  };
}

export type Applicability =
  | { state: "applies"; reason: string }
  | { state: "not-applicable"; reason: string }
  /** A person must decide; the task is neither required nor excluded. */
  | { state: "review"; reason: string };

const LOCAL_MODELS = new Set([
  "local-service",
  "multi-location",
  "hospitality",
]);
const ONLINE_MODELS = new Set(["ecommerce", "saas"]);

/**
 * Google Business Profile eligibility, from Google's business eligibility
 * guidelines (support.google.com/business/answer/13763036): a business
 * must make in-person contact with customers during its stated hours,
 * either at a location customers visit or by travelling to them.
 * Online-only businesses are listed as ineligible. Virtual offices, and
 * co-working offices without signage, staff and customers, are not
 * eligible. We never decide an ambiguous case: it goes to review.
 */
export function gbpApplicability(p: GrowthProfile): Applicability {
  if (p.premises.length)
    return {
      state: "applies",
      reason: `Approved premises customers can visit (${p.premises.join(", ")}). Google requires in-person contact during stated hours and permanent signage at a shown address.`,
    };
  const local = p.types.some((t) => LOCAL_MODELS.has(t));
  if (local && p.serviceAreas.length)
    return {
      state: "applies",
      reason: `Local service business serving ${p.serviceAreas.join(", ")}: eligible as a service-area business if staff travel to customers. Hide the address if customers are not served there.`,
    };
  if (!p.types.length)
    return {
      state: "review",
      reason:
        "No approved business type yet: complete the business profile to decide whether a Business Profile applies.",
    };
  if (local)
    return {
      state: "review",
      reason:
        "A local business type is approved, but no premises or service area is: add them to confirm in-person contact with customers.",
    };
  if (p.types.every((t) => ONLINE_MODELS.has(t)))
    return {
      state: "not-applicable",
      reason:
        "Online-only business with no approved premises: Google lists online-only businesses as ineligible for a Business Profile.",
    };
  return {
    state: "review",
    reason:
      "Eligible only if the business meets customers in person during stated hours (at a staffed location with permanent signage, or by travelling to them). Google lists online-only businesses, virtual offices, co-working desks without signage, staff and customers, and lead-generation companies as ineligible. Confirm with the client.",
  };
}
