# Keycloak Upgrade Runbook

Applies to: REVAMP customer self-hosted deployments and the Tavant-hosted instance at lamp.tavant.com.

## Pre-upgrade checklist

1. **Backup the Keycloak DB.** On customer docker-compose deployments:
   ```bash
   docker exec revamp-keycloak-db pg_dump -U keycloak keycloak \
     > keycloak-backup-$(date +%Y%m%d).sql
   ```
   On AWS (RDS): take a manual snapshot before touching the Keycloak pod.

2. **Export the current realm.** Useful for diffing after upgrade:
   ```bash
   # Via Keycloak admin CLI from inside the container
   docker exec revamp-keycloak /opt/keycloak/bin/kc.sh export \
     --realm revamp --file /tmp/realm-pre-upgrade.json
   docker cp revamp-keycloak:/tmp/realm-pre-upgrade.json ./
   ```

3. **Announce the outage window.** Keycloak restart interrupts auth for up to 60 seconds.
   Active browser sessions keep their current access token valid (15-minute lifespan),
   so read-heavy users may not notice — but anyone whose token expires during the
   window gets redirected to re-login.

## Upgrade (same-major)

1. Stop Keycloak:
   ```bash
   docker compose -f docker-compose.customer.yml stop keycloak
   ```

2. Bump the image tag in the compose file (e.g., `quay.io/keycloak/keycloak:25.0` →
   `25.1`). Same-major upgrades (25.0 → 25.x) do not require special migration flags.

3. Restart:
   ```bash
   docker compose -f docker-compose.customer.yml up -d keycloak
   ```

4. Watch logs for `Keycloak X.Y.Z on JVM ... started in ...`. Schema migration, if any,
   runs automatically.

5. Run the live smoke test:
   ```bash
   pnpm --filter @revamp/api exec tsx scripts/verify-keycloak-live.ts
   ```
   Expected: all ✓ checks + `✅ Keycloak live smoke test passed`.

## Upgrade (cross-major)

Cross-major Keycloak upgrades (e.g., 25.x → 26.x) require:
- Reading Keycloak's official upgrade guide at https://www.keycloak.org/docs/latest/upgrading/
- Testing in a staging environment with a DB snapshot from production
- A maintenance window longer than 60 seconds — schema migrations can take minutes

Use this runbook only as a checklist; Keycloak's own documentation is authoritative for
cross-major moves.

## Rollback

1. Stop Keycloak.
2. Revert the image tag.
3. Start Keycloak.

Keycloak does not auto-downgrade its schema. If the upgrade migrated the DB schema, a
downgrade requires restoring the DB backup:

```bash
# Stop Keycloak first
docker compose -f docker-compose.customer.yml stop keycloak

# Restore DB
docker exec -i revamp-keycloak-db psql -U keycloak keycloak < keycloak-backup-YYYYMMDD.sql

# Start Keycloak on the old image tag
docker compose -f docker-compose.customer.yml up -d keycloak
```

5. Run the live smoke test to confirm rollback.

## Emergency: Keycloak unavailable

If Keycloak is completely unreachable (DB corruption, image pull failure, etc.) AND
you are within the Keycloak-rollout window (the legacy JWT path still works against
preserved bcrypt hashes):

```bash
# Set LEGACY_AUTH_ENABLED=true in .env, restart the API
LEGACY_AUTH_ENABLED=true docker compose -f docker-compose.customer.yml up -d revamp-api
```

Users sign in with their legacy email/password. Schedule Keycloak restoration, then
flip the flag back off.

Once migration 3 (drop legacy password columns) has run in a future release, this
emergency path is no longer available. At that point, Keycloak unavailability = auth
outage; restore Keycloak from backup immediately.
