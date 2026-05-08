#!/usr/bin/env bash
# setup-on-host.sh — Run this ON the EC2 instance you've already provisioned.
#
# Assumes:
#   - You SSH'd into an Amazon Linux 2023 (or similar RHEL-family) EC2 instance
#     and have either copied/cloned the REVAMP repo to /opt/revamp OR are
#     running this script from inside a checked-out repo on the instance.
#   - The instance's security group allows inbound :80 from wherever you want
#     to browse from (leave :443 closed for the HTTP-only mode).
#   - Your AWS keypair gave you sudo on the host (defaults true on AL2023).
#
# Does, in order:
#   1. Installs Docker + Compose + git.
#   2. Auto-detects the instance's public IP via IMDSv2 (or accepts
#      --host <ip|hostname> override).
#   3. Generates a fresh .env with strong random secrets (once; re-use
#      on subsequent runs).
#   4. Builds the REVAMP images on this host and starts the stack.
#   5. Prints the bootstrap token and the http://<ip>/setup URL.
#
# Usage (from anywhere inside the repo):
#     cd /opt/revamp
#     sudo bash infra/aws/setup-on-host.sh            # auto-detect IP
#     sudo bash infra/aws/setup-on-host.sh --host 1.2.3.4
#
# To tear down (keep data volumes):
#     cd /opt/revamp/infra/aws
#     sudo docker compose --env-file .env -f docker-compose.aws-ip.yml down
#
# To tear down AND wipe all data:
#     sudo docker compose --env-file .env -f docker-compose.aws-ip.yml down -v

set -euo pipefail

PUBLIC_HOST_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) PUBLIC_HOST_OVERRIDE="$2"; shift 2;;
    -h|--help) sed -n '2,30p' "$0"; exit 0;;
    *) echo "Unknown flag: $1" >&2; exit 1;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (or via sudo): sudo bash $0" >&2
  exit 1
fi

# ─── locate repo root ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT/infra/aws"

echo "[setup] Repo root: $REPO_ROOT"

# ─── install deps ────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null; then
  echo "[setup] Installing docker + git..."
  dnf -y install docker git >/dev/null 2>&1 || yum -y install docker git
  systemctl enable --now docker
  if id ec2-user >/dev/null 2>&1; then usermod -aG docker ec2-user; fi
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "[setup] Installing Docker Compose plugin..."
  COMPOSE_VERSION="v2.29.2"
  mkdir -p /usr/libexec/docker/cli-plugins
  COMPOSE_SHA256=$(curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64.sha256" | awk '{print $1}' || true)
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/libexec/docker/cli-plugins/docker-compose.tmp
  if [ -n "${COMPOSE_SHA256}" ]; then
    ACTUAL=$(sha256sum /usr/libexec/docker/cli-plugins/docker-compose.tmp | awk '{print $1}')
    if [ "${ACTUAL}" != "${COMPOSE_SHA256}" ]; then
      echo "[FATAL] docker-compose checksum mismatch" >&2
      rm -f /usr/libexec/docker/cli-plugins/docker-compose.tmp
      exit 1
    fi
  fi
  mv /usr/libexec/docker/cli-plugins/docker-compose.tmp /usr/libexec/docker/cli-plugins/docker-compose
  chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi

# ─── determine PUBLIC_HOST ───────────────────────────────────────────────────
PUBLIC_HOST=""
if [[ -n "${PUBLIC_HOST_OVERRIDE}" ]]; then
  PUBLIC_HOST="${PUBLIC_HOST_OVERRIDE}"
elif curl -sf --max-time 1 -H "X-aws-ec2-metadata-token-ttl-seconds: 60" -X PUT http://169.254.169.254/latest/api/token >/dev/null 2>&1; then
  TOKEN=$(curl -sf -H "X-aws-ec2-metadata-token-ttl-seconds: 60" -X PUT http://169.254.169.254/latest/api/token)
  PUBLIC_HOST=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
fi
if [[ -z "${PUBLIC_HOST}" ]]; then
  echo "[setup] Couldn't auto-detect public IP from IMDSv2. Pass --host <ip-or-hostname>." >&2
  exit 1
fi
echo "[setup] Public host: ${PUBLIC_HOST}"

# ─── write .env (generate fresh secrets on first run) ───────────────────────
ENV_PATH="${REPO_ROOT}/infra/aws/.env"
if [[ ! -f "${ENV_PATH}" ]]; then
  install -m 600 /dev/null "${ENV_PATH}"
  cat > "${ENV_PATH}" <<EOF
PUBLIC_HOST=${PUBLIC_HOST}
POSTGRES_PASSWORD=$(openssl rand -hex 16)
KEYCLOAK_DB_PASSWORD=$(openssl rand -hex 16)
REDIS_PASSWORD=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=$(openssl rand -hex 16)
MINIO_ROOT_USER=minio-$(openssl rand -hex 4)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
EOF
  echo "[setup] Wrote ${ENV_PATH} with freshly-generated secrets"
else
  # Update PUBLIC_HOST if the instance's IP changed since last run.
  if ! grep -q "^PUBLIC_HOST=${PUBLIC_HOST}$" "${ENV_PATH}"; then
    sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${PUBLIC_HOST}|" "${ENV_PATH}"
    echo "[setup] Updated PUBLIC_HOST in .env to ${PUBLIC_HOST}"
  else
    echo "[setup] Re-using existing .env"
  fi
fi

# ─── generate self-signed TLS cert for HTTPS on the IP ─────────────────────
# Can't use Let's Encrypt for a bare IP, but Chrome auto-upgrades typed URLs to
# https:// and corporate proxies often block plain HTTP — so we ship a
# self-signed cert. Users click through the browser warning once.
TLS_DIR="${SCRIPT_DIR}/tls"
mkdir -p "${TLS_DIR}"
if [[ ! -s "${TLS_DIR}/fullchain.pem" ]] || ! openssl x509 -in "${TLS_DIR}/fullchain.pem" -noout -ext subjectAltName 2>/dev/null | grep -q "${PUBLIC_HOST}"; then
  echo "[setup] Generating self-signed TLS cert for ${PUBLIC_HOST}..."
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -keyout "${TLS_DIR}/privkey.pem" \
    -out "${TLS_DIR}/fullchain.pem" \
    -days 365 \
    -subj "/CN=${PUBLIC_HOST}" \
    -addext "subjectAltName=IP:${PUBLIC_HOST},DNS:${PUBLIC_HOST}" \
    2>/dev/null
  chmod 600 "${TLS_DIR}/privkey.pem"
  chmod 644 "${TLS_DIR}/fullchain.pem"
fi

# ─── switch URLs to https:// so OIDC redirects stay on TLS ──────────────────
# With the cert in place, we prefer https:// everywhere. Chrome won't downgrade,
# and Keycloak's own redirects (built from X-Forwarded-Proto) stay on https.
SCHEME="https"

# ─── patch realm-export with PUBLIC_HOST ────────────────────────────────────
# Keycloak's realm-export.json hardcodes redirect URIs for localhost + lamp.tavant.com.
# For an IP deploy we need to inject the current PUBLIC_HOST so the OIDC callback
# is allowed. Realms are only imported on FIRST boot — if keycloak-db already has
# data, this has no effect (use the admin console at /kc/admin/ to add URIs).
REALM_SRC="${REPO_ROOT}/infra/docker/keycloak/realm-export.json"
if [[ -f "${REALM_SRC}" ]] && ! grep -q "http://${PUBLIC_HOST}/auth/callback" "${REALM_SRC}"; then
  # Add IP-based redirect + web origin next to the localhost entries. Idempotent.
  tmp=$(mktemp)
  python3 - "$REALM_SRC" "$PUBLIC_HOST" > "$tmp" <<'PY' && mv "$tmp" "$REALM_SRC"
import json, sys
path, host = sys.argv[1], sys.argv[2]
with open(path) as f: data = json.load(f)
for c in data.get("clients", []):
    if c.get("clientId") == "revamp-web":
        for url in (f"http://{host}/auth/callback",):
            if url not in c.setdefault("redirectUris", []):
                c["redirectUris"].append(url)
        for url in (f"http://{host}",):
            if url not in c.setdefault("webOrigins", []):
                c["webOrigins"].append(url)
        for url in (f"http://{host}/",):
            attrs = c.setdefault("attributes", {})
            existing = attrs.get("post.logout.redirect.uris", "")
            parts = [p for p in existing.split("##") if p]
            if url not in parts:
                parts.append(url)
            attrs["post.logout.redirect.uris"] = "##".join(parts)
print(json.dumps(data, indent=2))
PY
  echo "[setup] Injected ${PUBLIC_HOST} into realm-export.json redirect URIs"
fi

# ─── build + start ───────────────────────────────────────────────────────────
echo "[setup] Building images + starting stack (first run: ~8-12 min)..."
docker compose --env-file "${ENV_PATH}" -f docker-compose.aws-ip.yml up -d --build

echo "[setup] Waiting for REVAMP API to finish booting (bootstrap token surfaces on first stable boot)..."
for _ in $(seq 1 60); do
  if docker logs revamp-api 2>&1 | grep -q '\[SETUP\]'; then break; fi
  sleep 5
done

# ─── summary ─────────────────────────────────────────────────────────────────
cat <<EOF

╔════════════════════════════════════════════════════════════════════════════╗
║ REVAMP is running                                                          ║
╠════════════════════════════════════════════════════════════════════════════╣
║ Web:           http://${PUBLIC_HOST}/
║ Setup wizard:  http://${PUBLIC_HOST}/setup
║ Login:         http://${PUBLIC_HOST}/auth/login
║ Keycloak admin: http://${PUBLIC_HOST}/kc/admin/ — creds in .env
║
║ Bootstrap token (paste at /setup):
EOF
docker logs revamp-api 2>&1 | grep -E '\[SETUP\]' | tail -2 || echo "║   (token not yet logged — wait 1–2 min then: docker logs revamp-api | grep SETUP)"
cat <<EOF
║
║ Manage:
║   Logs:     docker compose --env-file .env -f docker-compose.aws-ip.yml logs -f
║   Stop:     docker compose --env-file .env -f docker-compose.aws-ip.yml down
║   Wipe:     docker compose --env-file .env -f docker-compose.aws-ip.yml down -v
╚════════════════════════════════════════════════════════════════════════════╝
EOF
