# Spec: Google Search Console, GA4 and Tag Manager connections

Status: **proposed, not implemented.** Needs a reviewed schema migration, a
Google Cloud OAuth client, and approval before any code is written.

## Goal

Move integrations from **Detected** (public page source) to **Verified**
(confirmed through Google's APIs with the site owner's consent), and later
feed first-party search and analytics data into reports.

## Scopes (read-only only)

| Product        | Scope                                                 | Used for                                                                         |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Search Console | `https://www.googleapis.com/auth/webmasters.readonly` | List properties, sitemap status, search analytics, URL inspection                |
| GA4            | `https://www.googleapis.com/auth/analytics.readonly`  | List accounts/properties/data streams; confirm a stream receives data (Data API) |
| Tag Manager    | `https://www.googleapis.com/auth/tagmanager.readonly` | Containers, published version, tags in the live version                          |

Plus `openid email` to record which Google account connected. Request each
product's scope only when the user connects that product (incremental
authorization). Never request write scopes.

## Flow

1. A MANAGER or above clicks **Connect** on the website's Integrations page.
2. The server creates a random `state` and a PKCE verifier, stores them in
   a short-lived, HttpOnly, SameSite=Lax cookie bound to the user, org and
   website, and redirects to Google with `access_type=offline` and
   `prompt=consent` (needed to receive a refresh token).
3. Callback route: validate `state` (constant-time compare), verifier,
   session, org membership and role; exchange the code server-side; verify
   the ID token's audience and issuer.
4. The user picks the property / data stream / container that matches this
   website. A suggested match is offered (same domain); never chosen silently.
5. Store the connection (below) and run a first verification.

No credential is ever typed or pasted by the user.

## Storage (requires a migration)

New table `integration_connections`, **not** the existing `accounts` table
(which holds login-provider tokens in plain text per user):

- `organizationId`, `websiteId`, `provider` (GSC | GA4 | GTM), `connectedById`
- `googleAccountEmail`, `scopes`, `resourceId` (property / stream / container)
- `refreshTokenCiphertext`, `refreshTokenIv`, `refreshTokenTag`, `keyVersion`
- `status` (CONNECTED | NEEDS_RECONNECT | INSUFFICIENT_PERMISSION | REVOKED | ERROR),
  `lastError` (code only), `lastVerifiedAt`, timestamps
- Unique on (`websiteId`, `provider`); tenant-scoped like every other model.

Access tokens are kept in memory only, never stored. The refresh token is
encrypted with AES-256-GCM (Node `crypto`, so no new dependency) using
`TOKEN_ENCRYPTION_KEY` (32 random bytes, server-only env). `keyVersion`
allows rotation.

## Security rules

- Tokens never reach the browser, logs, error messages, exports or Sentry-like
  tools; the structured logger's redaction gets the new field names.
- All Google API calls go to fixed Google hosts with timeouts; responses are
  size-limited.
- Disconnect: revoke at `https://oauth2.googleapis.com/revoke`, then delete
  the ciphertext (even if revocation fails) and record REVOKED.
- `invalid_grant` on refresh → NEEDS_RECONNECT, shown on the page with a
  Reconnect button; do not retry in a loop.
- 403 / missing property access → INSUFFICIENT_PERMISSION, with the account
  email shown so the user can see which account lacks access.
- Deleting a website or organization deletes its connections (cascade).
- Only MANAGER+ can connect or disconnect; CLIENT users see status only.

## Verification semantics

- GSC **Verified**: the connected account has a property covering this site
  (Domain property, or URL-prefix property matching the site URL) with
  `siteOwner`/`siteFullUser`/`siteRestrictedUser` permission.
- GA4 **Verified**: a web data stream whose default URL matches the site,
  and the Data API reports page views for it in the last 48 hours. A stream
  with no recent data is **Needs attention**, not verified.
- GTM **Verified**: the container on the site is the one connected, its live
  version is published, and it contains a Google tag for the GA4 stream.

## Google Cloud setup checklist (done by the account owner)

1. Create (or choose) a Google Cloud project for UpSiteHealth.
2. Enable: Google Search Console API, Google Analytics Admin API, Google
   Analytics Data API, Tag Manager API.
3. OAuth consent screen: External; app name, support email, logo, privacy
   policy URL, terms URL, authorized domain (the app's domain).
4. Add only the three read-only scopes above.
5. Create an **OAuth client ID** (Web application). Authorized redirect URI:
   `https://<app domain>/api/integrations/google/callback` (plus
   `http://localhost:3000/...` for development, in a separate client).
6. Store the client ID and secret as server environment variables
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) and generate
   `TOKEN_ENCRYPTION_KEY`. Never commit them.
7. While in **Testing** status, add test users (up to 100). Analytics and
   Search Console read scopes are **sensitive**: publishing to all users
   needs Google's app verification (a review of the privacy policy, a demo
   video and the scope justification), which can take several weeks.
8. Set quotas/alerts in Cloud Console for each API.

## Out of scope for the first version

Writing anything to Google, Bing Webmaster OAuth, scheduled data imports for
reports (designed separately once the connection exists).
