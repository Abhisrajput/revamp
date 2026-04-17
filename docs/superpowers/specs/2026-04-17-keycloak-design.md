# Keycloak Identity Platform — Design

**Date:** 2026-04-17
**Status:** Draft — awaiting user review
**Spec self-review:** completed inline. No placeholders, no contradictions, single-plan scope confirmed.
**Scope:** Replace REVAMP's custom JWT + bcrypt + OTP auth with Keycloak as the sole identity provider, across two deployment targets (customer self-hosted docker-compose bundles and Tavant-hosted AWS).

---

## Problem Statement

REVAMP currently ships a custom authentication stack: Fastify JWT plugin (213 lines), auth routes (780 lines) implementing signup / login / password reset / OTP / refresh. Four realm-level roles (`admin`, `architect`, `developer`, `sme`). Works, but has three structural problems that block enterprise distribution:

1. **No federation.** Every serious B2B customer demands SSO with Azure AD, Okta, Google Workspace, or SAML on Day 1. The current stack has no way to delegate authentication to an external IdP. Without it, customers cannot mass-onboard users and compliance reviews fail.
2. **User management burden on the REVAMP app.** Password reset, MFA enrollment, account disable, session invalidation, token rotation — all custom code we own. An identity-provider-shaped problem being solved by bespoke code.
3. **Distribution inconsistency.** Customers deploy their own instance from a REVAMP bundle; Tavant also hosts at `lamp.tavant.com`. Both deployments need the same auth story. Shipping a custom auth stack to every customer means every customer install inherits the same gap and the same upgrade costs.

This design replaces the custom stack with Keycloak as the identity provider, shipped as part of the deployment bundle. REVAMP becomes an OIDC client of its own Keycloak instance. Customer admins configure federated IdPs at install time via a setup wizard.

## Goals

- Every authenticated REVAMP user is a Keycloak user. No REVAMP-owned password storage.
- Customers can federate Azure AD, Okta, Google Workspace, generic SAML 2.0, and generic OIDC out of the box — configured via a setup wizard, not raw Keycloak admin UI.
- Same auth architecture for customer installs and Tavant AWS. Single realm per install.
- Existing user rows in REVAMP's Postgres survive migration; users get a "reset your password" flow on first login after upgrade.
- Tavant AWS runs at `lamp.tavant.com` with Keycloak at `auth.lamp.tavant.com`.
- MFA (TOTP + WebAuthn) available for any user; required for `admin` role in Tavant's realm; per-customer policy elsewhere.
- VS Code extension signs in via OAuth device code flow.

## Non-Goals

- Multi-tenant cloud REVAMP where one install serves many customers. Each install remains single-tenant.
- Reimplementing Keycloak's admin UI inside REVAMP. Deep identity ops happen in Keycloak's `/admin/console`.
- Migrating agent-worker → API internal auth off the existing shared-secret pattern. Separate project.
- Multi-region / HA Keycloak deployment. Single instance per install is sufficient for current scale.
- Keycloak theme customization beyond realm-level logo + display name.

---

## Architecture & Deployment Topology

**New containers added to the REVAMP stack:**

- `keycloak` — Keycloak 25 LTS, port 8080 internal.
- `keycloak-db` — dedicated PostgreSQL 16 instance. Isolated from REVAMP's `postgres` so that Keycloak upgrades do not entangle REVAMP schema migrations and vice versa.

**Deployment bundles:**

- **Customer install:** `infra/docker-compose.customer.yml` brings up the full stack (`keycloak`, `keycloak-db`, `revamp-api`, `revamp-web`, `postgres`, `redis`, `minio`, `agent-worker`). Keycloak data persisted to a named volume. Single-command bootstrap.
- **Tavant AWS:** Helm chart `infra/helm/revamp/` with a `keycloak` sub-chart. Keycloak's backing store is an RDS PostgreSQL instance. Keycloak is exposed as `https://auth.lamp.tavant.com` behind an ALB with its own TLS certificate; REVAMP web at `https://lamp.tavant.com`.

**Trust boundary.** REVAMP API and Web trust only Keycloak's signed JWTs (RS256). Keycloak's public keys are fetched from the realm JWKS endpoint and cached. There is no shared secret between REVAMP and Keycloak; compromising the REVAMP app does not grant the ability to issue tokens.

**Single realm per install.** Every install has exactly one Keycloak realm named `revamp`. Customer admins configure *federated* IdPs inside that realm so their enterprise users SSO into REVAMP via Azure AD / Okta / etc. The realm itself is not multi-tenant — one install, one customer, one realm.

**OIDC clients registered at realm bootstrap:**

- `revamp-web` — public client, Authorization Code + PKCE flow, redirect URIs matching the install's `<host>/auth/callback`.
- `revamp-vscode` — public client, device code flow enabled.

Fastify API has no Keycloak client registration — it validates tokens from the realm JWKS endpoint. Both Next.js and the VS Code extension obtain tokens as their respective clients, then present them to Fastify.

**Resource footprint.** Keycloak + its Postgres adds roughly 700 MB RAM baseline on top of REVAMP's existing stack. Document a 4 GB RAM minimum for customer installs (up from 2 GB before).

---

## Auth Flow

### Web login (OIDC Authorization Code + PKCE)

1. User hits a protected route on `lamp.tavant.com`. Next.js middleware checks the session cookie. If absent or expired, redirect to `/auth/login`.
2. `/auth/login` generates a PKCE code verifier + challenge, stores the verifier in a short-lived HTTP-only cookie, and redirects the browser to `auth.lamp.tavant.com/realms/revamp/protocol/openid-connect/auth` with `client_id=revamp-web`, the PKCE challenge, a CSRF state token, and `redirect_uri=https://lamp.tavant.com/auth/callback`.
3. Keycloak authenticates the user — native credentials first, or a federated IdP selected from the login page. On success, Keycloak redirects back to `/auth/callback?code=...&state=...`.
4. `/auth/callback` (server-side) exchanges the authorization code + PKCE verifier for `{access_token, id_token, refresh_token}` via the Keycloak token endpoint.
5. Next.js stores all three in a single encrypted, HTTP-only, `SameSite=Lax`, `Secure` session cookie using `iron-session`. Cookie domain: `lamp.tavant.com` (no subdomain wildcard).
6. Browser redirected to the originally-requested URL.

### API request flow

- Next.js server components and route handlers read the session cookie, extract the access token, and attach it as `Authorization: Bearer <token>` when calling Fastify.
- Fastify's auth plugin is rewritten: validate the JWT via RS256 against keys fetched from `<keycloak>/realms/revamp/protocol/openid-connect/certs`, check `iss`, check `aud` contains `revamp-web` or `revamp-vscode`, check `exp`. Claims populate `request.user` (`sub`, `email`, `realm_access.roles`, optional custom claims).

### Refresh

When `access_token` is ≤60 s from expiry, Next.js middleware calls Keycloak's token endpoint with the refresh token, writes a new cookie, and continues. Refresh is server-side only; refresh tokens never reach the browser.

### Logout

`/auth/logout` clears the session cookie, then redirects to Keycloak's end-session endpoint with `id_token_hint` + `post_logout_redirect_uri`. This kills the Keycloak side of the session; otherwise the user silently re-logs-in via the same federated session on next visit.

### VS Code extension (device code flow)

1. Extension command "Sign in to REVAMP" calls `<keycloak>/realms/revamp/protocol/openid-connect/auth/device` with `client_id=revamp-vscode`.
2. Keycloak returns a verification URL + user code. Extension displays both and opens the URL in the user's default browser.
3. User completes approval in the browser. Extension polls the token endpoint until it receives `{access_token, refresh_token}`.
4. Tokens stored in VS Code SecretStorage (per-user, per-machine, OS keychain). Every Fastify call sends the access token as a bearer.
5. On 401, extension silently refreshes using the refresh token. If refresh fails, prompts the user to re-sign-in.

### Error surfaces

- Session cookie tampering / expired tokens → redirect to login.
- Fastify JWKS fetch failure → 503 with retry-after; token validation continues from the last-known-good cache for up to one minute before rejecting requests.
- Federated IdP failure → Keycloak's own error page is shown. REVAMP does not attempt to re-render IdP errors.

---

## Federation & Setup Wizard

### The `/setup` route

On first boot, REVAMP API checks `revamp_settings.setup_complete`. If `false`, every route except `/setup/*` and static assets redirects to `/setup`. The wizard is served directly by Next.js and bypasses Keycloak auth entirely — it is protected instead by a one-time bootstrap token printed to the API container logs on first boot:

```
[SETUP] Bootstrap token: 4f7c2a1e-8... — paste into /setup to complete installation
```

The admin copies this from the logs and pastes it into the wizard's first screen.

### Wizard steps

**Step 1 — Realm admin.** Email + initial password. On submit, REVAMP's setup service calls Keycloak's admin REST API (using the initial `admin/admin` account Keycloak starts with) to: (a) create the `revamp` realm if missing, (b) create this user with the `realm-admin` role, (c) disable the built-in `admin/admin` account. From this point on, Keycloak's own `/admin/console` requires the new admin's credentials.

**Step 2 — Pick your IdP.** A dropdown with five options: Azure AD, Okta, Google Workspace, generic SAML 2.0, generic OIDC. Each option shows a tailored form asking only the fields that IdP needs. Behind the scenes, the wizard constructs an Identity Provider configuration payload and POSTs it via the Keycloak admin API. Preconfigured pieces (discovery URLs, default mappers) are filled in by the wizard; the customer supplies only what is unique to their tenant (e.g. Azure tenant ID, Okta domain, Google Workspace domain).

**Step 3 — Attribute mapping.** Pre-configured per IdP: email → username, first/last name, and a claims-based mapper that reads the IdP's group attribute → maps to Keycloak realm roles (`admin`, `architect`, `developer`, `sme`). The customer can override which group name maps to which role.

**Step 3b — MFA policy.** Radio selector: "Require MFA for all users" / "Require MFA for admins only" (default) / "MFA optional (users self-enroll)". Applied as Keycloak authentication-flow settings on the realm.

**Step 4 — Test connection.** Wizard opens a new window to Keycloak's federation login, prompts the customer to sign in via their IdP. On success, the wizard reads the resulting claims and shows `✅ Connected as <email>, groups: [...], mapped role: <role>`. On failure, the relevant Keycloak error log entry is surfaced in the wizard UI.

**Step 5 — Initial users.** Two paths: (a) skip (users self-provision on first federated login); (b) CSV upload with `email,first_name,last_name,role`. CSV path calls `POST /admin/realms/revamp/users` per row with `requiredActions=["UPDATE_PASSWORD"]` so these users hit the password-reset flow on first login.

**Step 6 — Finalize.** Set `revamp_settings.setup_complete = true`, destroy the bootstrap token, redirect admin to the normal `/auth/login`. Subsequent boots skip `/setup` entirely.

### Wizard persistence

Each step's state is stored server-side keyed by the bootstrap token hash. If the admin closes the tab mid-wizard, they can resume by re-entering the same token within 24 hours; after that, or after step 6 completes, the token is destroyed.

### Post-setup federation maintenance

Ongoing federation changes use Keycloak's native `/admin/console`. REVAMP's own admin dashboard links to it rather than reimplementing any of Keycloak's identity screens.

---

## Data Model & Migration

### Ownership split

**Keycloak is authoritative for:** user identity, credentials, MFA enrollment, federation mapping, the 4 realm roles, group membership, sessions.

**REVAMP Postgres keeps:** `project_members` (project-scoped roles), `audit_logs`, `stage_artifacts`, `pipeline_runs`, everything that is domain state rather than identity.

### Schema changes

**`users` table.**
- **Add** `keycloak_sub: uuid` — foreign key to the Keycloak user identifier. Indexed, unique, NOT NULL after the linkage migration completes.
- **Drop (later, delayed by one release):** `password_hash`, `otp_secret`, `otp_expires_at`, `email_verification_token`, `password_reset_token`, `password_reset_expires_at`.
- **Keep:** `id`, `email`, `name`, `avatar_url`, `last_login`, `created_at`, `updated_at`, `role`. The `role` column is a denormalized cache of the highest realm role, refreshed on every login, used only for fast UI gating.

The REVAMP `users` row survives because every other domain table already FKs to `users.id`. Ripping those FKs out is a separate, bigger refactor. Instead we treat the REVAMP `users` row as a local projection of the Keycloak user — upserted on every successful login, identified by `keycloak_sub`.

**`sessions` table.** Drop. Keycloak owns sessions.

**`invitations` table.** Keep. Used by the wizard's CSV path and future in-app invites. Acceptance creates a Keycloak user; the REVAMP row is created on that user's first login.

**`revamp_settings` table.** New, single row. Holds `setup_complete: boolean`, `bootstrap_token_hash`, `federation_tested_at`. Guards the `/setup` route and persists install-scoped config.

### Migration sequence (at upgrade)

A Drizzle migration + a companion Node script run in sequence:

1. **Migration 1 (SQL-only).** Add `keycloak_sub` nullable to `users`. Add `revamp_settings` table.
2. **Script (Node, idempotent).** For each existing `users` row, call Keycloak admin API: `POST /admin/realms/revamp/users` with `{email, firstName, lastName, enabled: true, requiredActions: ["UPDATE_PASSWORD"], credentials: []}`. Keycloak returns a new UUID. Write `users.keycloak_sub = <that UUID>`. On email conflict (user already exists — e.g. re-run after partial failure), GET by email, link the sub.
3. **Migration 2 (after the script runs clean).** Flip `keycloak_sub` to NOT NULL. Separate deploy so a script failure never leaves users half-migrated.
4. **Migration 3 (one release later).** Drop the password/OTP columns. Deliberately delayed to keep a 7-day rollback window; if the cutover goes wrong, the old code path can be re-enabled against preserved bcrypt hashes.

### Login-time projection (normal operation)

On every successful OIDC callback:
- Validate the access token. Read `sub`, `email`, `name`, `realm_access.roles`.
- UPSERT into `users` keyed on `keycloak_sub`: set `email`, `name`, `role` (highest realm role), `last_login = now()`.
- If the row did not exist before, emit a `user.created` audit log and let downstream services react via the event bus.

### Data loss and rollback

- The migration script is idempotent; a mid-run failure is re-runnable after the cause is fixed.
- The password-column drop (migration 3) is deferred so the old code path can reactivate against bcrypt hashes during the rollback window.
- Keycloak's own DB is a separate instance. No cross-DB foreign keys. Restoring one does not touch the other.

---

## MFA, Admin UI, Authorization

### MFA configuration

Applied by the setup wizard at install time:

- **Authentication flow:** Realm's Browser flow cloned and modified to add an **OTP conditional** step — "if user has OTP credential, require it; otherwise allow progression".
- **Required actions for admin role at Tavant:** when the `admin` realm role is assigned to a user, auto-apply `requiredActions=["CONFIGURE_TOTP"]`. First login forces enrollment.
- **Supported second factors:** TOTP (Google Authenticator, 1Password, etc.) + WebAuthn (hardware keys, Touch ID, platform authenticators). Both enabled at realm level; user picks which to enroll.
- **Customer installs:** wizard step 3b sets the policy (all users / admins only / optional). Default: "admins only".

### Admin UI split

- **Keycloak-native `/admin/revamp/console`** — used for: editing federation config, adding/removing IdP mappers, rotating realm keys, reviewing sessions, force-logout, managing required-actions flows. REVAMP does not wrap or reimplement any of this.
- **REVAMP's existing admin dashboard** — used for: project-level user management (assigning users to projects, per-project roles), audit log review, pipeline metrics, BYOK credentials.
- **Link from REVAMP → Keycloak.** A "Manage identity (opens Keycloak)" button in REVAMP's admin dashboard deep-links to the Keycloak admin URL.

### Authorization model

- **Realm roles in Keycloak:** `admin`, `architect`, `developer`, `sme`. Assigned to users; multi-role allowed if needed later.
- **Project-scoped roles:** remain in REVAMP's `project_members.role` column. A user can be `developer` at realm level and `project-admin` on a specific project. Keycloak is not informed about projects and should not be.
- **Fastify authz middleware:** unchanged API. `requireRole('admin')` now reads from `request.user.role` populated by the JWT's `realm_access.roles` claim instead of a user-table lookup. Project-scoped checks (`requireProjectRole(projectId, 'owner')`) keep querying `project_members`.

### Session invalidation

- Admin-initiated user disable (Keycloak admin UI/API) → next access-token refresh returns a revocation → Next.js middleware clears the cookie on 401 and redirects to login.
- Immediate logout across all sessions: Keycloak "logout all sessions" for that user. The current access token stays valid up to `access_token_lifespan` (default we ship: 15 minutes). If a stricter revocation window is ever required for compliance, introduce a token-introspection check in Fastify — but introspection has per-request latency cost, so skip it until there is a concrete requirement.

---

## Testing Strategy

### Unit

- **Fastify auth plugin** (rewritten). Mock JWKS. Cases: valid RS256 token populates `request.user`; expired token → 401; wrong `iss` → 401; wrong `aud` → 401; missing `realm_access.roles` → 401. No Keycloak container needed.
- **Next.js callback + middleware.** Mock Keycloak token endpoint. Cases: code exchange stores tokens in cookie; refresh happens ≤60 s before expiry; refresh failure clears cookie and redirects; logout calls end-session endpoint.

### Integration — with Testcontainers

Spin up real Keycloak + Postgres in tests. Realm pre-imported from a fixture JSON (committed to the repo). Cases: native-credential login, OIDC callback roundtrip, JWKS key rotation handled (rotate mid-suite, assert Fastify picks up the new JWK), logout invalidates session, MFA-required user blocked without OTP.

### Integration — federation

Use Keycloak's "keycloak-as-broker" mode: a second Keycloak instance plays the role of the federated IdP (Okta, Azure AD, etc.). Avoids needing real enterprise IdP credentials in CI. Covers: IdP login → realm user auto-provisioned, group attribute → realm role mapping, disabled IdP user → login fails gracefully.

### Setup wizard E2E

Playwright against the full docker-compose bundle. Flow: fresh install → `/setup` redirect → bootstrap token entry → federation configured → test connection → CSV import → wizard locked → second boot skips `/setup`.

### Migration script

Tested against a production-shaped `users` table (snapshot, anonymized). Idempotent re-run asserted. Failure midway (Keycloak API timeout simulated) recoverable.

---

## Rollback Strategy

- **Between Keycloak cutover and the bcrypt-column drop** (the intentional one-release gap): revert the code, users log in via the old JWT path against preserved bcrypt hashes. The legacy Fastify auth plugin and `/auth/*` route handlers are kept in the repository (behind a `LEGACY_AUTH_ENABLED` feature flag, default false) until migration 3 runs, so a revert is a flag flip plus a redeploy. No data loss. 7-day default grace window.
- **After the bcrypt drop:** rollback requires restoring REVAMP's DB from the pre-drop backup plus redeploying old code. This is not a casual operation — which is why the drop is deliberately deferred.
- **Keycloak catastrophic failure:** REVAMP refuses logins (fail-closed, not fail-open). Restore Keycloak DB from backup. Existing sessions keep working until their access token expires (up to 15 minutes by default).
- **Migration script failure:** linkage is idempotent; re-run after fixing the cause. No partial-migration user lockout because the NOT-NULL migration does not run until the script reports success.

---

## Risks

- **(Medium) Resource footprint on customer installs.** Keycloak + its Postgres adds ~700 MB RAM baseline. Document a 4 GB RAM minimum in install docs (was 2 GB).
- **(Medium) Customer admin skill gap.** Keycloak's native admin UI is dense. Mitigation: wizard handles 95% of initial setup; post-setup edits are infrequent; REVAMP admin dashboard links prominently to Keycloak docs for the remaining cases.
- **(Low) Federated IdP mapping drift.** An enterprise changes its SAML group-name convention, users stop getting the right role. Mitigation: `user.created` and `user.role_changed` audit events log the raw claim values; the wizard's step-4 test-connection flow is rerunnable at any time.
- **(Low) Refresh-token theft from session cookie.** Cookie is encrypted + HTTP-only + `SameSite=Lax` + `Secure`. XSS is the only realistic vector, and REVAMP's existing CSP blocks inline scripts. Document key rotation procedure for the iron-session key.
- **(Low) VS Code extension stale refresh token after user offline for > refresh-token lifespan.** Extension re-prompts user to sign in; acceptable UX.

---

## Not in Scope

- Multi-tenant cloud REVAMP where one install serves many customers.
- Any per-project RBAC changes. `project_members` logic is untouched.
- Keycloak theme customization beyond realm-level logo and display name.
- Service accounts for agent-worker → API internal auth. Continues to use the existing shared-secret pattern; migration is a separate project.
- Keycloak HA / multi-replica deployment. Single instance is sufficient for both customer installs and Tavant AWS (RDS is HA; Keycloak is stateless between requests; sessions live in the Keycloak DB).
- Audit-log export to SIEM. Keycloak has native event logging; wiring to a SIEM is a Day-2 ops task.
- Reimplementing Keycloak's admin screens inside REVAMP.
