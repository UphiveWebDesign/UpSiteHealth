import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEST_DATABASE_URL, uid } from "./helpers";

/**
 * P1 PostgreSQL safety probe (docs/specs/finding-resolution-provenance.md,
 * section 7). Proves, instead of assuming, the database behaviours the
 * proposed `seo_finding_events` deletion and immutability design rests on.
 *
 * Safety:
 * - Opt-in twice: the verified test database (tests/setup.ts guard and
 *   marker) AND UPSITEHEALTH_P1_PROBE=yes, so a broad integration run never
 *   includes it. The server must also report the itest-ci branch.
 * - Everything happens in ONE transaction that is always rolled back, inside
 *   a new, uniquely named schema holding small replica tables with the same
 *   foreign-key actions as the real ones. No real table is read for writing,
 *   referenced or locked; nothing persists, even if the process dies (the
 *   server aborts an open transaction when the connection drops).
 * - Each scenario runs in a savepoint and is rolled back to it, so later
 *   scenarios start from the same fixture.
 * - Diagnostics are NOTICEs (they survive rollbacks), not table rows.
 *
 * Fidelity: the replica tables carry the real tables' ON DELETE actions
 * (prisma/schema.prisma) and the proposed event table, triggers and
 * constraints as in the plan, except that the trigger functions pin
 * search_path to the probe schema instead of `public`. Migration 5 on
 * itest-ci and its integration tests confirm the real tables later.
 */

const ITEST_BRANCH = "br-noisy-glade-b4rjvu65";
const ENABLED =
  !!TEST_DATABASE_URL && process.env.UPSITEHEALTH_P1_PROBE === "yes";

/**
 * How the event table's references to findings and crawl runs are checked.
 * "plan": NO ACTION, not deferrable (the plan's text). "deferred": NO ACTION
 * DEFERRABLE INITIALLY DEFERRED (checked at commit, after every cascade).
 * Which one deletes a whole website while refusing partial deletion is
 * exactly what the probe must establish: a NO ACTION check queued inside a
 * nested cascade query may run at the end of that nested query.
 */
type Variant = "plan" | "deferred";
const VARIANTS: Variant[] = ["plan", "deferred"];

/** The replica and the proposed P1 objects, in schema `s`. */
function probeDdl(s: string, variant: Variant): string {
  const timing = variant === "deferred" ? " DEFERRABLE INITIALLY DEFERRED" : "";
  return `
CREATE SCHEMA "${s}";

CREATE TABLE "${s}".organizations (id text PRIMARY KEY);
CREATE TABLE "${s}".websites (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "${s}".organizations(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "${s}".crawl_runs (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "${s}".organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "websiteId" text NOT NULL REFERENCES "${s}".websites(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status text NOT NULL
);
CREATE TABLE "${s}".crawl_pages (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "${s}".organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "websiteId" text NOT NULL REFERENCES "${s}".websites(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "crawlRunId" text NOT NULL REFERENCES "${s}".crawl_runs(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "${s}".seo_findings (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "${s}".organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "websiteId" text NOT NULL REFERENCES "${s}".websites(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "crawlRunId" text NOT NULL REFERENCES "${s}".crawl_runs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "crawlPageId" text REFERENCES "${s}".crawl_pages(id) ON DELETE SET NULL ON UPDATE CASCADE,
  status text NOT NULL
);

CREATE TYPE "${s}"."SeoFindingEventType" AS ENUM ('RESOLVED', 'REOPENED');
CREATE TYPE "${s}"."FindingResolutionReason" AS ENUM ('FIX_CONFIRMED', 'NOT_APPLICABLE', 'RULE_RETIRED', 'UNKNOWN');

CREATE TABLE "${s}".seo_finding_events (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "${s}".organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "websiteId" text NOT NULL REFERENCES "${s}".websites(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "seoFindingId" text NOT NULL REFERENCES "${s}".seo_findings(id) ON DELETE NO ACTION ON UPDATE NO ACTION${timing},
  type "${s}"."SeoFindingEventType" NOT NULL,
  reason "${s}"."FindingResolutionReason",
  "crawlRunId" text NOT NULL REFERENCES "${s}".crawl_runs(id) ON DELETE NO ACTION ON UPDATE NO ACTION${timing},
  detail jsonb,
  CONSTRAINT seo_finding_events_reason_on_resolved CHECK ((type = 'RESOLVED') = (reason IS NOT NULL)),
  CONSTRAINT seo_finding_events_detail_size CHECK (detail IS NULL OR octet_length(detail::text) <= 4096),
  CONSTRAINT seo_finding_events_unique UNIQUE ("seoFindingId", "crawlRunId", type)
);

CREATE FUNCTION "${s}".seo_finding_events_tenancy() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, "${s}" AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seo_findings f WHERE f.id = NEW."seoFindingId"
       AND f."websiteId" = NEW."websiteId" AND f."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'seo_finding_events: finding % belongs to another website or organization', NEW."seoFindingId";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crawl_runs c WHERE c.id = NEW."crawlRunId"
       AND c."websiteId" = NEW."websiteId" AND c."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'seo_finding_events: crawl run % belongs to another website or organization', NEW."crawlRunId";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seo_finding_events_tenancy BEFORE INSERT ON "${s}".seo_finding_events
  FOR EACH ROW EXECUTE FUNCTION "${s}".seo_finding_events_tenancy();

CREATE FUNCTION "${s}".seo_finding_events_no_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, "${s}" AS $$
BEGIN
  RAISE EXCEPTION 'seo_finding_events is append-only';
END $$;
CREATE TRIGGER seo_finding_events_no_update BEFORE UPDATE ON "${s}".seo_finding_events
  FOR EACH ROW EXECUTE FUNCTION "${s}".seo_finding_events_no_update();

CREATE FUNCTION "${s}".seo_finding_events_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, "${s}" AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND (
       NOT EXISTS (SELECT 1 FROM websites w WHERE w.id = OLD."websiteId")
    OR NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = OLD."organizationId"))
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'seo_finding_events is append-only (deleted only with its website or organization)';
END $$;
CREATE TRIGGER seo_finding_events_no_delete BEFORE DELETE ON "${s}".seo_finding_events
  FOR EACH ROW EXECUTE FUNCTION "${s}".seo_finding_events_no_delete();

CREATE FUNCTION "${s}".seo_finding_events_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, "${s}" AS $$
BEGIN
  RAISE EXCEPTION 'seo_finding_events cannot be truncated';
END $$;
CREATE TRIGGER seo_finding_events_no_truncate BEFORE TRUNCATE ON "${s}".seo_finding_events
  FOR EACH STATEMENT EXECUTE FUNCTION "${s}".seo_finding_events_no_truncate();

-- Diagnostics only (not part of P1): one NOTICE per deleted row, before the
-- guard ("a_" sorts first, so it fires first), with the trigger depth and
-- whether the row's website and organization are still visible.
CREATE FUNCTION "${s}".a_probe_delete_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, "${s}" AS $$
DECLARE w boolean; o boolean;
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    w := NULL; o := EXISTS (SELECT 1 FROM organizations x WHERE x.id = OLD.id);
  ELSIF TG_TABLE_NAME = 'websites' THEN
    w := EXISTS (SELECT 1 FROM websites x WHERE x.id = OLD.id);
    o := EXISTS (SELECT 1 FROM organizations x WHERE x.id = OLD."organizationId");
  ELSE
    w := EXISTS (SELECT 1 FROM websites x WHERE x.id = OLD."websiteId");
    o := EXISTS (SELECT 1 FROM organizations x WHERE x.id = OLD."organizationId");
  END IF;
  RAISE NOTICE 'probe-delete %|%|%|%|%', TG_TABLE_NAME, OLD.id, pg_trigger_depth(), w, o;
  RETURN OLD;
END $$;
CREATE TRIGGER a_probe_delete_notice BEFORE DELETE ON "${s}".organizations FOR EACH ROW EXECUTE FUNCTION "${s}".a_probe_delete_notice();
CREATE TRIGGER a_probe_delete_notice BEFORE DELETE ON "${s}".websites FOR EACH ROW EXECUTE FUNCTION "${s}".a_probe_delete_notice();
CREATE TRIGGER a_probe_delete_notice BEFORE DELETE ON "${s}".crawl_runs FOR EACH ROW EXECUTE FUNCTION "${s}".a_probe_delete_notice();
CREATE TRIGGER a_probe_delete_notice BEFORE DELETE ON "${s}".seo_findings FOR EACH ROW EXECUTE FUNCTION "${s}".a_probe_delete_notice();
CREATE TRIGGER a_probe_delete_notice BEFORE DELETE ON "${s}".seo_finding_events FOR EACH ROW EXECUTE FUNCTION "${s}".a_probe_delete_notice();

-- Fixture. Organization A: website A1 (the history under test) and A2
-- (must survive A1's deletion); organization B: website B1.
INSERT INTO "${s}".organizations VALUES ('o_a'), ('o_b');
INSERT INTO "${s}".websites VALUES ('w_a1', 'o_a'), ('w_a2', 'o_a'), ('w_b1', 'o_b');
INSERT INTO "${s}".crawl_runs VALUES
  ('c_close', 'o_a', 'w_a1', 'PARTIAL'),   -- closed F1
  ('c_reopen', 'o_a', 'w_a1', 'COMPLETED'), -- reopened F1
  ('c_seen', 'o_a', 'w_a1', 'COMPLETED'),   -- F1 last seen here (no event)
  ('c_free', 'o_a', 'w_a1', 'COMPLETED'),   -- no finding, no event
  ('c_a2', 'o_a', 'w_a2', 'COMPLETED'),
  ('c_b1', 'o_b', 'w_b1', 'COMPLETED');
INSERT INTO "${s}".crawl_pages VALUES
  ('p_a1', 'o_a', 'w_a1', 'c_seen'), ('p_a2', 'o_a', 'w_a2', 'c_a2'), ('p_b1', 'o_b', 'w_b1', 'c_b1');
INSERT INTO "${s}".seo_findings VALUES
  ('f1', 'o_a', 'w_a1', 'c_seen', 'p_a1', 'OPEN'),  -- has history
  ('f2', 'o_a', 'w_a1', 'c_free', NULL, 'OPEN'),    -- no history
  ('f_a2', 'o_a', 'w_a2', 'c_a2', 'p_a2', 'RESOLVED'),
  ('f_b1', 'o_b', 'w_b1', 'c_b1', 'p_b1', 'RESOLVED');
INSERT INTO "${s}".seo_finding_events VALUES
  ('e1', 'o_a', 'w_a1', 'f1', 'RESOLVED', 'NOT_APPLICABLE', 'c_close', '{"why":"canonical"}'),
  ('e2', 'o_a', 'w_a1', 'f1', 'REOPENED', NULL, 'c_reopen', NULL),
  ('e_a2', 'o_a', 'w_a2', 'f_a2', 'RESOLVED', 'FIX_CONFIRMED', 'c_a2', NULL),
  ('e_b1', 'o_b', 'w_b1', 'f_b1', 'RESOLVED', 'FIX_CONFIRMED', 'c_b1', NULL);
`;
}

const TABLES = [
  "organizations",
  "websites",
  "crawl_runs",
  "crawl_pages",
  "seo_findings",
  "seo_finding_events",
] as const;
/** Real tables whose counts must be identical before and after. */
const PUBLIC_TABLES = [
  "organizations",
  "websites",
  "crawl_runs",
  "crawl_pages",
  "seo_findings",
  "recommendations",
  "recommendation_events",
];

type Notice = {
  table: string;
  id: string;
  depth: number;
  website: boolean | null;
  org: boolean | null;
};

describe.skipIf(!ENABLED)("P1 PostgreSQL safety probe (rolled back)", () => {
  const base = `p1_probe_${uid()
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase()}`;
  const schemaOf = (v: Variant) => `${base}_${v}`;
  let client: pg.Client;
  const notices: Notice[] = [];
  let publicBefore: Record<string, number> = {};

  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  const bool = (v: string) => (v === "t" ? true : v === "f" ? false : null);
  const publicCounts = async () => {
    const out: Record<string, number> = {};
    for (const t of PUBLIC_TABLES)
      out[t] = Number(
        (await q(`SELECT count(*) FROM public.${t}`)).rows[0].count,
      );
    return out;
  };

  /** Runs `fn` in a savepoint and always rolls back to it. */
  async function scenario<T>(fn: () => Promise<T>): Promise<T> {
    await q("SAVEPOINT probe_case");
    notices.length = 0;
    try {
      return await fn();
    } finally {
      await q("ROLLBACK TO SAVEPOINT probe_case");
    }
  }
  /**
   * Runs `sql`, then forces every deferred check now (SET CONSTRAINTS ALL
   * IMMEDIATE applies retroactively to pending checks), standing in for the
   * commit the probe never makes.
   */
  async function untilCommit(sql: string) {
    await q(sql);
    await q("SET CONSTRAINTS ALL IMMEDIATE");
  }
  /** The statement, or its commit-time checks, must fail. */
  async function refused(run: () => Promise<unknown>, label: string) {
    try {
      await run();
    } catch (error) {
      return error as { code?: string; message: string; constraint?: string };
    }
    throw new Error(`expected a refusal, but it succeeded: ${label}`);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    client.on("notice", (n) => {
      const m = /^probe-delete (.+)$/.exec(n.message ?? "");
      if (!m) return;
      const [table, id, depth, w, o] = m[1].split("|");
      notices.push({
        table,
        id,
        depth: Number(depth),
        website: bool(w),
        org: bool(o),
      });
    });
    // Identity before anything else: the server must say it is itest-ci.
    const { rows } = await q(
      "SELECT current_setting('neon.branch_id', true) AS branch, current_database() AS db",
    );
    if (rows[0].branch !== ITEST_BRANCH || rows[0].db !== "upsitehealth_test")
      throw new Error("Refusing the P1 probe: the server is not itest-ci.");
    const leftovers = await q(
      "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'p1_probe_%'",
    );
    expect(Number(leftovers.rows[0].count)).toBe(0);
    publicBefore = await publicCounts();

    await q("BEGIN");
    await q("SET LOCAL statement_timeout = '60s'");
    await q("SET LOCAL lock_timeout = '5s'");
    for (const v of VARIANTS) await q(probeDdl(schemaOf(v), v));
    // The "deferred" fixture's own event inserts queue deferred foreign-key
    // checks, which stay pending in a transaction that never commits, and
    // PostgreSQL refuses TRUNCATE and ALTER TABLE on a table with pending
    // trigger events (first run, 2026-11-02). Check them now (they pass),
    // then restore deferred mode for exactly these two constraints, so the
    // scenarios start with nothing pending, as after a real commit.
    const deferred = schemaOf("deferred");
    const fks = `"${deferred}"."seo_finding_events_seoFindingId_fkey", "${deferred}"."seo_finding_events_crawlRunId_fkey"`;
    await q(`SET CONSTRAINTS ${fks} IMMEDIATE`);
    await q(`SET CONSTRAINTS ${fks} DEFERRED`);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await q("ROLLBACK");
      // Nothing persists: the schemas are gone, real tables unchanged.
      const left = await q(
        "SELECT count(*) FROM pg_namespace WHERE nspname LIKE $1",
        [`${base}%`],
      );
      expect(Number(left.rows[0].count)).toBe(0);
      expect(await publicCounts()).toEqual(publicBefore);
    } finally {
      await client.end();
    }
  });

  describe.each(VARIANTS)("history references checked: %s", (variant) => {
    const schema = schemaOf(variant);
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const t of TABLES)
        out[t] = Number(
          (await q(`SELECT count(*) FROM "${schema}".${t}`)).rows[0].count,
        );
      return out;
    };
    const ids = async (table: string) =>
      (await q(`SELECT id FROM "${schema}".${table} ORDER BY id`)).rows.map(
        (r: { id: string }) => r.id,
      );
    const FIXTURE = {
      organizations: 2,
      websites: 3,
      crawl_runs: 6,
      crawl_pages: 3,
      seo_findings: 4,
      seo_finding_events: 4,
    };

    test("0. fixture as built; real tables untouched inside the transaction", async () => {
      expect(await counts()).toEqual(FIXTURE);
      expect(await publicCounts()).toEqual(publicBefore);
    });

    test("1. deleting a website removes its history (also at commit); event deletes are nested and see the website gone", async () => {
      await scenario(async () => {
        await untilCommit(`DELETE FROM "${schema}".websites WHERE id = 'w_a1'`);
        expect(await ids("websites")).toEqual(["w_a2", "w_b1"]);
        expect(await ids("seo_findings")).toEqual(["f_a2", "f_b1"]);
        expect(await ids("crawl_runs")).toEqual(["c_a2", "c_b1"]);
        expect(await ids("seo_finding_events")).toEqual(["e_a2", "e_b1"]);
        const events = notices.filter((n) => n.table === "seo_finding_events");
        expect(events.map((n) => n.id).sort()).toEqual(["e1", "e2"]);
        for (const n of events) {
          expect(n.depth).toBeGreaterThan(1);
          expect(n.website).toBe(false);
        }
        const site = notices.find((n) => n.table === "websites")!;
        expect(site.depth).toBe(1);
        expect(notices.indexOf(site)).toBeLessThan(
          notices.findIndex((n) => n.table === "seo_finding_events"),
        );
      });
    });

    test("2. deleting an organization removes all its websites' history and nothing of another organization", async () => {
      await scenario(async () => {
        await untilCommit(
          `DELETE FROM "${schema}".organizations WHERE id = 'o_a'`,
        );
        expect(await ids("organizations")).toEqual(["o_b"]);
        expect(await ids("seo_finding_events")).toEqual(["e_b1"]);
        expect(await ids("seo_findings")).toEqual(["f_b1"]);
        for (const n of notices.filter(
          (x) => x.table === "seo_finding_events",
        )) {
          expect(n.depth).toBeGreaterThan(1);
          expect(n.website === false || n.org === false).toBe(true);
        }
      });
    });

    test("3. a direct event delete is refused (top level, website present)", async () => {
      await scenario(async () => {
        const e = await refused(
          () =>
            untilCommit(
              `DELETE FROM "${schema}".seo_finding_events WHERE id = 'e1'`,
            ),
          "direct event delete",
        );
        expect(e.message).toMatch(/append-only/);
      });
      expect(await ids("seo_finding_events")).toContain("e1");
      expect(notices.find((x) => x.id === "e1")).toMatchObject({
        depth: 1,
        website: true,
        org: true,
      });
    });

    test("4. a finding with history cannot be deleted (at the latest at commit); one without history can", async () => {
      await scenario(async () => {
        const e = await refused(
          () =>
            untilCommit(`DELETE FROM "${schema}".seo_findings WHERE id = 'f1'`),
          "finding with history",
        );
        expect(e.code).toBe("23503");
        expect(e.constraint).toMatch(/seoFindingId/);
      });
      await scenario(async () => {
        await untilCommit(
          `DELETE FROM "${schema}".seo_findings WHERE id = 'f2'`,
        );
        expect(await ids("seo_findings")).not.toContain("f2");
      });
      expect(await ids("seo_findings")).toEqual(["f1", "f2", "f_a2", "f_b1"]);
    });

    test("5. crawl runs: refused when an event names them or their cascade reaches a finding with history; allowed otherwise", async () => {
      for (const id of ["c_close", "c_seen"])
        await scenario(async () => {
          const e = await refused(
            () =>
              untilCommit(
                `DELETE FROM "${schema}".crawl_runs WHERE id = '${id}'`,
              ),
            `crawl run ${id}`,
          );
          expect(e.code).toBe("23503");
        });
      await scenario(async () => {
        await untilCommit(
          `DELETE FROM "${schema}".crawl_runs WHERE id = 'c_free'`,
        );
        expect(await ids("crawl_runs")).not.toContain("c_free");
        expect(await ids("seo_findings")).not.toContain("f2");
      });
    });

    test("6. no update of any event column, including a no-op and a valid crawl reference", async () => {
      for (const sql of [
        `UPDATE "${schema}".seo_finding_events SET detail = '{}' WHERE id = 'e1'`,
        `UPDATE "${schema}".seo_finding_events SET "crawlRunId" = 'c_reopen' WHERE id = 'e1'`,
        `UPDATE "${schema}".seo_finding_events SET reason = 'FIX_CONFIRMED' WHERE id = 'e1'`,
        `UPDATE "${schema}".seo_finding_events SET id = id WHERE id = 'e1'`,
      ])
        await scenario(async () => {
          expect((await refused(() => q(sql), sql)).message).toMatch(
            /append-only/,
          );
        });
      expect(
        (
          await q(
            `SELECT reason FROM "${schema}".seo_finding_events WHERE id = 'e1'`,
          )
        ).rows[0].reason,
      ).toBe("NOT_APPLICABLE");
    });

    test("7. truncate is refused, directly and through a parent's TRUNCATE … CASCADE", async () => {
      for (const sql of [
        `TRUNCATE "${schema}".seo_finding_events`,
        `TRUNCATE "${schema}".seo_findings CASCADE`,
      ])
        await scenario(async () => {
          expect((await refused(() => q(sql), sql)).message).toMatch(
            /cannot be truncated/,
          );
        });
      expect((await counts()).seo_finding_events).toBe(4);
    });

    test("8. organization and website consistency, reason pairing, size and uniqueness", async () => {
      const insert = (values: string) =>
        `INSERT INTO "${schema}".seo_finding_events VALUES ${values}`;
      const cases: Array<[string, RegExp | string]> = [
        [
          insert(`('x1','o_a','w_a2','f1','REOPENED',NULL,'c_a2',NULL)`),
          /another website or organization/,
        ],
        [
          insert(`('x2','o_a','w_a1','f1','REOPENED',NULL,'c_b1',NULL)`),
          /another website or organization/,
        ],
        [
          insert(`('x3','o_a','w_a1','f2','REOPENED','UNKNOWN','c_free',NULL)`),
          "23514",
        ],
        [
          insert(`('x4','o_a','w_a1','f2','RESOLVED',NULL,'c_free',NULL)`),
          "23514",
        ],
        [
          insert(
            `('x5','o_a','w_a1','f2','RESOLVED','UNKNOWN','c_free', jsonb_build_object('t', repeat('x', 5000)))`,
          ),
          "23514",
        ],
        [
          insert(
            `('x6','o_a','w_a1','f1','RESOLVED','UNKNOWN','c_close',NULL)`,
          ),
          "23505",
        ],
      ];
      for (const [sql, expected] of cases)
        await scenario(async () => {
          const e = await refused(() => q(sql), sql);
          if (typeof expected === "string") expect(e.code).toBe(expected);
          else expect(e.message).toMatch(expected);
        });
      // A valid new cycle: RESOLVED again by another crawl.
      await scenario(async () => {
        await q(
          insert(
            `('x7','o_a','w_a1','f1','RESOLVED','FIX_CONFIRMED','c_free',NULL)`,
          ),
        );
        expect((await counts()).seo_finding_events).toBe(5);
      });
    });

    test("9. timing: a partial delete is refused at the statement (plan) or at commit (deferred); RESTRICT also lets the website cascade through but refuses a direct delete", async () => {
      await scenario(async () => {
        // Not forced: shows when this variant refuses.
        const atOnce = await q(
          `DELETE FROM "${schema}".seo_findings WHERE id = 'f1'`,
        )
          .then(() => false)
          .catch(() => true);
        expect(atOnce).toBe(variant === "plan");
      });
      // First run (2026-11-02): with RESTRICT the website delete succeeded.
      // Referential-action queries do not fire their own AFTER triggers until
      // the outer statement ends (inferred from that result), so RESTRICT and
      // NO ACTION both see the events already deleted. RESTRICT is therefore
      // no proof of the plan's rationale; what still differs is a direct
      // delete, refused with restrict_violation.
      for (const [label, sql, check] of [
        [
          "website delete with RESTRICT succeeds",
          `DELETE FROM "${schema}".websites WHERE id = 'w_a1'`,
          null,
        ],
        [
          "direct finding delete with RESTRICT is refused",
          `DELETE FROM "${schema}".seo_findings WHERE id = 'f1'`,
          "23001",
        ],
      ] as const)
        await scenario(async () => {
          await q(`ALTER TABLE "${schema}".seo_finding_events
            DROP CONSTRAINT "seo_finding_events_seoFindingId_fkey",
            ADD CONSTRAINT "seo_finding_events_seoFindingId_fkey" FOREIGN KEY ("seoFindingId")
              REFERENCES "${schema}".seo_findings(id) ON DELETE RESTRICT`);
          if (check === null) {
            await untilCommit(sql);
            expect(await ids("seo_finding_events")).toEqual(["e_a2", "e_b1"]);
          } else {
            expect((await refused(() => untilCommit(sql), label)).code).toBe(
              check,
            );
          }
        });
    });

    test("10. bypass attempts: a nested delete while the website exists is refused; replica mode needs a superuser", async () => {
      await scenario(async () => {
        await q(`CREATE TABLE "${schema}".sneaky (id int)`);
        await q(`CREATE FUNCTION "${schema}".sneaky_delete() RETURNS trigger
          LANGUAGE plpgsql SET search_path = pg_catalog, "${schema}" AS $$
          BEGIN DELETE FROM seo_finding_events WHERE id = 'e1'; RETURN NEW; END $$`);
        await q(`CREATE TRIGGER sneaky AFTER INSERT ON "${schema}".sneaky
          FOR EACH ROW EXECUTE FUNCTION "${schema}".sneaky_delete()`);
        const e = await refused(
          () => q(`INSERT INTO "${schema}".sneaky VALUES (1)`),
          "nested delete",
        );
        expect(e.message).toMatch(/append-only/);
      });
      await scenario(async () => {
        const e = await refused(
          () => q("SET LOCAL session_replication_role = replica"),
          "replica mode",
        );
        expect(e.code).toBe("42501");
      });
      expect(await ids("seo_finding_events")).toContain("e1");
    });

    test("11. after every scenario the fixture is exactly as built (savepoint rollback preserves pre-existing rows)", async () => {
      expect(await counts()).toEqual(FIXTURE);
      expect(await ids("seo_finding_events")).toEqual([
        "e1",
        "e2",
        "e_a2",
        "e_b1",
      ]);
    });
  });
});
