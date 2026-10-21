# Spec: per-client access for CLIENT users

Status: **documented only, not implemented.** Tenant isolation between
organizations is unchanged and unaffected.

## Current limitation

- Roles are organization-wide (`src/lib/tenancy/roles.ts`). A member with
  the CLIENT role is read-only, but can see **every client and website in
  the organization**: there is no table linking a member to a client.
- Reports, exports, issues, alerts, the overview and every website page
  are therefore visible to any CLIENT user in the organization.
- Until this is built, invite CLIENT users only to organizations that hold
  that client's websites alone, or do not invite client users.

## Proposed design

1. New table `member_client_access` (`id`, `organizationId`, `memberId` →
   `organization_members.id`, `clientId` → `clients.id`, `createdAt`,
   `createdById`), unique (`memberId`, `clientId`), composite foreign keys
   on `(…, organizationId)` like the engagement migration, RLS enabled.
2. Access rule, enforced in one place: `requireOrgContext` returns, for
   CLIENT members, the set of allowed client ids. The scoped database
   client gains a second filter for CLIENT members: website-owned models
   are restricted to `website.clientId IN (allowed)`. Other roles are
   unchanged.
3. Default for CLIENT members with no links: **see nothing** (deny by
   default), with an empty state explaining that access is granted per
   client. Existing CLIENT members need links created before the change
   ships, or they lose visibility; list them before rollout.
4. Organization-wide pages (overview, issues, alerts, reports, exports,
   notifications) filter through the same scoped client, so no page needs
   its own check.
5. Management: ADMIN+ grant and revoke access on the client page.

## Tests (when built)

- A CLIENT member linked to client A sees A's websites only, on every page
  and export; direct URLs to client B's websites return 404.
- Unlinked CLIENT members see no websites; MEMBER and above are unaffected.
- Links cannot point at another organization's client (database-level).
- Revoking access takes effect on the next request.

## Rollout

Separate migration and approval from the engagement workflow. Ship the
link management UI first, create links for existing CLIENT members, then
switch the access rule on.
