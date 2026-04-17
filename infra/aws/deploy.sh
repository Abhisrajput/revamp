#!/usr/bin/env bash
# deploy.sh — one-shot AWS deployment for REVAMP.
#
# Provisions a single EC2 instance running the full REVAMP stack behind nginx+TLS.
# Secrets generated on the instance; Let's Encrypt issues a cert if DNS resolves.
#
# Security model:
#   - IMDSv2 required (HttpTokens=required); IMDS hop limit = 1 (containers
#     cannot reach IMDS on the bridge network).
#   - When --github-token is provided for a private repo, the token is stored
#     in AWS Secrets Manager (not embedded in user-data). An EC2 instance role
#     with least-privilege access to THAT secret only is attached; user-data
#     fetches the token at runtime, uses it for the initial git clone, then
#     scrubs it from the git remote so it never persists on disk.
#
# Usage:
#   ./deploy.sh \
#       --region us-east-1 \
#       --domain lamp.tavant.com \
#       --email ops@tavant.com \
#       [--instance-type t3.large] \
#       [--key-name revamp-aws] \
#       [--repo-url https://github.com/Abhisrajput/revamp.git] \
#       [--repo-ref main] \
#       [--github-token $GITHUB_TOKEN]
#
# Prereqs:
#   - AWS CLI authenticated (`aws sts get-caller-identity` succeeds)
#   - jq
#   - DNS: create an A record for --domain pointing at the instance's EIP
#
# Idempotency: re-running with the same --domain reuses the existing instance
# if found. To destroy, `./destroy.sh --domain lamp.tavant.com`.

set -euo pipefail

# ─── defaults ────────────────────────────────────────────────────────────────
REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="t3.large"
DOMAIN=""
EMAIL=""
KEY_NAME="revamp-aws"
REPO_URL="https://github.com/Abhisrajput/revamp.git"
REPO_REF="main"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
VOLUME_GB="40"

usage() {
  sed -n '2,40p' "$0"
  exit 1
}

# ─── parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)         REGION="$2"; shift 2;;
    --instance-type)  INSTANCE_TYPE="$2"; shift 2;;
    --domain)         DOMAIN="$2"; shift 2;;
    --email)          EMAIL="$2"; shift 2;;
    --key-name)       KEY_NAME="$2"; shift 2;;
    --repo-url)       REPO_URL="$2"; shift 2;;
    --repo-ref)       REPO_REF="$2"; shift 2;;
    --github-token)   GITHUB_TOKEN="$2"; shift 2;;
    --volume-gb)      VOLUME_GB="$2"; shift 2;;
    -h|--help)        usage;;
    *) echo "Unknown flag: $1" >&2; usage;;
  esac
done
[[ -z "$DOMAIN" ]] && { echo "--domain required" >&2; exit 1; }
[[ -z "$EMAIL"  ]] && { echo "--email required (for Let's Encrypt)" >&2; exit 1; }

STACK="revamp-$(echo "$DOMAIN" | tr '.' '-')"
SG_NAME="${STACK}-sg"
ROLE_NAME="${STACK}-role"
PROFILE_NAME="${STACK}-profile"
SECRET_NAME="revamp/${STACK}/github-token"

echo "[deploy] Region:        $REGION"
echo "[deploy] Domain:        $DOMAIN"
echo "[deploy] Stack name:    $STACK"
echo "[deploy] Instance type: $INSTANCE_TYPE"
echo "[deploy] Repo ref:      $REPO_REF"
echo ""

# ─── sanity checks ───────────────────────────────────────────────────────────
command -v aws >/dev/null || { echo "aws CLI missing" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq missing" >&2; exit 1; }
ACCOUNT_ID=$(aws sts get-caller-identity --region "$REGION" --query Account --output text)

# ─── discover VPC + subnet (use default VPC) ─────────────────────────────────
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
[[ -z "$VPC_ID" || "$VPC_ID" == "None" ]] && { echo "No default VPC — create one or pass --vpc-id (not implemented)" >&2; exit 1; }
SUBNET_ID=$(aws ec2 describe-subnets --region "$REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' --output text)
echo "[deploy] VPC: $VPC_ID  Subnet: $SUBNET_ID"

# ─── key pair ────────────────────────────────────────────────────────────────
KEY_PATH="${HOME}/.ssh/${KEY_NAME}.pem"
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "[deploy] Creating EC2 key pair $KEY_NAME — saving PEM to $KEY_PATH"
  aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

# ─── security group ──────────────────────────────────────────────────────────
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$SG_NAME" --description "$STACK security group" \
    --vpc-id "$VPC_ID" --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22  --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 80  --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  echo "[deploy] Created security group $SG_ID"
else
  echo "[deploy] Reusing security group $SG_ID"
fi

# ─── GitHub PAT → Secrets Manager + IAM role (only when --github-token set) ─
SECRET_ARN=""
if [[ -n "$GITHUB_TOKEN" ]]; then
  # Create or update the secret (token never persisted in user-data).
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --region "$REGION" \
      --secret-id "$SECRET_NAME" --secret-string "$GITHUB_TOKEN" >/dev/null
  else
    aws secretsmanager create-secret --region "$REGION" \
      --name "$SECRET_NAME" \
      --description "GitHub PAT for $STACK clone at first boot" \
      --secret-string "$GITHUB_TOKEN" \
      --tags Key=revamp:stack,Value="$STACK" >/dev/null
  fi
  SECRET_ARN=$(aws secretsmanager describe-secret --region "$REGION" \
    --secret-id "$SECRET_NAME" --query ARN --output text)
  echo "[deploy] Stored PAT in Secrets Manager: $SECRET_NAME"

  # IAM role with least-privilege access to ONLY that secret.
  TRUST_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-role --role-name "$ROLE_NAME" \
      --assume-role-policy-document "$TRUST_DOC" \
      --tags Key=revamp:stack,Value="$STACK" >/dev/null
  fi
  # Inline policy — scope is exactly this one secret ARN.
  POLICY_DOC=$(jq -n --arg arn "$SECRET_ARN" '{
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: $arn }]
  }')
  aws iam put-role-policy --role-name "$ROLE_NAME" \
    --policy-name "${STACK}-github-token-read" \
    --policy-document "$POLICY_DOC" >/dev/null

  if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
    aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"
    # IAM propagation: wait briefly before run-instances uses it.
    sleep 10
  fi
  echo "[deploy] IAM profile $PROFILE_NAME ready"
fi

# ─── find Amazon Linux 2023 AMI ──────────────────────────────────────────────
AMI_ID=$(aws ec2 describe-images --region "$REGION" --owners amazon \
  --filters \
    "Name=name,Values=al2023-ami-2023.*-x86_64" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
echo "[deploy] AMI: $AMI_ID (Amazon Linux 2023)"

# ─── prepare user-data (no secrets embedded) ─────────────────────────────────
USER_DATA_DIR=$(mktemp -d)
trap 'rm -rf "$USER_DATA_DIR"' EXIT
USER_DATA_PATH="$USER_DATA_DIR/user-data.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sed \
  -e "s|{{PUBLIC_HOST}}|${DOMAIN}|g" \
  -e "s|{{LE_EMAIL}}|${EMAIL}|g" \
  -e "s|{{REPO_URL}}|${REPO_URL}|g" \
  -e "s|{{REPO_REF}}|${REPO_REF}|g" \
  -e "s|{{AWS_REGION}}|${REGION}|g" \
  -e "s|{{SECRET_ARN}}|${SECRET_ARN}|g" \
  "${SCRIPT_DIR}/user-data.sh" > "$USER_DATA_PATH"

# ─── reuse existing instance if one is tagged for this stack ────────────────
EXISTING_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters \
    Name=tag:revamp:stack,Values="$STACK" \
    Name=instance-state-name,Values=running,pending,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)

if [[ "$EXISTING_ID" != "None" && -n "$EXISTING_ID" ]]; then
  INSTANCE_ID="$EXISTING_ID"
  echo "[deploy] Reusing existing instance $INSTANCE_ID"
else
  RUN_ARGS=(
    --region "$REGION"
    --image-id "$AMI_ID"
    --instance-type "$INSTANCE_TYPE"
    --key-name "$KEY_NAME"
    --security-group-ids "$SG_ID"
    --subnet-id "$SUBNET_ID"
    --associate-public-ip-address
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${VOLUME_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]"
    --user-data "file://$USER_DATA_PATH"
    # IMDSv2 required; hop limit 1 blocks container access via the docker bridge.
    --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled"
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$STACK},{Key=revamp:stack,Value=$STACK}]"
  )
  if [[ -n "$SECRET_ARN" ]]; then
    RUN_ARGS+=(--iam-instance-profile "Name=$PROFILE_NAME")
  fi
  INSTANCE_ID=$(aws ec2 run-instances "${RUN_ARGS[@]}" --query 'Instances[0].InstanceId' --output text)
  echo "[deploy] Launched instance $INSTANCE_ID — waiting for running state"
fi

aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

# ─── elastic IP ──────────────────────────────────────────────────────────────
EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
  --filters Name=tag:revamp:stack,Values="$STACK" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
if [[ "$EIP_ALLOC" == "None" || -z "$EIP_ALLOC" ]]; then
  EIP_ALLOC=$(aws ec2 allocate-address --region "$REGION" --domain vpc --query 'AllocationId' --output text)
  aws ec2 create-tags --region "$REGION" --resources "$EIP_ALLOC" \
    --tags Key=Name,Value="$STACK" Key=revamp:stack,Value="$STACK"
  echo "[deploy] Allocated EIP $EIP_ALLOC"
fi
aws ec2 associate-address --region "$REGION" \
  --instance-id "$INSTANCE_ID" --allocation-id "$EIP_ALLOC" >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" \
  --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)

# ─── summary ─────────────────────────────────────────────────────────────────
cat <<EOF

╔════════════════════════════════════════════════════════════════════════════╗
║ REVAMP deployment in progress                                              ║
╠════════════════════════════════════════════════════════════════════════════╣
║ Instance:     $INSTANCE_ID
║ Region:       $REGION
║ Public IP:    $PUBLIC_IP
║ Domain:       $DOMAIN
║ IMDS:         v2 required, hop-limit 1 (containers cannot reach IMDS)
║ PAT:          ${SECRET_ARN:-<public repo — no token needed>}
║
║ Next steps:
║   1. Point your DNS A record for $DOMAIN at $PUBLIC_IP
║   2. Wait ~10 minutes for first-boot build (logs: SSH in, tail /var/log/revamp-bootstrap.log)
║   3. Once DNS propagates, Let's Encrypt will issue a cert on the next
║      certbot-renew cycle (every 12h). To trigger immediately:
║        ssh -i $KEY_PATH ec2-user@$PUBLIC_IP
║        cd /opt/revamp/infra/aws
║        docker compose --env-file .env -f docker-compose.aws.yml \\
║          exec certbot certbot renew --force-renewal
║        docker compose --env-file .env -f docker-compose.aws.yml exec nginx nginx -s reload
║   4. Visit https://$DOMAIN/setup and paste the bootstrap token:
║        ssh -i $KEY_PATH ec2-user@$PUBLIC_IP cat /var/log/revamp-setup-token.log
║
║ SSH: ssh -i $KEY_PATH ec2-user@$PUBLIC_IP
╚════════════════════════════════════════════════════════════════════════════╝
EOF
