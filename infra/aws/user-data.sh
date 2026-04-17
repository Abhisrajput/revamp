#!/bin/bash
# user-data.sh — runs as root at EC2 first boot. Installs Docker, clones REVAMP,
# generates secrets, builds images, and starts the stack behind nginx+TLS.
#
# Placeholders replaced by deploy.sh before upload:
#   {{PUBLIC_HOST}}        — e.g. lamp.tavant.com
#   {{LE_EMAIL}}           — for Let's Encrypt
#   {{REPO_URL}}           — https://github.com/... (with optional token embedded)
#   {{REPO_REF}}           — branch or tag (default: main)

set -euo pipefail
exec > >(tee /var/log/revamp-bootstrap.log) 2>&1
echo "[$(date -Iseconds)] REVAMP AWS bootstrap starting"

PUBLIC_HOST='{{PUBLIC_HOST}}'
LE_EMAIL='{{LE_EMAIL}}'
REPO_URL='{{REPO_URL}}'
REPO_REF='{{REPO_REF}}'

# ─── install docker + compose + git ─────────────────────────────────────────
if ! command -v docker >/dev/null; then
  dnf -y install docker git >/dev/null 2>&1 || yum -y install docker git
  systemctl enable --now docker
  usermod -aG docker ec2-user
fi
if ! docker compose version >/dev/null 2>&1; then
  mkdir -p /usr/libexec/docker/cli-plugins
  curl -fsSL https://github.com/docker/compose/releases/download/v2.29.2/docker-compose-linux-x86_64 \
    -o /usr/libexec/docker/cli-plugins/docker-compose
  chmod +x /usr/libexec/docker/cli-plugins/docker-compose
fi

# ─── clone repo ──────────────────────────────────────────────────────────────
install -d -o ec2-user -g ec2-user /opt/revamp
cd /opt
if [ ! -d /opt/revamp/.git ]; then
  git clone "${REPO_URL}" /opt/revamp
  chown -R ec2-user:ec2-user /opt/revamp
fi
cd /opt/revamp
git fetch --all --tags
git checkout "${REPO_REF}"
git pull --ff-only || true

# ─── generate .env with strong random secrets ───────────────────────────────
ENV_PATH=/opt/revamp/infra/aws/.env
if [ ! -f "${ENV_PATH}" ]; then
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
  chmod 600 "${ENV_PATH}"
  chown ec2-user:ec2-user "${ENV_PATH}"
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
sleep 30  # let nginx settle on the self-signed cert
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
docker logs revamp-api 2>&1 | grep -E '\[SETUP\]' > /var/log/revamp-setup-token.log || true

echo "[$(date -Iseconds)] REVAMP AWS bootstrap complete"
echo "=== Service summary ==="
docker compose --env-file .env -f docker-compose.aws.yml ps
echo ""
echo "=== Bootstrap token (visit https://${PUBLIC_HOST}/setup and paste it) ==="
cat /var/log/revamp-setup-token.log || echo "(not yet logged — wait a minute then run: docker logs revamp-api | grep SETUP)"
