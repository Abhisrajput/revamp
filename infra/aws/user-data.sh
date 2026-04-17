#!/bin/bash
# user-data.sh — runs as root on EC2 first boot. Installs Docker, clones REVAMP,
# generates secrets, builds images, and starts the stack behind nginx+TLS.
#
# Security model:
#   - Bootstrap log is created with mode 0600 before any logging redirect so
#     its contents are root-only readable.
#   - Git clone credentials are fetched from AWS Secrets Manager at runtime
#     (never baked into user-data, never visible via IMDS). Clone output is
#     sent to /dev/null to avoid any URL-echo leak; the remote is rewritten
#     immediately after clone so the token is never written to git config.
#
# Placeholders replaced by deploy.sh before upload:
#   {{PUBLIC_HOST}}  — e.g. lamp.tavant.com
#   {{LE_EMAIL}}     — for Let's Encrypt
#   {{REPO_URL}}     — plain https URL, no credentials
#   {{REPO_REF}}     — branch or tag (default: main)
#   {{AWS_REGION}}   — for aws cli fetches against Secrets Manager
#   {{SECRET_ARN}}   — ARN of the GitHub PAT secret, or empty for public repos

set -euo pipefail

# Harden log permissions BEFORE redirect so tee cannot create a world-readable file.
install -m 600 /dev/null /var/log/revamp-bootstrap.log
exec > >(tee -a /var/log/revamp-bootstrap.log) 2>&1
echo "[$(date -Iseconds)] REVAMP AWS bootstrap starting"

PUBLIC_HOST='{{PUBLIC_HOST}}'
LE_EMAIL='{{LE_EMAIL}}'
REPO_URL='{{REPO_URL}}'
REPO_REF='{{REPO_REF}}'
AWS_REGION='{{AWS_REGION}}'
SECRET_ARN='{{SECRET_ARN}}'

# ─── install docker + compose + git + awscli ────────────────────────────────
if ! command -v docker >/dev/null; then
  dnf -y install docker git awscli >/dev/null 2>&1 || yum -y install docker git awscli
  systemctl enable --now docker
  usermod -aG docker ec2-user
fi
if ! docker compose version >/dev/null 2>&1; then
  COMPOSE_VERSION="v2.29.2"
  mkdir -p /usr/libexec/docker/cli-plugins
  # Fetch the official SHA256 alongside the binary (both over HTTPS from github.com)
  # and verify before install. If GitHub releases is compromised this is bypassable,
  # but it defends against single-file tampering in caching layers along the way.
  COMPOSE_SHA256=$(curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64.sha256" | awk '{print $1}')
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/libexec/docker/cli-plugins/docker-compose.tmp
  ACTUAL=$(sha256sum /usr/libexec/docker/cli-plugins/docker-compose.tmp | awk '{print $1}')
  if [ -n "${COMPOSE_SHA256}" ] && [ "${ACTUAL}" != "${COMPOSE_SHA256}" ]; then
    echo "[FATAL] docker-compose checksum mismatch: expected ${COMPOSE_SHA256}, got ${ACTUAL}" >&2
    rm -f /usr/libexec/docker/cli-plugins/docker-compose.tmp
    exit 1
  fi
  mv /usr/libexec/docker/cli-plugins/docker-compose.tmp /usr/libexec/docker/cli-plugins/docker-compose
  chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi

# ─── fetch GitHub PAT from Secrets Manager (memory only; not written) ───────
fetch_github_token() {
  [ -z "${SECRET_ARN}" ] && { echo ""; return; }
  aws secretsmanager get-secret-value \
    --region "${AWS_REGION}" \
    --secret-id "${SECRET_ARN}" \
    --query SecretString --output text
}

# ─── clone repo ──────────────────────────────────────────────────────────────
install -d -o ec2-user -g ec2-user /opt/revamp
cd /opt
if [ ! -d /opt/revamp/.git ]; then
  if [ -n "${SECRET_ARN}" ]; then
    # Build the credential-bearing URL in a local var, clone with output
    # silenced so the URL never appears in any log, and rewrite the remote
    # immediately so the token is not persisted in .git/config.
    TOKEN=$(fetch_github_token)
    if [ -z "${TOKEN}" ]; then
      echo "[FATAL] Secret ${SECRET_ARN} returned empty token" >&2
      exit 1
    fi
    AUTHED_URL="${REPO_URL/https:\/\//https:\/\/oauth2:${TOKEN}@}"
    git clone "${AUTHED_URL}" /opt/revamp >/dev/null 2>&1
    unset TOKEN AUTHED_URL
    # Scrub the credential-bearing remote; put the plain URL back.
    git -C /opt/revamp remote set-url origin "${REPO_URL}"
  else
    git clone "${REPO_URL}" /opt/revamp
  fi
  chown -R ec2-user:ec2-user /opt/revamp
fi
cd /opt/revamp
# Token-less fetch/checkout — works because the remote URL is now plain.
git fetch --all --tags >/dev/null 2>&1 || true
git checkout "${REPO_REF}"
git pull --ff-only >/dev/null 2>&1 || true

# ─── generate .env with strong random secrets ───────────────────────────────
ENV_PATH=/opt/revamp/infra/aws/.env
if [ ! -f "${ENV_PATH}" ]; then
  install -m 600 -o ec2-user -g ec2-user /dev/null "${ENV_PATH}"
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
fi

# ─── bootstrap nginx cert (self-signed first, Let's Encrypt after) ──────────
cd /opt/revamp/infra/aws

# Swap the placeholder hostname into nginx.conf
sed -i "s/PUBLIC_HOST_PLACEHOLDER/${PUBLIC_HOST}/g" nginx.conf

CERT_DIR="/var/lib/revamp-letsencrypt/live/${PUBLIC_HOST}"
if [ ! -f "${CERT_DIR}/fullchain.pem" ]; then
  mkdir -p "${CERT_DIR}"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${CERT_DIR}/privkey.pem" \
    -out    "${CERT_DIR}/fullchain.pem" \
    -days 1 -subj "/CN=${PUBLIC_HOST}" >/dev/null 2>&1
fi
# Seed the letsencrypt volume so nginx can start. certbot will overwrite.
docker volume create revamp-aws_letsencrypt >/dev/null 2>&1 || true
docker run --rm -v revamp-aws_letsencrypt:/dst -v "${CERT_DIR}":/src alpine:3 \
  sh -c "mkdir -p /dst/live/${PUBLIC_HOST} && cp -n /src/*.pem /dst/live/${PUBLIC_HOST}/"

# ─── build + start the stack ─────────────────────────────────────────────────
cd /opt/revamp/infra/aws
docker compose --env-file .env -f docker-compose.aws.yml up -d --build

# ─── request real Let's Encrypt cert (best-effort; DNS must resolve) ────────
sleep 30
if getent hosts "${PUBLIC_HOST}" >/dev/null; then
  docker compose --env-file .env -f docker-compose.aws.yml exec -T certbot \
    certbot certonly --webroot -w /var/www/certbot \
      --non-interactive --agree-tos --email "${LE_EMAIL}" \
      -d "${PUBLIC_HOST}" || echo "[WARN] certbot failed — keeping self-signed for now"
  docker compose --env-file .env -f docker-compose.aws.yml exec -T nginx nginx -s reload || true
else
  echo "[WARN] ${PUBLIC_HOST} does not resolve yet — skipping Let's Encrypt (self-signed cert in use)"
fi

# ─── capture the bootstrap setup token for the operator ─────────────────────
sleep 10
install -m 600 /dev/null /var/log/revamp-setup-token.log
docker logs revamp-api 2>&1 | grep -E '\[SETUP\]' >> /var/log/revamp-setup-token.log || true

echo "[$(date -Iseconds)] REVAMP AWS bootstrap complete"
echo "=== Service summary ==="
docker compose --env-file .env -f docker-compose.aws.yml ps
echo ""
echo "=== Bootstrap token (visit https://${PUBLIC_HOST}/setup and paste it) ==="
cat /var/log/revamp-setup-token.log || echo "(not yet logged — wait a minute then run: docker logs revamp-api | grep SETUP)"
