# REVAMP — One-Command AWS Deployment

Single-host EC2 deployment of the full REVAMP stack (Keycloak, Postgres × 2,
Redis, MinIO, REVAMP API, Next.js web, nginx, certbot) behind TLS with
Let's Encrypt.

**Scope:** demo / pilot deployments on a single instance. Not production-HA.
For production (multi-AZ, managed RDS, ECS/EKS, autoscaling), this serves as a
reference compose; promote to Terraform + ECS/EKS before real traffic.

## Prerequisites

- `aws` CLI configured (`aws sts get-caller-identity` succeeds)
- `jq`
- An FQDN you control (e.g. `lamp.tavant.com`)
- A GitHub personal access token if this repo is private

## One-command deploy

```bash
cd infra/aws

GITHUB_TOKEN=ghp_xxxxx ./deploy.sh \
  --region us-east-1 \
  --domain lamp.tavant.com \
  --email ops@tavant.com \
  --instance-type t3.large
```

What happens:

1. Default VPC + subnet discovered.
2. Security group `revamp-<stack>-sg` created with 22/80/443 open.
3. EC2 key pair created (if not already), PEM saved to `~/.ssh/<key>.pem`.
4. Amazon Linux 2023 t3.large launched with 40 GB gp3 root volume.
5. User-data installs Docker, clones the repo, generates strong random secrets,
   builds REVAMP images on the instance, starts the full stack.
6. Elastic IP allocated and associated.
7. Script prints the public IP + DNS instructions + SSH command.

## After deploy

1. **Point DNS:** create an A record for `--domain` pointing at the printed
   public IP. The deployment boots behind a self-signed cert while DNS
   propagates.
2. **First-boot wait:** ~8–12 min for images to build on the instance.
   SSH in and watch: `ssh -i ~/.ssh/revamp-aws.pem ec2-user@<ip>` then
   `sudo tail -f /var/log/revamp-bootstrap.log`.
3. **Trigger Let's Encrypt** once DNS resolves:
   ```bash
   ssh -i ~/.ssh/revamp-aws.pem ec2-user@<ip>
   cd /opt/revamp/infra/aws
   docker compose --env-file .env -f docker-compose.aws.yml \
     exec certbot certbot renew --force-renewal
   docker compose --env-file .env -f docker-compose.aws.yml exec nginx nginx -s reload
   ```
4. **Complete the REVAMP setup wizard:**
   ```bash
   ssh -i ~/.ssh/revamp-aws.pem ec2-user@<ip> cat /var/log/revamp-setup-token.log
   # paste the token at https://<domain>/setup
   ```

## URL map (after deploy)

| What | URL |
|---|---|
| REVAMP web | `https://<domain>/` |
| Setup wizard | `https://<domain>/setup` |
| Login | `https://<domain>/auth/login` |
| Keycloak (realm) | `https://<domain>/auth/realms/revamp` |
| Keycloak admin | `https://<domain>/auth/admin/` (creds in `.env` on the instance) |

## Tear down

```bash
./destroy.sh --region us-east-1 --domain lamp.tavant.com
```

Terminates the instance, releases the Elastic IP, deletes the security group.
Leaves the key pair (you may reuse it for other stacks).

## Secrets

All secrets generated on the EC2 instance at first boot and stored in
`/opt/revamp/infra/aws/.env` (chmod 600, owner `ec2-user`). To view the
Keycloak admin password:
```bash
ssh -i ~/.ssh/revamp-aws.pem ec2-user@<ip> 'grep ADMIN_PASSWORD /opt/revamp/infra/aws/.env'
```

## Upgrading REVAMP

SSH in, pull the new code, rebuild:
```bash
ssh -i ~/.ssh/revamp-aws.pem ec2-user@<ip>
cd /opt/revamp
git pull
cd infra/aws
docker compose --env-file .env -f docker-compose.aws.yml up -d --build
```

## Known limitations

- **Single host** — no HA, no autoscaling. If the instance dies, the service is
  down until you re-run `deploy.sh` (which reuses the EIP by default).
- **Local volumes** — Postgres, Keycloak DB, Redis, MinIO data live on the
  instance's EBS volume. Back up with EBS snapshots.
- **Self-signed cert window** — until DNS resolves and certbot can issue a
  cert, browsers warn about the self-signed cert. Accept or wait.
- **WebSocket auth** — carry-over from the Keycloak rollout: the pipeline
  dashboard's WebSocket uses the legacy JWT auth token; tracked as a
  follow-up PR before full-prod use.

## Going to production

For real traffic, replace this single-host setup with:
- **RDS PostgreSQL** (Multi-AZ) for both `revamp` and `keycloak` databases
- **ElastiCache Redis**
- **S3** instead of MinIO
- **ECS Fargate** or **EKS** for the app containers
- **ALB** with ACM cert instead of nginx + certbot
- **CloudFront** in front for edge caching

The existing `docker-compose.aws.yml` is a reference for container env wiring —
port it to ECS task definitions with appropriate secret manager integration.
