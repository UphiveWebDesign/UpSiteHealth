import { describe, expect, test } from "vitest";
import { CONTENT_RULE_IDS, SEO_LIMITS, SEO_RULE_IDS } from "./catalogue";
import {
  PLAYBOOK_VERSION,
  PLAYBOOKS,
  playbookFor,
  type Playbook,
} from "./playbooks";

const entries = Object.entries(PLAYBOOKS) as Array<[string, Playbook]>;

/** Every text of a playbook, generic and platform, with where it came from. */
function texts(p: Playbook): Array<{ where: string; text: string }> {
  const out = [
    ...p.steps.map((text) => ({ where: "steps", text })),
    ...p.prerequisites.map((text) => ({ where: "prerequisites", text })),
    ...p.risks.map((text) => ({ where: "risks", text })),
  ];
  for (const [platform, o] of Object.entries(p.platforms ?? {}))
    for (const text of [...o.steps, ...o.notes])
      out.push({ where: platform, text });
  return out;
}

describe("playbook coverage", () => {
  test("exactly one playbook per technical SEO rule", () => {
    expect(Object.keys(PLAYBOOKS).sort()).toEqual([...SEO_RULE_IDS].sort());
    expect(PLAYBOOK_VERSION).toBe("p2");
  });

  test("unknown ids, content rules and object keys have none", () => {
    for (const id of [
      "TECH_UNKNOWN",
      "",
      "constructor",
      "__proto__",
      "toString",
      ...CONTENT_RULE_IDS,
    ])
      expect(playbookFor(id)).toBeUndefined();
    expect(playbookFor("TECH_NOINDEX")).toBe(PLAYBOOKS.TECH_NOINDEX);
  });
});

describe.each(entries)("%s", (_id, p) => {
  test("has at least two non-empty steps, and well-formed lists", () => {
    expect(p.steps.length).toBeGreaterThanOrEqual(2);
    for (const list of [p.steps, p.prerequisites, p.risks]) {
      expect(new Set(list).size).toBe(list.length);
      for (const s of list) expect(s.trim().length).toBeGreaterThan(10);
    }
  });

  test("overlays are WordPress or WooCommerce, and each says something", () => {
    for (const [platform, o] of Object.entries(p.platforms ?? {})) {
      expect(["wordpress", "woocommerce"]).toContain(platform);
      expect(o.steps.length + o.notes.length).toBeGreaterThan(0);
      expect(new Set(o.steps).size).toBe(o.steps.length);
      expect(new Set(o.notes).size).toBe(o.notes.length);
      for (const s of [...o.steps, ...o.notes])
        expect(s.trim().length).toBeGreaterThan(10);
    }
  });

  test("generic guidance does not depend on WordPress", () => {
    for (const list of [p.steps, p.prerequisites, p.risks])
      for (const s of list)
        expect(s).not.toMatch(/wordpress|woocommerce|yoast|rank math/i);
  });

  test("plugins are named only conditionally", () => {
    for (const { text } of texts(p))
      if (/yoast|rank math/i.test(text))
        expect(text).toMatch(/\b(if|for example)\b/i);
  });

  test("no promised outcomes", () => {
    for (const { text } of texts(p))
      expect(text).not.toMatch(
        /\b(rank(s|ing)? (higher|better|first)|increase[sd]? (traffic|rankings?|sales|conversions)|more traffic|guarantee|boost)/i,
      );
  });

  test("every length threshold is one of SEO_LIMITS", () => {
    const limits = new Set<number>(Object.values(SEO_LIMITS));
    for (const { text } of texts(p)) {
      for (const m of text.matchAll(
        /(\d+)(?:\s*[–-]\s*(\d+))?\s+(characters|words)/g,
      )) {
        expect(limits).toContain(Number(m[1]));
        if (m[2]) expect(limits).toContain(Number(m[2]));
      }
    }
  });
});

test("length rules quote the current limits", () => {
  const all = (id: keyof typeof PLAYBOOKS) =>
    texts(PLAYBOOKS[id])
      .map((t) => t.text)
      .join(" ");
  expect(all("TECH_TITLE_TOO_SHORT")).toContain(`${SEO_LIMITS.titleMin}`);
  expect(all("TECH_TITLE_TOO_LONG")).toContain(`${SEO_LIMITS.titleMax}`);
  expect(all("TECH_META_DESCRIPTION_TOO_SHORT")).toContain(
    `${SEO_LIMITS.descriptionMin}`,
  );
  expect(all("TECH_META_DESCRIPTION_TOO_LONG")).toContain(
    `${SEO_LIMITS.descriptionMax}`,
  );
  expect(all("TECH_THIN_CONTENT")).toContain(`${SEO_LIMITS.thinContentWords}`);
});
