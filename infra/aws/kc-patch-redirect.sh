#!/bin/bash
# One-off: add the current PUBLIC_HOST to the revamp-web client's allowed
# redirect URIs in a Keycloak realm that has ALREADY booted (so realm-export.json
# re-import won't run). Run on the host:  sudo bash infra/aws/kc-patch-redirect.sh
#
# For fresh deploys you don't need this — setup-on-host.sh patches realm-export
# before the first Keycloak boot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Try script dir first, then common repo layouts, then $REVAMP_ENV override.
CANDIDATES=(
  "${REVAMP_ENV:-}"
  "${SCRIPT_DIR}/.env"
  "${SCRIPT_DIR}/../../infra/aws/.env"
  "$(pwd)/infra/aws/.env"
  "/home/ec2-user/Revamp/infra/aws/.env"
  "/home/ec2-user/lampv2/Revamp/infra/aws/.env"
  "/home/ec2-user/lampv2/infra/aws/.env"
)
ENV_PATH=""
for c in "${CANDIDATES[@]}"; do
  [[ -n "$c" && -r "$c" ]] && { ENV_PATH="$c"; break; }
done
if [[ -z "${ENV_PATH}" ]]; then
  echo "[kc-patch] Can't locate infra/aws/.env. Tried:" >&2
  for c in "${CANDIDATES[@]}"; do [[ -n "$c" ]] && echo "  $c" >&2; done
  echo "Re-run with sudo, or: sudo REVAMP_ENV=/path/to/.env bash $0" >&2
  exit 1
fi
echo "[kc-patch] Using env file: ${ENV_PATH}"
# shellcheck disable=SC1090
source "${ENV_PATH}"

: "${PUBLIC_HOST:?PUBLIC_HOST missing from .env}"
: "${KEYCLOAK_ADMIN:?KEYCLOAK_ADMIN missing from .env}"
: "${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD missing from .env}"

echo "[kc-patch] Getting admin token..."
TOKEN=$(curl -sf -X POST "http://localhost/kc/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" \
  -d "username=${KEYCLOAK_ADMIN}" \
  -d "password=${KEYCLOAK_ADMIN_PASSWORD}" \
  -d "grant_type=password" | jq -r .access_token)

if [[ -z "${TOKEN}" || "${TOKEN}" == "null" ]]; then
  echo "[kc-patch] Failed to acquire admin token. Is Keycloak up? Is the password right?" >&2
  exit 1
fi

CID=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost/kc/admin/realms/revamp/clients?clientId=revamp-web" | jq -r '.[0].id')

if [[ -z "${CID}" || "${CID}" == "null" ]]; then
  echo "[kc-patch] revamp-web client not found in realm. Has the realm been imported?" >&2
  exit 1
fi

echo "[kc-patch] Patching revamp-web (${CID}) with http://${PUBLIC_HOST}..."

PATCHED=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost/kc/admin/realms/revamp/clients/${CID}" | \
  jq --arg h "http://${PUBLIC_HOST}" '
    .redirectUris = ((.redirectUris // []) + [$h + "/auth/callback"] | unique) |
    .webOrigins = ((.webOrigins // []) + [$h] | unique) |
    .attributes["post.logout.redirect.uris"] = (
      (((.attributes["post.logout.redirect.uris"] // "") | split("##")) + [$h + "/"])
      | map(select(length > 0)) | unique | join("##")
    )
  ')

curl -sf -X PUT -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  "http://localhost/kc/admin/realms/revamp/clients/${CID}" -d "${PATCHED}"

echo "[kc-patch] Setting realm sslRequired=NONE (IP deploy runs on plain HTTP)..."
REALM_JSON=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost/kc/admin/realms/revamp" | jq '.sslRequired = "none"')
curl -sf -X PUT -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  "http://localhost/kc/admin/realms/revamp" -d "${REALM_JSON}"

echo "[kc-patch] Done. redirect URIs now include:"
curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost/kc/admin/realms/revamp/clients/${CID}" | \
  jq '{redirectUris, webOrigins, post_logout: .attributes["post.logout.redirect.uris"]}'
