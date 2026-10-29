import { afterEach, describe, expect, test, vi } from "vitest";
import { log } from "@/lib/log";
import { recommendationBasis } from "./generate";
import {
  businessPurpose,
  findCollisions,
  identityKey,
  IDENTITY_KEY_MAX,
  isIdentityKey,
  logCollisions,
  partSlug,
  type SlotRow,
} from "./identity";

afterEach(() => vi.restoreAllMocks());

const FACT = "cmh0f4ct0000108l4abcd1234";

describe("identity keys: one per family, from structured fields only (section 2)", () => {
  test.each([
    [{ kind: "seo-rule", ruleId: "TECH_H1_MISSING" }, "seo:TECH_H1_MISSING"],
    [
      { kind: "seo-rule", ruleId: "CONTENT_SERVICE_LOCATION_GAP" },
      "seo:CONTENT_SERVICE_LOCATION_GAP",
    ],
    [{ kind: "issue", issueId: "iss_1" }, "issue:iss_1"],
    [
      { kind: "integration", key: "SITEMAP", code: "URL_BROKEN" },
      "integration:SITEMAP:URL_BROKEN",
    ],
    [{ kind: "performance" }, "performance"],
    [{ kind: "ai-search" }, "ai-search"],
    [
      { kind: "business", purpose: "offering-page", factId: FACT },
      `biz:offering-page:${FACT}`,
    ],
    [
      {
        kind: "business",
        purpose: "offering-page",
        factId: FACT,
        part: "Café & Bar",
      },
      `biz:offering-page:${FACT}:cafe-bar`,
    ],
    [
      { kind: "business", purpose: "location-page", factId: FACT },
      `biz:location-page:${FACT}`,
    ],
    [
      { kind: "business", purpose: "location-mention", factId: FACT },
      `biz:location-mention:${FACT}`,
    ],
    [{ kind: "business", purpose: "service-areas" }, "biz:service-areas"],
    [{ kind: "business", purpose: "contact-path" }, "biz:contact-path"],
    [{ kind: "business", purpose: "facilities-page" }, "biz:facilities-page"],
  ] as const)("%o → %s", (source, key) => {
    expect(identityKey(source)).toBe(key);
    expect(isIdentityKey(key)).toBe(true);
  });

  test("the rule id decides, not the wording or severity: two titles of one rule give one key (D3)", () => {
    const old = recommendationBasis({
      title: "Missing meta description (TECH_META_DESCRIPTION_MISSING)",
      issueId: null,
    });
    const reworded = recommendationBasis({
      title: "Add a meta description (TECH_META_DESCRIPTION_MISSING)",
      issueId: null,
    });
    expect(identityKey(old)).toBe("seo:TECH_META_DESCRIPTION_MISSING");
    expect(identityKey(reworded)).toBe(identityKey(old));
  });

  test("the fact decides, not the category: a business type change keeps the key (D2)", () => {
    // BIZ_SERVICE_PAGE and BIZ_ACCOMMODATION_PAGE are one purpose.
    expect(businessPurpose("BIZ_SERVICE_PAGE")).toBe("offering-page");
    expect(businessPurpose("BIZ_ACCOMMODATION_PAGE")).toBe("offering-page");
    expect(businessPurpose("BIZ_FOOD_PAGE")).toBe("offering-page");
    expect(businessPurpose("BIZ_UNKNOWN")).toBeNull();
  });

  test("two facts with identical titles keep two keys", () => {
    expect(
      identityKey({ kind: "business", purpose: "offering-page", factId: "f1" }),
    ).not.toBe(
      identityKey({ kind: "business", purpose: "offering-page", factId: "f2" }),
    );
  });

  test("no key without the structured field: the title alone never decides", () => {
    // A business task known only by its coverage code needs its fact id.
    expect(
      identityKey(
        recommendationBasis({
          title: "Add a page for “Cottages” (BIZ_SERVICE_PAGE)",
          issueId: null,
        }),
      ),
    ).toBeNull();
    expect(identityKey({ kind: "issue", issueId: null })).toBeNull();
    expect(
      identityKey({ kind: "business", purpose: "offering-page" }),
    ).toBeNull();
  });

  test("malformed input gives no key rather than a wrong one", () => {
    // A fact id on a per-website purpose, or none on a per-fact one.
    expect(
      identityKey({ kind: "business", purpose: "service-areas", factId: FACT }),
    ).toBeNull();
    // Parts exist only for offering pages, and must leave a slug.
    expect(
      identityKey({
        kind: "business",
        purpose: "location-page",
        factId: FACT,
        part: "North",
      }),
    ).toBeNull();
    expect(
      identityKey({
        kind: "business",
        purpose: "offering-page",
        factId: FACT,
        part: "—",
      }),
    ).toBeNull();
    // Characters outside the grammar.
    expect(identityKey({ kind: "seo-rule", ruleId: "tech h1" })).toBeNull();
    expect(identityKey({ kind: "issue", issueId: "a:b" })).toBeNull();
  });

  test("grammar: known families only, no spaces, at most 200 characters", () => {
    expect(isIdentityKey("seo:TECH_H1_MISSING")).toBe(true);
    expect(isIdentityKey("SEO:TECH_H1_MISSING")).toBe(false);
    expect(isIdentityKey("seo:")).toBe(false);
    expect(isIdentityKey("seo:TECH_H1_MISSING:extra")).toBe(false);
    expect(isIdentityKey("title:Add a page")).toBe(false);
    expect(isIdentityKey("biz:offering-page")).toBe(false);
    expect(isIdentityKey(`biz:offering-page:${FACT}:Cafe`)).toBe(false);
    expect(isIdentityKey("biz:service-areas:x")).toBe(false);
    expect(isIdentityKey(` performance`)).toBe(false);
    const id = "a".repeat(IDENTITY_KEY_MAX - "issue:".length);
    expect(isIdentityKey(`issue:${id}`)).toBe(true);
    expect(isIdentityKey(`issue:${id}a`)).toBe(false);
  });

  test("part slugs: lower case, accents dropped, words joined by hyphens", () => {
    expect(partSlug("Cottages")).toBe("cottages");
    expect(partSlug("  Holiday   Cottages ")).toBe("holiday-cottages");
    expect(partSlug("Crêperie")).toBe("creperie");
    expect(partSlug("B&B / Rooms")).toBe("b-b-rooms");
  });
});

describe("collision detection (sections 21 and 31)", () => {
  const T0 = new Date("2026-10-20T10:00:00Z");
  const T1 = new Date("2026-10-21T10:00:00Z");
  const row = (o: Partial<SlotRow> & Pick<SlotRow, "id">): SlotRow => ({
    title: "Add a meta description (TECH_META_DESCRIPTION_MISSING)",
    status: "PROPOSED",
    ...o,
  });

  test("two open rows with one title collide; oldest first, whatever the input order", () => {
    const [c, ...rest] = findCollisions([
      row({ id: "b", status: "IN_PROGRESS", createdAt: T1 }),
      row({ id: "a", createdAt: T0 }),
    ]);
    expect(rest).toEqual([]);
    expect(c.by).toBe("title");
    expect(c.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("a dismissed row holds the slot too; completed rows never collide", () => {
    expect(
      findCollisions([row({ id: "a" }), row({ id: "b", status: "DISMISSED" })]),
    ).toHaveLength(1);
    expect(
      findCollisions([
        row({ id: "a" }),
        row({ id: "b", status: "COMPLETED" }),
        row({ id: "c", status: "COMPLETED" }),
      ]),
    ).toEqual([]);
  });

  test("keyed rows group by key, whatever their titles; unkeyed rows by title", () => {
    const k = "seo:TECH_META_DESCRIPTION_MISSING";
    const [c] = findCollisions([
      row({ id: "a", title: "Old wording", identityKey: k }),
      row({ id: "b", title: "New wording", identityKey: k }),
      row({ id: "c", title: "Old wording" }),
    ]);
    expect(c).toMatchObject({ by: "identityKey", value: k });
    expect(c.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("distinct titles do not collide", () => {
    expect(
      findCollisions([
        row({ id: "a", title: "A" }),
        row({ id: "b", title: "B" }),
      ]),
    ).toEqual([]);
  });

  test("one log line per collision, naming every row (key field is not redacted)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const collisions = findCollisions([
      row({ id: "a", createdAt: T0, updatedAt: T0 }),
      row({ id: "b", status: "IN_PROGRESS", createdAt: T1, updatedAt: T1 }),
      row({ id: "x", title: "Other", identityKey: "performance" }),
      row({ id: "y", title: "Other 2", identityKey: "performance" }),
    ]);
    logCollisions(
      { websiteId: "w", organizationId: "o" },
      collisions,
      new Map([["a", 3]]),
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("recommendation_identity_collision", {
      websiteId: "w",
      organizationId: "o",
      identityKey: "performance",
      rows: [
        { id: "x", status: "PROPOSED" },
        { id: "y", status: "PROPOSED" },
      ],
    });
    expect(warn).toHaveBeenCalledWith("recommendation_identity_collision", {
      websiteId: "w",
      organizationId: "o",
      title: "Add a meta description (TECH_META_DESCRIPTION_MISSING)",
      rows: [
        {
          id: "a",
          status: "PROPOSED",
          createdAt: T0,
          updatedAt: T0,
          events: 3,
        },
        { id: "b", status: "IN_PROGRESS", createdAt: T1, updatedAt: T1 },
      ],
    });
  });
});
