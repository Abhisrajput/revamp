# REVAMP Customer Installation Guide

Single-command installation of the REVAMP platform on a customer-provisioned host.

## Prerequisites

- Host running Linux or macOS (Windows via WSL2)
- Docker 24+ with Compose v2
- 4 GB RAM minimum, 8 GB recommended (Keycloak + Postgres + REVAMP API/Web + Redis + MinIO + agent worker)
- 20 GB free disk
- Ports 80 (HTTP) or 443 (HTTPS) exposed to the internal network or VPN
- Outbound HTTPS to LLM providers (Anthropic, OpenAI, Google, or a customer-hosted equivalent)

## Step 1: Extract the bundle

```bash
tar xzf revamp-1.0.0.tar.gz
cd revamp-1.0.0
```

The bundle contains:
- `docker-compose.customer.yml` — the service composition
- `.env.example` — configuration template
- `nginx/` — reverse proxy config (swap for customer's own proxy if preferred)
- `keycloak/realm-export.json` — the REVAMP realm definition

## Step 2: Configure

```bash
cp .env.example .env
${EDITOR:-nano} .env
```

Replace every `CHANGE_ME_*` value with a strong random secret. Generate with:
```bash
openssl rand -hex 32
```

At minimum, set:
- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `JWT_SECRET`
- `KEYCLOAK_ADMIN_PASSWORD`
- At least one LLM provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_AI_API_KEY`)

## Step 3: Bring up the stack

```bash
docker compose -f docker-compose.customer.yml up -d
```

Expect ~60 seconds for all healthchecks to pass. Watch progress:
```bash
docker compose -f docker-compose.customer.yml logs -f
```

Press Ctrl+C when you see all services as "healthy."

## Step 4: Complete setup

1. Watch the REVAMP API logs for the bootstrap token:
   ```bash
   docker logs revamp-api 2>&1 | grep '\[SETUP\]'
   ```
   Example output:
   ```
   [SETUP] Bootstrap token: 4f7c2a1e8b9d... — paste into /setup to complete installation
   ```

2. Open http://\<your-host\>/setup in a browser.

3. Paste the bootstrap token, then step through the wizard:
   - Create the realm admin (email + password)
   - Connect your identity provider (Azure AD, Okta, Google Workspace, SAML, OIDC, or skip)
   - Map IdP groups to REVAMP roles (admin / architect / developer / sme)
   - Choose MFA policy (required for admins / all / optional)
   - Test the connection
   - Import initial users (CSV) or skip
   - Finalize

4. The wizard redirects to `/auth/login`. Sign in with the admin credentials you just
   created. You land on the REVAMP dashboard.

## Step 5: Configure DNS + TLS

For internet-facing deployments:
- Point `revamp.yourco.com` at the host's public IP.
- Replace the bundled nginx config with your own TLS-terminating proxy, or follow the
  instructions in `nginx/README.md` for Let's Encrypt auto-renewal.
- Update `KEYCLOAK_ISSUER` and `KEYCLOAK_ADMIN_BASE_URL` in `.env` to use the public
  hostname (e.g., `https://auth.revamp.yourco.com`).
- Restart: `docker compose -f docker-compose.customer.yml up -d`.

## Troubleshooting

### Bootstrap token not showing in logs

Check whether setup was already completed in a prior boot:
```bash
docker exec revamp-postgres psql -U revamp -d revamp \
  -c "SELECT setup_complete, bootstrap_token_hash IS NOT NULL AS has_token FROM revamp_settings;"
```
If `setup_complete` is true, `/setup` is disabled. Use Keycloak's admin UI directly at
`http://<host>:8080/admin/` with the credentials you set in `.env`.

### Reset to reinstall

```bash
docker compose -f docker-compose.customer.yml down -v
docker compose -f docker-compose.customer.yml up -d
```
`-v` removes named volumes — all data is wiped. A fresh bootstrap token will be
logged on next startup.

### Keycloak not starting

- Check the logs: `docker logs revamp-keycloak`
- Common cause: `keycloak-db` is unhealthy. Check `docker logs revamp-keycloak-db`.
- Port 8080 conflict: another service on the host is already bound. Change the mapping
  in the compose file or stop the conflicting service.

### LLM calls fail

- Check that at least one provider key is set in `.env` and non-empty.
- Verify outbound HTTPS to the provider's API endpoint is reachable:
  ```bash
  docker exec revamp-api curl -I https://api.anthropic.com
  ```

## Upgrading

See `docs/ops/keycloak-upgrade-runbook.md` for Keycloak upgrades.
For REVAMP app upgrades:
```bash
# Update REVAMP_VERSION in .env to the new tag
docker compose -f docker-compose.customer.yml pull revamp-api revamp-web revamp-agent-worker
docker compose -f docker-compose.customer.yml up -d revamp-api revamp-web revamp-agent-worker
```
