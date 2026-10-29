import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Database target rules shared by the integration-test guard
 * (tests/integration/test-db-guard.ts) and the Prisma CLI guard
 * (prisma.config.ts). Nothing here connects to a database or resolves a
 * hostname; the only I/O is reading the repository's .env files.
 *
 * A target is either local (this machine) or hosted. Local test databases
 * are allowed except the development instance (port 51214). Exactly one
 * hosted database may be used for tests or test schema setup: the DNS name
 * in UPSITEHEALTH_TEST_DB_HOST, compared exactly, over the direct
 * (non-pooled) endpoint with sslmode=require. A Neon target is refused
 * unless the production endpoints are recorded in NEON_PRODUCTION_ENDPOINTS
 * and it is not one of them, it is not the shared manual-testing endpoint
 * (NEON_SHARED_ENDPOINTS, never accepted, no override), and it is on the
 * committed integration-test allowlist (NEON_TEST_ENDPOINTS). Production is
 * always refused. Anything malformed or ambiguous is refused.
 *
 * Limitation: a DNS name is classified by its spelling only. A name that
 * resolves to this machine (other than localhost and *.localhost) is not
 * detected; the exact-host approval and the marker table cover that case.
 */

export const PRODUCTION_PROJECT_REF = "xdaxegotsoumwwxjlbnl";
/** Substrings that mark a production (Supabase) target anywhere in a URL. */
const PRODUCTION_MARKERS = [
  PRODUCTION_PROJECT_REF,
  "supabase.co",
  "supabase.com",
];

/**
 * Endpoint IDs (`ep-…`, without `-pooler`) of every compute endpoint on the
 * Neon production branch, read-write and read replicas, copied from the Neon
 * console after review (docs/operations/testing.md). They are not secrets.
 *
 * Fails closed: while this list is empty, no Neon database can be told apart
 * from production, so every Neon target is refused for tests and for test
 * schema setup. An entry that is not a bare endpoint ID refuses them too.
 */
export const NEON_PRODUCTION_ENDPOINTS: readonly string[] = [
  // Project UpSiteHealth (small-morning-39288389), branch `production`
  // (br-raspy-firefly-b4iz0xio): primary read-write endpoint.
  "ep-square-mud-b4ito98o",
];
/**
 * Neon endpoints that hold shared data people rely on, which the
 * integration suite must never touch: refused as a test target and for
 * test schema setup in every spelling, whatever the environment approves.
 * Not a parameter anywhere, so no caller or setting can remove an entry.
 */
export const NEON_SHARED_ENDPOINTS: readonly string[] = [
  // Branch integration-tests (br-noisy-dust-b4i1uvhg): despite its name, the
  // shared manual-testing database (the port-3001 `.next-neon` dev server).
  "ep-dark-rain-b4ve04n3",
];

/**
 * The committed allowlist of Neon endpoints that may be used as the
 * integration-test database (the dedicated `itest-ci` branch, once it exists
 * and its endpoint ID is verified and approved; docs/operations/testing.md).
 * A Neon test target must be on it as well as approved by
 * UPSITEHEALTH_TEST_DB_HOST: one decision in reviewed code, one in the shell.
 *
 * Fails closed: while it is empty, every Neon test target is refused. An
 * entry that is malformed, or that is also a production or shared endpoint,
 * refuses every Neon target too.
 */
export const NEON_TEST_ENDPOINTS: readonly string[] = [
  // Project UpSiteHealth (small-morning-39288389), branch `itest-ci`
  // (br-noisy-glade-b4rjvu65; parent `production`, created schema-only):
  // its read-write endpoint, verified in the Neon console on 2026-10-25.
  "ep-long-surf-b4hm6pyi",
];

/**
 * The only database name a hosted test database may have: checked in the
 * URL before connecting, and again against current_database() and the
 * marker after (tests/integration/test-db-guard.ts). Neon's default
 * database (`neondb`, which every branch's default connection string uses)
 * is therefore never a test target.
 */
export const HOSTED_TEST_DATABASE = "upsitehealth_test";

/** A Neon endpoint ID as it appears in the first label of its hostname. */
const NEON_ENDPOINT_ID = /^ep-[a-z0-9]+(-[a-z0-9]+)*$/;
/** The local `prisma dev` development database (docs/operations/testing.md). */
export const DEV_DB_PORT = "51214";
export const TEST_DB_FLAG = "UPSITEHEALTH_ISOLATED_TEST_DB";
export const TEST_DB_HOST_VAR = "UPSITEHEALTH_TEST_DB_HOST";

/**
 * Query parameters that node-postgres copies over the URL's own host, port
 * or database (pg-connection-string), or that change SSL behind sslmode's
 * back: a URL using them does not say what it connects to.
 */
const OVERRIDING_PARAMS = new Set([
  "host",
  "hostaddr",
  "port",
  "dbname",
  "database",
  "service",
  "ssl",
]);

export type HostKind = "dns" | "ipv4" | "ipv6";

export type DbTarget = {
  /** Lower-case hostname or IP address, without brackets or a trailing dot. */
  host: string;
  kind: HostKind;
  port: string;
  database: string;
  local: boolean;
  /** Query parameters, names exactly as written (all lower case). */
  params: Map<string, string>;
  /**
   * The user name or password carries routing options (`endpoint=`,
   * `project=`), which Neon's proxy reads to pick an endpoint.
   */
  routingInCredentials: boolean;
};

/** A DNS label: letters, digits and inner hyphens, at most 63 characters. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Canonical dotted-quad IPv4: four decimal parts, no leading zeros. */
const CANONICAL_IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function localIPv4(octets: number[]): boolean {
  // 127/8 is loopback; 0/8 ("this network", including 0.0.0.0) reaches
  // this machine on common systems.
  return octets[0] === 127 || octets[0] === 0;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const parse = (s: string) =>
    s ? s.split(":").map((g) => parseInt(g, 16)) : [];
  const left = parse(head);
  const right = tail === null ? [] : parse(tail);
  const zeros =
    tail === null ? [] : Array(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

function localIPv6(address: string): boolean {
  const g = ipv6Groups(address);
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return true; // :: (unspecified)
  if (zeroPrefix(7) && g[7] === 1) return true; // ::1
  if (zeroPrefix(5) && g[5] === 0xffff) return localIPv4(embedded); // ::ffff:a.b.c.d
  if (zeroPrefix(6)) return localIPv4(embedded); // ::a.b.c.d (deprecated)
  return false;
}

/**
 * Classifies a hostname as written in a URL. IPv4 is accepted only in
 * canonical dotted-quad form: anything else that ends in a number (127.1,
 * 0177.0.0.1, 0x7f000001, 2130706433) is refused rather than interpreted,
 * because resolvers read those spellings differently.
 */
export function classifyHost(
  raw: string,
): { host: string; kind: HostKind; local: boolean } | { error: string } {
  const lower = raw.toLowerCase();
  const bracketed = /^\[(.*)\]$/.exec(lower);
  if (bracketed || lower.includes(":")) {
    const address = bracketed ? bracketed[1] : lower;
    if (!isIPv6(address)) return { error: "invalid IPv6 address" };
    return { host: address, kind: "ipv6", local: localIPv6(address) };
  }
  const host = lower.replace(/\.$/, "");
  if (!host) return { error: "no host (socket or empty host)" };
  const labels = host.split(".");
  const last = labels[labels.length - 1];
  // The URL standard's "ends in a number" rule: such a host is an IPv4
  // address in some notation, never a DNS name.
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) {
    if (!CANONICAL_IPV4.test(host) || !isIPv4(host))
      return {
        error: "IPv4 addresses must be written as four decimal parts (a.b.c.d)",
      };
    return {
      host,
      kind: "ipv4",
      local: localIPv4(host.split(".").map(Number)),
    };
  }
  if (host.length > 253 || !labels.every((l) => DNS_LABEL.test(l)))
    return { error: "unsupported characters in the host" };
  return {
    host,
    kind: "dns",
    local: host === "localhost" || host.endsWith(".localhost"),
  };
}

/** Parses a postgres URL strictly; an error describes why it is unusable. */
export function parseDbTarget(raw: string): DbTarget | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "not a valid URL" };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
    return { error: "not a postgres:// URL" };
  // postgres: is not a "special" URL scheme, so URL does not normalise the
  // hostname (IPv6 aside): classifyHost does, refusing what pg would decode.
  if (/%/.test(u.hostname)) return { error: "percent-encoded host" };
  const hostInfo = classifyHost(u.hostname);
  if ("error" in hostInfo) return hostInfo;
  const params = new Map<string, string>();
  for (const [key, value] of u.searchParams) {
    // node-postgres matches parameter names exactly (SSLMODE is ignored),
    // so a name is checked as written, and only lower case is accepted.
    if (key !== key.toLowerCase())
      return {
        error: `query parameter "${key}" must be lower case (the driver would ignore it)`,
      };
    if (params.has(key))
      return { error: `query parameter "${key}" is repeated` };
    if (OVERRIDING_PARAMS.has(key))
      return { error: `query parameter "${key}" overrides the URL's target` };
    params.set(key, value);
  }
  let database: string;
  let credentials: string;
  try {
    database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    credentials = decodeURIComponent(`${u.username}:${u.password}`);
  } catch {
    return { error: "malformed database name or credentials" };
  }
  return {
    host: hostInfo.host,
    kind: hostInfo.kind,
    port: u.port || "5432",
    database,
    local: hostInfo.local,
    params,
    routingInCredentials: /(endpoint|project)=/i.test(credentials),
  };
}

/** A host under neon.tech. */
export function isNeonHost(host: string): boolean {
  return host === "neon.tech" || host.endsWith(".neon.tech");
}

/**
 * The endpoint ID of a Neon host: the same for the direct
 * (`ep-x.region.aws.neon.tech`) and pooled (`ep-x-pooler.region…`) forms,
 * whatever the region or cell labels. Null for anything else, including a
 * Neon host whose first label is not an endpoint ID.
 */
export function neonEndpointId(host: string): string | null {
  if (!isNeonHost(host)) return null;
  const id = host.split(".")[0].replace(/-pooler$/, "");
  return NEON_ENDPOINT_ID.test(id) && !id.endsWith("-pooler") ? id : null;
}

/** Why the recorded Neon production endpoints cannot be relied on, or null. */
function neonProductionProblem(endpoints: readonly string[]): string | null {
  if (endpoints.length === 0)
    return "the Neon production endpoints are not recorded (NEON_PRODUCTION_ENDPOINTS in prisma/safety.ts), so a Neon database cannot be told apart from production";
  if (!endpoints.every((id) => neonEndpointId(`${id}.neon.tech`) === id))
    return "NEON_PRODUCTION_ENDPOINTS has an entry that is not a bare endpoint ID (ep-…, lower case, no -pooler)";
  return null;
}

/** A bare Neon endpoint ID (`ep-…`, lower case, no `-pooler`). */
export function isNeonEndpointId(id: unknown): id is string {
  return typeof id === "string" && neonEndpointId(`${id}.neon.tech`) === id;
}

/** Why the integration-test allowlist cannot be relied on, or null. */
function neonTestListProblem(
  endpoints: readonly string[],
  neonProduction: readonly string[],
): string | null {
  if (endpoints.length === 0)
    return "no dedicated Neon integration-test endpoint is recorded (NEON_TEST_ENDPOINTS in prisma/safety.ts), so no Neon database is approved for tests";
  if (!endpoints.every((id) => neonEndpointId(`${id}.neon.tech`) === id))
    return "NEON_TEST_ENDPOINTS has an entry that is not a bare endpoint ID (ep-…, lower case, no -pooler)";
  if (
    endpoints.some(
      (id) => neonProduction.includes(id) || NEON_SHARED_ENDPOINTS.includes(id),
    )
  )
    return "NEON_TEST_ENDPOINTS lists a production or shared endpoint";
  return null;
}

/**
 * The shared manual-testing endpoints (NEON_SHARED_ENDPOINTS), direct or
 * pooled, or named anywhere in the URL (for example in `options=endpoint=`).
 */
export function isSharedUrl(raw: string): boolean {
  const lower = raw.toLowerCase();
  return NEON_SHARED_ENDPOINTS.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * Known production markers: the project ref, Supabase domains, and the
 * recorded Neon production endpoints (direct or pooled, or named anywhere
 * in the URL, for example in an `options=endpoint=` parameter).
 */
export function isProductionUrl(
  raw: string,
  neonProduction: readonly string[] = NEON_PRODUCTION_ENDPOINTS,
): boolean {
  const lower = raw.toLowerCase();
  const markers = [...PRODUCTION_MARKERS, ...neonProduction];
  return markers.some((m) => m && lower.includes(m.toLowerCase()));
}

/** A connection-pooler endpoint (Neon's `-pooler` hosts, or a `pooler.` host). */
export function isPooledHost(host: string): boolean {
  return host
    .split(".")
    .some((label) => label === "pooler" || label.endsWith("-pooler"));
}

/**
 * The server a target reaches: every local address is one host (with its
 * port), and a Neon endpoint is one server whether reached directly or
 * through its pooler, on any port.
 */
export function serverIdentity(t: DbTarget): string {
  if (t.local) return `local:${t.port}`;
  const endpoint = neonEndpointId(t.host);
  return endpoint ? `neon:${endpoint}` : `${t.host}:${t.port}`;
}

/** Same server: see serverIdentity. */
export function sameServer(a: DbTarget, b: DbTarget): boolean {
  return serverIdentity(a) === serverIdentity(b);
}

/**
 * Database URLs recorded in a .env-style file: DATABASE_URL and DIRECT_URL
 * values, and every postgres:// value under any name, commented-out lines
 * included. They are (or were) the app's databases, so a test target must
 * not share a server with any of them. They are never used as a target.
 */
export function appUrlsFromEnvText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m =
      /^\s*(#+\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
        line,
      );
    if (!m) continue;
    const value = m[3].replace(/^(['"])(.*)\1$/, "$2");
    const appVar = !m[1] && (m[2] === "DATABASE_URL" || m[2] === "DIRECT_URL");
    if (appVar || /^postgres(ql)?:\/\//i.test(value)) out.push(value);
  }
  return out;
}

/** appUrlsFromEnvText for every `.env*` file in `root` except `.env.example`. */
export function appUrlsFromEnvFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => /^\.env(\..+)?$/.test(f) && f !== ".env.example")
    .sort()
    .flatMap((f) => appUrlsFromEnvText(readFileSync(join(root, f), "utf8")));
}

/**
 * Why `target` shares a server with one of `appUrls` (or why that cannot be
 * shown), or null.
 */
export function appServerClash(
  target: DbTarget,
  appUrls: string[],
): string | null {
  for (const app of appUrls.filter((u) => u.trim())) {
    const a = parseDbTarget(app);
    if ("error" in a)
      return `an app database URL (DATABASE_URL, DIRECT_URL or a database URL in .env) is unusable (${a.error}), so the target cannot be shown to be separate`;
    if (sameServer(target, a))
      return "it is on the same server as an app database URL (DATABASE_URL, DIRECT_URL or a database URL in .env, commented out or not; a Neon endpoint's direct and pooled hosts count as one server)";
  }
  return null;
}

/**
 * The approved hosted test host from UPSITEHEALTH_TEST_DB_HOST, validated:
 * a DNS name (never an IP address) with a top-level domain of letters.
 */
export function approvedTestHost(
  value: string | undefined,
  neonProduction: readonly string[] = NEON_PRODUCTION_ENDPOINTS,
): { host: string } | { error: string } | null {
  if (value === undefined || value.trim() === "") return null;
  const bare = `${TEST_DB_HOST_VAR} must be a bare DNS hostname (no scheme, port, path, wildcard or IP address)`;
  const info = classifyHost(value.trim());
  if ("error" in info || info.kind !== "dns") return { error: bare };
  const labels = info.host.split(".");
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels[labels.length - 1]))
    return { error: bare };
  if (info.local)
    return {
      error: `${TEST_DB_HOST_VAR} must be a hosted database, not this machine`,
    };
  if (isProductionUrl(info.host, neonProduction))
    return { error: `${TEST_DB_HOST_VAR} names a production host` };
  if (isSharedUrl(info.host))
    return {
      error: `${TEST_DB_HOST_VAR} names the shared manual-testing database (NEON_SHARED_ENDPOINTS), which is never a test target`,
    };
  if (isPooledHost(info.host))
    return {
      error: `${TEST_DB_HOST_VAR} names a pooled endpoint; use the direct host`,
    };
  return { host: info.host };
}

/**
 * Why a hosted target is not the approved test database (null when it is):
 * exact host match, direct endpoint, sslmode=require (as the driver reads
 * it), nothing that routes the connection elsewhere, and for Neon a
 * recognisable endpoint that is not a recorded production endpoint.
 */
export function hostedTestTargetProblem(
  target: DbTarget,
  approvedValue: string | undefined,
  neonProduction: readonly string[] = NEON_PRODUCTION_ENDPOINTS,
  neonTest: readonly string[] = NEON_TEST_ENDPOINTS,
): string | null {
  const approved = approvedTestHost(approvedValue, neonProduction);
  if (!approved)
    return `it is a hosted database and ${TEST_DB_HOST_VAR} does not approve one`;
  if ("error" in approved) return approved.error;
  if (target.kind !== "dns" || target.host !== approved.host)
    return `its host is not the approved test host (${TEST_DB_HOST_VAR})`;
  if (isPooledHost(target.host) || target.params.has("pgbouncer"))
    return "it uses a pooled endpoint; use the direct host";
  if (target.params.get("sslmode") !== "require")
    return "it must set sslmode=require";
  // In pg 8, uselibpqcompat=true turns require into "no certificate check".
  if (target.params.has("uselibpqcompat"))
    return "uselibpqcompat weakens sslmode=require; remove it";
  // Neon's proxy can take the endpoint from `options=endpoint=…` or from the
  // password instead of the hostname: the host would not say where it goes.
  if (target.params.has("options"))
    return "the options parameter can route the connection or change its settings; remove it";
  if (target.database !== HOSTED_TEST_DATABASE)
    return `a hosted test database must be named "${HOSTED_TEST_DATABASE}", not "${target.database || "(none)"}"`;
  if (target.routingInCredentials)
    return "the user name or password carries routing options (endpoint= or project=); remove them";
  if (isNeonHost(target.host)) {
    const endpoint = neonEndpointId(target.host);
    if (!endpoint)
      return "it is a Neon host without a recognisable endpoint ID (ep-…)";
    const problem = neonProductionProblem(neonProduction);
    if (problem) return problem;
    if (neonProduction.includes(endpoint))
      return "it is a Neon production endpoint";
    if (NEON_SHARED_ENDPOINTS.includes(endpoint))
      return "it is the shared manual-testing database (NEON_SHARED_ENDPOINTS), which is never a test target";
    const listProblem = neonTestListProblem(neonTest, neonProduction);
    if (listProblem) return listProblem;
    if (!neonTest.includes(endpoint))
      return "its Neon endpoint is not on the integration-test allowlist (NEON_TEST_ENDPOINTS)";
  }
  return null;
}

// ─── Prisma CLI ──────────────────────────────────────────────────────────────

type FlagSpec = Record<string, "boolean" | "string" | `-${string}`>;
/**
 * The flags Prisma's CLI (node_modules/prisma/build/cli.js) reads before the
 * command (ROOT) and before a migrate/db subcommand (GROUP). Both use `arg`
 * with stopAtPositional, so the first non-flag token is the (sub)command and
 * unknown flags are an error.
 */
const ROOT_FLAGS: FlagSpec = {
  "--help": "boolean",
  "-h": "--help",
  "--version": "boolean",
  "-v": "--version",
  "--config": "string",
  "--json": "boolean",
  "--experimental": "boolean",
  "--preview-feature": "boolean",
  "--early-access": "boolean",
  "--telemetry-information": "string",
};
const GROUP_FLAGS: FlagSpec = {
  "--help": "boolean",
  "-h": "--help",
  "--config": "string",
  "--preview-feature": "boolean",
  "--telemetry-information": "string",
};
const WRITE_SUBCOMMANDS: Record<string, string[]> = {
  migrate: ["dev", "reset", "deploy", "resolve"],
  db: ["push", "execute", "seed"],
};

/**
 * The positional tails `arg` could produce for `tokens`: flags are skipped
 * (with the value of a string flag), `--` makes the rest positional. An
 * unknown flag (Prisma refuses those) is read both as a switch and as taking
 * a value, so no possible reading is missed.
 */
function positionalTails(
  tokens: string[],
  spec: FlagSpec,
  depth = 0,
): string[][] {
  // Many unknown flags: any suffix could be the tail (a superset, so safe).
  if (depth > 8) return tokens.map((_, k) => tokens.slice(k));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") return [tokens.slice(i + 1)];
    if (!(t.length > 1 && t.startsWith("-"))) return [tokens.slice(i)];
    const parts =
      t.startsWith("--") || t.length === 2
        ? [t]
        : t
            .slice(1)
            .split("")
            .map((c) => `-${c}`);
    for (const [n, part] of parts.entries()) {
      const eq = part.startsWith("--") ? part.indexOf("=") : -1;
      let name = eq >= 0 ? part.slice(0, eq) : part;
      while (spec[name]?.startsWith("-")) name = spec[name];
      const type = spec[name];
      const rest = tokens.slice(i + 1);
      if (type === undefined) {
        const asSwitch = positionalTails(rest, spec, depth + 1);
        return eq >= 0
          ? asSwitch
          : [...asSwitch, ...positionalTails(rest.slice(1), spec, depth + 1)];
      }
      if (type === "string" && eq < 0 && n === parts.length - 1) i++;
    }
  }
  return [[]];
}

/**
 * The schema- or data-writing command an invocation runs ("migrate reset",
 * "db push", ...), or null. Every reading of the flags is considered, so a
 * flag between the command and its subcommand cannot hide it, while flag
 * values (`--telemetry-information reset`) are not mistaken for commands.
 */
export function schemaWriteCommand(args: string[]): string | null {
  for (const root of positionalTails(args, ROOT_FLAGS)) {
    const writes = WRITE_SUBCOMMANDS[root[0]];
    if (!writes) continue;
    for (const sub of positionalTails(root.slice(1), GROUP_FLAGS))
      if (writes.includes(sub[0])) return `${root[0]} ${sub[0]}`;
  }
  return null;
}

export type SchemaWriteDecision =
  { allow: true } | { allow: false; reason: string };

/**
 * Why a schema-writing command may not run against `url` (null if it may).
 * Order matters: an unusable URL and the development server are refused
 * before the production override is considered.
 */
function writeTargetProblem(
  url: string | undefined,
  env: Record<string, string | undefined>,
  options: Required<SchemaWriteOptions>,
): string | null {
  if (!url?.trim()) return "no database URL is configured";
  const target = parseDbTarget(url);
  if ("error" in target)
    return `the database URL is unusable (${target.error})`;
  // The development instance holds the only copy of local work: never
  // migrate, reset, push or seed it, whatever the database name or override.
  if (target.local && target.port === DEV_DB_PORT)
    return `the target is the local development database server (port ${DEV_DB_PORT}); use a separate local instance or the approved test database`;
  // Shared manual-testing data: never a test schema target, no override.
  if (isSharedUrl(url))
    return "the target is the shared manual-testing database (NEON_SHARED_ENDPOINTS); test schema setup never runs there";
  if (isProductionUrl(url, options.neonProductionEndpoints))
    return env.ALLOW_PRODUCTION_SCHEMA_CHANGES === "yes"
      ? null
      : "the target is the production database (see recovery/RECOVERY.md)";
  if (target.local) return null;
  if (env[TEST_DB_FLAG] !== "yes")
    return `the target is a hosted database; only the approved test database is allowed, with ${TEST_DB_FLAG}=yes`;
  const problem =
    hostedTestTargetProblem(
      target,
      env[TEST_DB_HOST_VAR],
      options.neonProductionEndpoints,
      options.neonTestEndpoints,
    ) ?? appServerClash(target, options.appUrls);
  return problem
    ? `the target is not the approved test database: ${problem}`
    : null;
}

export type SchemaWriteOptions = {
  /**
   * Database URLs recorded in the repository's .env files (commented-out
   * lines included): a hosted test target must not share a server with any.
   */
  appUrls?: string[];
  /** Defaults to NEON_PRODUCTION_ENDPOINTS; tests pass their own. */
  neonProductionEndpoints?: readonly string[];
  /** Defaults to NEON_TEST_ENDPOINTS; tests pass their own. */
  neonTestEndpoints?: readonly string[];
};

/**
 * Whether a Prisma CLI invocation may run. Read-only commands (including
 * Studio, which can edit rows but not the schema) are never blocked.
 * Schema-writing commands may run against a local database other than the
 * development instance (port 51214, always refused), against production
 * only with ALLOW_PRODUCTION_SCHEMA_CHANGES=yes, and against a hosted
 * database only when it is the approved test database
 * (UPSITEHEALTH_ISOLATED_TEST_DB=yes and UPSITEHEALTH_TEST_DB_HOST), not a
 * Neon production endpoint, for Neon on the integration-test allowlist
 * (NEON_TEST_ENDPOINTS), and not on the server of any URL in .env. The
 * shared manual-testing endpoint (NEON_SHARED_ENDPOINTS) is refused for
 * every write, with no override.
 *
 * `url` is the config's datasource (DIRECT_URL, else DATABASE_URL). The
 * seed command runs as a child process with this environment, and app code
 * connects with DATABASE_URL, so `db seed` also requires DATABASE_URL and
 * DIRECT_URL to pass.
 */
export function schemaWriteDecision(
  args: string[],
  env: Record<string, string | undefined>,
  url: string,
  {
    appUrls = [],
    neonProductionEndpoints = NEON_PRODUCTION_ENDPOINTS,
    neonTestEndpoints = NEON_TEST_ENDPOINTS,
  }: SchemaWriteOptions = {},
): SchemaWriteDecision {
  const command = schemaWriteCommand(args);
  if (!command) return { allow: true };
  const refuse = (reason: string): SchemaWriteDecision => ({
    allow: false,
    reason: `Refusing "prisma ${command}": ${reason}.`,
  });
  // Prisma 7 reads the target from this config only; a URL flag would
  // bypass the checks below.
  if (args.some((a) => a === "--url" || a.startsWith("--url=")))
    return refuse("--url is not supported here; set DIRECT_URL instead");
  const targets: Array<[string, string | undefined]> = [
    ["the datasource URL", url],
  ];
  if (command === "db seed")
    for (const name of ["DATABASE_URL", "DIRECT_URL"])
      if (env[name] !== undefined) targets.push([name, env[name]]);
  for (const [label, target] of targets) {
    const problem = writeTargetProblem(target, env, {
      appUrls,
      neonProductionEndpoints,
      neonTestEndpoints,
    });
    if (problem)
      return refuse(targets.length > 1 ? `${label}: ${problem}` : problem);
  }
  return { allow: true };
}

// ─── Prisma Studio and safe target labels ────────────────────────────────────

/**
 * A description of a database target that is safe to print: the kind of
 * server (Neon endpoint, local port, or host and port), whether it is
 * pooled, and the database name. Never the user name, password or query
 * values.
 */
export function safeTargetLabel(raw: string | undefined): string {
  if (!raw?.trim()) return "no database URL";
  const t = parseDbTarget(raw);
  if ("error" in t) return "an unusable database URL";
  const db = `database ${t.database || "(default)"}`;
  if (t.local) return `this machine, port ${t.port}, ${db}`;
  const endpoint = neonEndpointId(t.host);
  if (endpoint)
    return `Neon endpoint ${endpoint} (${isPooledHost(t.host) ? "pooled" : "direct"}), ${db}`;
  return `host ${t.host}, port ${t.port}, ${db}`;
}

/**
 * Whether an invocation opens Prisma Studio, with flags read as Prisma's CLI
 * reads them before the command (so `prisma --preview-feature studio` is
 * Studio, while a flag value that happens to be "studio" is not).
 */
export function isStudioCommand(args: string[]): boolean {
  return positionalTails(args, ROOT_FLAGS).some((tail) => tail[0] === "studio");
}

/** The `--url` values on a command line (`--url x` or `--url=x`). */
function urlFlagValues(args: string[]): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] === "--url") out.push(args[i + 1]);
    else if (args[i].startsWith("--url=")) out.push(args[i].slice(6));
  }
  return out;
}

/**
 * The Prisma CLI decision for prisma.config.ts: Studio first, then schema
 * writes (schemaWriteDecision).
 *
 * Studio can edit and delete rows, so it is refused against the shared
 * manual-testing database (NEON_SHARED_ENDPOINTS), with no override. Its
 * `--url` flag overrides the config's datasource, so every `--url` value is
 * checked too, and one that cannot be read is refused. Studio against any
 * other target is unchanged (including production; see
 * docs/operations/testing.md). Refusals name the target only by
 * safeTargetLabel, never by URL.
 */
export function prismaCliDecision(
  args: string[],
  env: Record<string, string | undefined>,
  url: string,
  options: SchemaWriteOptions = {},
): SchemaWriteDecision {
  if (isStudioCommand(args)) {
    for (const target of [url, ...urlFlagValues(args)]) {
      if (
        target === undefined ||
        (target !== url && "error" in parseDbTarget(target))
      )
        return {
          allow: false,
          reason:
            'Refusing "prisma studio": its --url value is missing or unusable.',
        };
      if (isSharedUrl(target))
        return {
          allow: false,
          reason: `Refusing "prisma studio": the target is the shared manual-testing database (${safeTargetLabel(target)}), whose rows Studio could change. Use the app, or a read-only role, to inspect it.`,
        };
    }
  }
  return schemaWriteDecision(args, env, url, options);
}
