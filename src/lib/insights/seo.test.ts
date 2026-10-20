import { expect, test } from "vitest";
import {
  describeEvidence,
  findingTarget,
  groupFindings,
  type FindingRow,
} from "./seo";

const row = (o: Partial<FindingRow>): FindingRow => ({
  id: Math.random().toString(36),
  ruleId: "R",
  title: "T",
  description: "d",
  recommendation: "r",
  severity: "LOW",
  status: "OPEN",
  scope: "PAGE",
  evidence: null,
  lastSeenAt: new Date(),
  ...o,
});

test("groups by rule and ranks by severity × affected pages, not count alone", () => {
  const rows = [
    ...Array.from({ length: 30 }, () =>
      row({ ruleId: "IMG_DIMS", title: "Images", severity: "INFO" }),
    ),
    ...Array.from({ length: 3 }, () =>
      row({ ruleId: "HTTP_ERROR", title: "Errors", severity: "HIGH" }),
    ),
    ...Array.from({ length: 5 }, () =>
      row({ ruleId: "TITLE_LONG", title: "Titles", severity: "LOW" }),
    ),
  ];
  const groups = groupFindings(rows);
  expect(
    groups.map((g) => [g.ruleId, g.findings.length, g.impact, g.impactLabel]),
  ).toEqual([
    ["HTTP_ERROR", 3, 120, "High impact"],
    ["IMG_DIMS", 30, 30, "Medium impact"],
    ["TITLE_LONG", 5, 25, "Medium impact"],
  ]);
});

test("describeEvidence turns production evidence shapes into plain language", () => {
  expect(
    describeEvidence("TECH_TITLE_TOO_LONG", {
      url: "u",
      actualLength: 72,
      maxLength: 60,
    }),
  ).toBe("72 characters (recommended max 60)");
  expect(
    describeEvidence("TECH_TITLE_TOO_SHORT", {
      actualLength: 9,
      minLength: 15,
    }),
  ).toBe("9 characters (recommended min 15)");
  expect(
    describeEvidence("TECH_IMAGE_MISSING_DIMENSIONS", {
      affectedCount: 3,
      totalCount: 10,
    }),
  ).toBe("3 of 10 images");
  expect(
    describeEvidence("TECH_CANONICAL_EXTERNAL", {
      canonicalHost: "other.example",
    }),
  ).toBe("Canonical points to other.example");
  expect(describeEvidence("TECH_HTTP_ERROR", { httpStatus: 404 })).toBe(
    "Returns HTTP 404",
  );
  expect(describeEvidence("TECH_DUPLICATE_TITLE", { count: 4, urls: [] })).toBe(
    "Shared by 4 pages",
  );
  expect(describeEvidence("X", { url: "only" })).toBeNull();
  expect(describeEvidence("X", null)).toBeNull();
});

test("findingTarget", () => {
  expect(
    findingTarget({ scope: "PAGE", evidence: { url: "https://a.example/x" } }),
  ).toBe("https://a.example/x");
  expect(findingTarget({ scope: "SITE", evidence: {} })).toBe("Whole site");
});
