# Database backup and restore check

Status: **implemented, never run** (2026-11-02). Each backup and each
restore check needs its own approval. Production is not covered yet (its
identity is unresolved: `docs/operations/environment-readiness.md`).

| Tool                       | Code                                                                | Touches                                                         |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run db:backup`        | `scripts/db-backup.ts`, `scripts/db-backup/run.ts`                  | the shared manual-testing database, **read-only**; a new folder |
| `npm run db:restore-check` | `scripts/db-restore-check.ts`, `scripts/db-backup/restore-check.ts` | a backup folder (read); a **new** database on a local server    |

Shared code: `scripts/db-backup/common.ts`. Tests (offline, fakes only):
`tests/db-backup.test.ts`.

## 1. What is backed up

Only the `app` target: `DATABASE_URL` in `.env`, and only when it is the
shared manual-testing database (Neon branch `integration-tests`, endpoint
`ep-dark-rain-b4ve04n3`, `NEON_SHARED_ENDPOINTS`). The existing app rules
choose it (`chooseWorkerDatabase("app")`); they refuse production, Supabase,
`itest-ci` and anything else, and the backup also refuses a local database.

## 2. Owner sequence for the first backup

Run the steps in this order. **Local** steps touch only this Mac (and, from
step 4, the local PostgreSQL server); they need no database approval.
**Approval** steps read the shared Neon database or create a restored copy
and each need explicit approval first.

Every local PostgreSQL command below runs in a clean environment
(`env -i …`) so that `PGHOST`, `PGPORT`, `PGSERVICE` or similar variables
in the shell cannot point it anywhere else, and names `127.0.0.1` and port
5432 explicitly.

```bash
B=/Applications/Postgres.app/Contents/Versions/18/bin
LOCALPG=(env -i HOME="$HOME" PATH=/usr/bin:/bin)
```

| #   | Step                                  | Kind                                    |
| --- | ------------------------------------- | --------------------------------------- |
| 1   | FileVault on                          | Local                                   |
| 2   | Postgres.app 18 installed and started | Local                                   |
| 3   | Encrypted backup storage              | Local                                   |
| 4   | Restricted restore role               | Local (writes to the local server only) |
| 5   | Local server and role verified        | Local (read-only, local server)         |
| 6   | App and crawl worker stopped          | Local                                   |
| 7   | First backup                          | **Approval** (reads Neon, read-only)    |
| 8   | Manifest and checksums verified       | Local (files only)                      |
| 9   | Restore check                         | **Approval** (creates a local database) |
| 10  | Disposable restore database removed   | Local (after reviewing step 9)          |

### Step 1: FileVault (local)

System Settings → Privacy & Security → FileVault → Turn On; keep the
recovery key somewhere other than this Mac. Wait until encryption has
finished (`fdesetup status` says "FileVault is On."). It must come first:
step 9 writes a full copy of the data into Postgres.app's data folder
(`~/Library/Application Support/Postgres/`), and the backup's temporary
password file lives in the user's temporary folder; neither is inside the
encrypted image.

### Step 2: Postgres.app 18 (local)

Download Postgres.app with PostgreSQL 18 from
[postgresapp.com](https://postgresapp.com), drag it to `/Applications`,
open it, and initialise and start a PostgreSQL 18 server on port 5432. If
Postgres.app asks whether to allow a client (Terminal, node) to connect,
allow it. Then check what the backup's trust rules will see (section 5);
every line must be owned by you or root and show no `w` in the group or
other positions, and the two tools must be regular files (`-r…`, not
`l…`):

```bash
for p in /Applications/Postgres.app /Applications/Postgres.app/Contents \
  /Applications/Postgres.app/Contents/Versions \
  /Applications/Postgres.app/Contents/Versions/18 "$B" "$B/pg_dump" "$B/pg_restore"; do
  stat -f '%Sp %Su %N' "$p"; done
"$B/pg_dump" --version; "$B/pg_restore" --version   # both 18.x, identical
```

### Step 3: Encrypted backup storage (local)

```bash
hdiutil create -size 20g -type SPARSEBUNDLE -fs APFS -encryption AES-256 \
  -volname UpSiteHealthBackups ~/UpSiteHealth-backups/vault.sparsebundle
hdiutil attach ~/UpSiteHealth-backups/vault.sparsebundle
mkdir /Volumes/UpSiteHealthBackups/integration-tests
```

- `hdiutil create` asks for a passphrase twice. Store it in a password
  manager: **without it the backups cannot be read.** `hdiutil` does not
  put it in the Keychain; opening the image from Finder offers "Remember
  password in my keychain".
- **`-size` is a maximum, not an allocation.** A new sparse bundle uses a
  few megabytes and grows in 8 MB bands as files are added, up to the
  maximum. It does not shrink by itself after deletions
  (`hdiutil compact <image>` while detached reclaims space). The maximum can
  be raised later: `hdiutil resize -size 40g <image>` (detached).
- **Capacity (see "Sizing" below):** 20 GB leaves very large headroom for
  today's data; raise it if the sizing rule says so.

#### Sizing

A custom-format dump holds table data (compressed) and definitions, not
indexes, so it is smaller than the database's size on disk. Upper bound:

```
needed ≈ (backups kept) × (database size) × 2 (headroom)
```

- **Backups kept:** 8 weekly + up to 4 pre-migration + 1 in progress = 13.
- **Database size:** `pg_database_size(current_database())` on the shared
  database. That is a read on Neon, so it is not run here; ask for it with
  the next approved read-only check, or read it from the Neon console
  (branch `integration-tests`, Storage).
- **Evidence today:** the shared database holds about 1 organisation, 3
  websites, 13 crawl runs, 10 tasks and 59 business facts (31 October); a
  comparable local database (1,394 rows) produced a 72 KB compressed dump
  on 22 October. Even if crawl pages reach tens of MB uncompressed, each
  dump is a few MB, so 13 × a few MB × 2 is well under 1 GB.
- After the first backup, use the real figure: `manifest.json` →
  `dump.bytes`. Re-check when the shared database grows (for example after
  large crawls).

### Step 4: Restricted restore role (local)

The backup tools never create, alter or grant roles. Create the role as
Postgres.app's default superuser (your macOS user), on the local server
only:

```bash
"${LOCALPG[@]}" "$B/createuser" -h 127.0.0.1 -p 5432 \
  --no-superuser --createdb --no-createrole --no-replication --no-bypassrls \
  upsitehealth_restore
```

It needs `CREATEDB` and nothing more, and no password (Postgres.app trusts
local connections). Do not add it to any role (`-g`) or grant it anything.

### Step 5: Verify the local server and the role (local, read-only)

Connected **as the restore role**, the same checks the restore check makes:

```bash
"${LOCALPG[@]}" "$B/psql" -h 127.0.0.1 -p 5432 -U upsitehealth_restore -d postgres -X -At -c "
SELECT host(inet_server_addr()) AS addr,
  current_setting('neon.endpoint_id', true) IS NULL AS not_neon,
  current_setting('server_version') AS version,
  current_user AS role, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
  r.rolreplication, r.rolbypassrls,
  pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') AS exec_program,
  pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') AS read_files,
  pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') AS write_files
FROM pg_roles r WHERE r.rolname = current_user"
```

Expected: `127.0.0.1|t|18.x|upsitehealth_restore|f|t|f|f|f|f|f|f`.

### Step 6: Stop the app and the crawl worker (local)

Stop `npm run dev`, `npm run dev:with-crawls` and `npm run dev:crawls`
(Ctrl-C in their terminals), then confirm nothing is left:

```bash
pgrep -fl 'next dev|next-server|dev-with-crawls|dev-crawl-worker|crawl-worker' || echo "nothing running"
```

Anything else that writes to the shared database (another machine, a
deployment pointed at it) must be stopped too; the backup aborts if any
row changes during the run.

### Step 7: The first backup (**approval**)

```bash
hdiutil attach ~/UpSiteHealth-backups/vault.sparsebundle   # if not attached
npm run db:backup -- --target=app \
  --out-dir="/Volumes/UpSiteHealthBackups/integration-tests/$(date -u +%Y-%m-%dT%H-%MZ)"
```

Exit 0 and "Backup written and verified" are required; anything else
leaves `FAILED.txt` (section 3).

### Step 8: Verify the manifest and checksums (local, files only)

```bash
cd "/Volumes/UpSiteHealthBackups/integration-tests/<folder>"
ls -l                         # integration-tests.dump, manifest.json, SHA256SUMS; all -rw-------; no FAILED.txt
shasum -a 256 -c SHA256SUMS   # both OK
grep -E '"(endpoint|branch|database|serverVersion|bytes)"' manifest.json
"${LOCALPG[@]}" "$B/pg_restore" --list integration-tests.dump | head -12   # Format: CUSTOM, versions 18.x
cd ~
```

### Step 9: The restore check (**approval**)

```bash
npm run db:restore-check -- \
  --backup-dir="/Volumes/UpSiteHealthBackups/integration-tests/<folder>" \
  --restore-db=upsitehealth_restore_$(date -u +%Y%m%d) \
  --role=upsitehealth_restore
```

"Restore check passed" with every count and fingerprint identical is
required.

### Step 10: Remove the disposable database (local)

After reviewing step 9, as the restore role (which owns it):

```bash
"${LOCALPG[@]}" "$B/dropdb" -h 127.0.0.1 -p 5432 -U upsitehealth_restore \
  upsitehealth_restore_<yyyymmdd>
hdiutil detach /Volumes/UpSiteHealthBackups
```

Keep the role for later restore checks; it owns nothing once the database
is gone.

## 3. Taking a backup

```bash
hdiutil attach ~/UpSiteHealth-backups/vault.sparsebundle
npm run db:backup -- --target=app \
  --out-dir="/Volumes/UpSiteHealthBackups/integration-tests/$(date -u +%Y-%m-%dT%H-%MZ)"
hdiutil detach /Volumes/UpSiteHealthBackups   # after the restore check
```

What it does, in order (any problem stops it; exit 0 only when all pass):

1. **Offline:** the folder must not exist (its parent must). `pg_dump` and
   `pg_restore` must come from a trusted installation (below), report
   version 18 or newer (for Postgres.app, the version its folder names),
   and report the same version as each other.
2. **Target:** `.env` by the app rules, then only the shared Neon endpoint.
   The URL may carry only `sslmode` and `channel_binding`.
3. **Read-only proof:** on a session started with
   `default_transaction_read_only=on`, in one `READ ONLY` transaction that
   is always rolled back: the server's endpoint and database
   (`proveTarget`), the session default, then every table's row count and
   data fingerprint, and a SHA-256 of the schema definitions
   (`collectDefinitions`).
4. **The dump:** creates the folder (0700), then runs
   `pg_dump --format=custom --compress=gzip:9 --no-password --lock-wait-timeout=10s --file=<folder>/integration-tests.dump`.
   Host, port, database and user reach `pg_dump` as `PG*` variables in its
   own environment; the **password only through a temporary password
   file** (`PGPASSFILE`): one line in a 0600 file inside a new 0700 folder
   from `mkdtemp`, created just before `pg_dump` and removed in a `finally`
   block (a removal failure fails the backup and names the file, never its
   contents). Its sessions are read-only (`PGOPTIONS`), TLS is
   `verify-full` against the system's root certificates, and service files
   are disabled. Time limit 30 minutes (then SIGTERM, then SIGKILL).
5. **The same proof again:** counts, fingerprints and the definitions digest
   must be identical to step 3.
6. **The dump's contents:** `pg_restore --list` (local, no database) must
   show a custom-format archive with data for exactly the tables counted.
7. **Files:** `manifest.json` (identity, versions, every table's count and
   fingerprint, the dump's size and SHA-256) and `SHA256SUMS`, each 0600,
   written atomically and never over an existing file.

**On failure** after the folder exists, it holds `FAILED.txt` with the
reason and **no** manifest, so the restore check refuses it. Nothing is
deleted automatically; remove the folder by hand after reading the reason.

## 4. Checking a backup can be restored

```bash
npm run db:restore-check -- \
  --backup-dir="/Volumes/UpSiteHealthBackups/integration-tests/<folder>" \
  --restore-db=upsitehealth_restore_<yyyymmdd> \
  --role=upsitehealth_restore
```

1. **The backup, offline:** `SHA256SUMS` must list exactly the dump and the
   manifest, both regular files matching their checksums; the manifest's
   dump checksum must agree; `pg_restore --list` must match the manifest's
   tables; `pg_restore` must be at least the backup's server version.
2. **The local server and the role:** `127.0.0.1` (`--port`, default
   5432), the `--role`, no password, no TLS. There is no host option. A
   read-only check requires a loopback address, no Neon endpoint, and the
   role restrictions of section 2 (step 4) before anything is created; a
   role with more rights is refused, never reduced or used.
3. **A new database**, created and owned by that role:
   `CREATE DATABASE "upsitehealth_restore_…" TEMPLATE template0`. If it
   exists, the check stops; it is never reused or dropped.
4. **Restore** as that role:
   `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`
   (Neon's roles do not exist locally; owners and privileges are left out
   on restore only, the dump keeps them). Because the role is not a
   superuser and has no server-file or server-program rights, the dump's
   SQL cannot run programs or read or write files on this machine. Objects
   it may not create (for example an untrusted extension) fail the restore;
   that is reported as a limitation of the restricted role, not retried
   with more rights.
5. **Compare:** the role is checked again, then every table's row count
   and fingerprint in the restored database must equal the manifest.

The restored database is **left in place**; remove it by hand when done:
`dropdb -h 127.0.0.1 -p 5432 upsitehealth_restore_<yyyymmdd>`.

## 5. Trusted PostgreSQL tools

`--pg-bin` (default `/Applications/Postgres.app/Contents/Versions/18/bin`)
must resolve (`realpath`) to the bin folder of one of:

- Postgres.app: `/Applications/Postgres.app/Contents/Versions/<N>/bin`;
- Homebrew: `/opt/homebrew/Cellar/libpq/<version>/bin` or
  `/opt/homebrew/Cellar/postgresql@<N>/<version>/bin` (so
  `/opt/homebrew/opt/libpq/bin` is accepted through its real path).

Every folder from the installation's root (`/Applications/Postgres.app`,
`/opt/homebrew/Cellar/<formula>`) down to `bin`, and the tool itself, must
be owned by root or the current user and not writable by group or others;
the tool must be a regular executable file there, not a link. Anything else
is refused before any tool runs. Only `--version` runs before a tool is
used, and never with credentials. Code signatures are not checked.

## 6. The data fingerprint

Per table: `count(*)` and `md5` of every row's `row_to_json` text, joined in
`COLLATE "C"` order, with `TimeZone`, `DateStyle`, `IntervalStyle`,
`extra_float_digits` and `bytea_output` fixed in the transaction, so the
same rows give the same fingerprint on Neon and on a local server. Tables:
every ordinary and partitioned table outside the system schemas, except
extension members (which `pg_dump` does not dump).

## 7. Recovering from a backup (not automated)

Never restore over a live database. Restore into a **new** Neon branch or
database (owner-created, separately approved), verify it with the same
comparison, then point the app at it in a reviewed change. The restore
check's local copy is the rehearsal of that step.

## 8. Routine (proposed)

- Before every migration on the shared database, and weekly.
- A restore check for every backup that will be relied on, and at least
  monthly.
- Keep the last 8 weekly backups and every pre-migration backup.
- Optionally copy the encrypted disk image to an external drive.
- Not yet: scheduling, production, GitHub Actions (credentials would go in
  repository secrets only, and dumps would be encrypted to a public key
  before upload).

## 9. Limits

- **Consistency:** `pg_dump` takes its own snapshot; the before/after
  comparison proves nothing changed during the run, so the dump holds the
  counted state. A change made and undone between the two proofs would not
  be seen.
- **Credentials:** the app's own role from `.env`, which owns the tables and
  bypasses row-level security (needed to dump `business_facts`,
  `recommendation_events` and `recommendation_evidence` in full; with
  `row_security=off`, `pg_dump` fails rather than skipping rows). A
  dedicated read-only role with `BYPASSRLS` would be narrower; creating it
  is a database write and needs its own approval.
- **TLS:** `verify-full` with `sslrootcert=system` needs libpq 16 or newer
  (Postgres.app 18 qualifies). If the system roots cannot be found, the run
  fails before dumping; it never falls back to an unverified connection.
- **The password file** exists for the duration of `pg_dump` in a private
  folder under the system temporary directory. A crash or power loss in
  that window can leave it behind (`upsitehealth-pgpass-*`); macOS clears
  the temporary directory on restart.
- **Tool trust** rests on location, ownership and permissions, checked just
  before use; code signatures are not verified, and a process running as
  this user could still replace a tool between the check and its use.
- **The restricted role** still runs the dump's SQL inside its own new
  database (it can create functions in trusted languages, for example);
  it cannot reach programs or files on this machine or other databases'
  objects it was not granted.
- **Owners and privileges** are not restored by the check; the
  comparison covers rows, not grants.
- **Large tables:** fingerprints read every row (seconds at today's size).
