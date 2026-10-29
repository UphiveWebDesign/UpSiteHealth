import { describe, expect, test } from "vitest";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import { BOM } from "./csv";
import { reportCsv } from "./exports";
import { reportScore, type WebsiteReportRow } from "./summary";

const NOW = new Date("2026-10-24T12:00:00Z");
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const dim = (
  dimension: string,
  at: Date | null,
  extra: Record<string, unknown> = {},
) => ({
  dimension,
  measured: true,
  score: 80,
  sourceTimestamp: at?.toISOString() ?? null,
  ...extra,
});
const snapshot = (score: number | null, dimensions: unknown) => ({
  score,
  dimensions,
});

describe("report score freshness", () => {
  test("fresh: the oldest evidence date is given and the score kept", () => {
    expect(
      reportScore(
        snapshot(82, [dim("AVAILABILITY", ago(1)), dim("SSL", ago(3))]),
        NOW,
      ),
    ).toEqual({
      latestScore: 82,
      scoreFreshness: "fresh",
      scoreEvidenceAt: ago(3),
    });
  });

  test("stale: labelled out of date, the score value unchanged", () => {
    const old = ago(EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO + 5);
    expect(
      reportScore(
        snapshot(91, [
          dim("AVAILABILITY", ago(1)),
          dim("TECHNICAL_SEO", old, { evidence: { crawlStatus: "COMPLETED" } }),
        ]),
        NOW,
      ),
    ).toEqual({
      latestScore: 91,
      scoreFreshness: "stale",
      scoreEvidenceAt: old,
    });
  });

  test("incomplete: a partial crawl is labelled, with its date", () => {
    expect(
      reportScore(
        snapshot(70, [
          dim("AVAILABILITY", ago(0)),
          dim("TECHNICAL_SEO", ago(2), {
            evidence: { crawlStatus: "PARTIAL" },
          }),
        ]),
        NOW,
      ),
    ).toEqual({
      latestScore: 70,
      scoreFreshness: "incomplete",
      scoreEvidenceAt: ago(2),
    });
  });

  test("missing: no snapshot, or nothing measured, has no date", () => {
    expect(reportScore(undefined, NOW)).toEqual({
      latestScore: null,
      scoreFreshness: "missing",
      scoreEvidenceAt: null,
    });
    expect(
      reportScore(
        snapshot(null, [{ dimension: "PERFORMANCE", measured: false }]),
        NOW,
      ),
    ).toEqual({
      latestScore: null,
      scoreFreshness: "missing",
      scoreEvidenceAt: null,
    });
    // An older snapshot without stored dimensions: score kept, no evidence.
    expect(reportScore(snapshot(64, null), NOW)).toEqual({
      latestScore: 64,
      scoreFreshness: "missing",
      scoreEvidenceAt: null,
    });
  });

  test("unknown: no timestamp is invented for undated or future evidence", () => {
    expect(reportScore(snapshot(75, [dim("AVAILABILITY", null)]), NOW)).toEqual(
      {
        latestScore: 75,
        scoreFreshness: "unknown",
        scoreEvidenceAt: null,
      },
    );
    const future = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    expect(
      reportScore(snapshot(75, [dim("AVAILABILITY", future)]), NOW),
    ).toEqual({
      latestScore: 75,
      scoreFreshness: "unknown",
      scoreEvidenceAt: null,
    });
    // A dated dimension still gives its date beside an undated one.
    expect(
      reportScore(
        snapshot(75, [dim("SSL", ago(2)), dim("AVAILABILITY", null)]),
        NOW,
      ),
    ).toMatchObject({ scoreFreshness: "unknown", scoreEvidenceAt: ago(2) });
  });
});

describe("report CSV", () => {
  const row = (over: Partial<WebsiteReportRow>): WebsiteReportRow => ({
    websiteId: "w",
    name: "Site",
    domain: "site.test",
    status: "UP",
    uptimePercent: 100,
    conclusiveChecks: 4,
    avgResponseMs: 200,
    incidents: 0,
    openIssues: 0,
    openSeoFindings: 1,
    latestScore: 82,
    scoreFreshness: "fresh",
    scoreEvidenceAt: ago(3),
    ...over,
  });
  const lines = (csv: string) => csv.replace(BOM, "").trimEnd().split("\r\n");

  test("score_freshness and score_evidence_at sit beside latest_score", () => {
    const [head, fresh, stale, missing, unknown] = lines(
      reportCsv(
        [
          row({}),
          row({
            latestScore: 91,
            scoreFreshness: "stale",
            scoreEvidenceAt: ago(70),
          }),
          row({
            latestScore: null,
            scoreFreshness: "missing",
            scoreEvidenceAt: null,
          }),
          row({ scoreFreshness: "unknown", scoreEvidenceAt: null }),
        ],
        30,
      ),
    );
    expect(head.split(",").slice(-3)).toEqual([
      "latest_score",
      "score_freshness",
      "score_evidence_at",
    ]);
    expect(fresh.split(",").slice(-3)).toEqual([
      "82",
      "fresh",
      ago(3).toISOString(),
    ]);
    expect(stale.split(",").slice(-3)).toEqual([
      "91",
      "stale",
      ago(70).toISOString(),
    ]);
    expect(missing.split(",").slice(-3)).toEqual(["", "missing", ""]);
    expect(unknown.split(",").slice(-3)).toEqual(["82", "unknown", ""]);
  });
});
