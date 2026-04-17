#!/usr/bin/env bash
# enable-ssm-on-instance.sh — attach SSM Session Manager access to an existing EC2.
#
# After this runs you can connect with:
#   aws ssm start-session --target <instance-id> --region <region>
# or via the AWS Console: EC2 → your instance → Connect → Session Manager.
# No port 22 rule needed. SSH via Session Manager is authenticated with your
# IAM user and every session is logged to CloudTrail.
#
# Prereqs on the instance:
#   - Amazon Linux 2023 / 2, Ubuntu 20.04+, RHEL 8+ (ships with SSM Agent).
#     If SSM agent isn't present on the instance, you need to install it — see
#     https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-install-ssm-agent.html
#   - Instance has internet egress OR an SSM VPC endpoint. (Default VPC has
#     an internet gateway so this works out of the box.)
#
# Usage:
#   ./enable-ssm-on-instance.sh --region us-east-1 --instance i-0abc123
#
# Safe to re-run; each step is idempotent.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
INSTANCE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)   REGION="$2"; shift 2;;
    --instance) INSTANCE_ID="$2"; shift 2;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0;;
    *) echo "Unknown: $1" >&2; exit 1;;
  esac
done
[[ -z "$INSTANCE_ID" ]] && { echo "--instance <i-...> required" >&2; exit 1; }

ROLE_NAME="revamp-ssm-role"
PROFILE_NAME="revamp-ssm-profile"

echo "[ssm] Region:    $REGION"
echo "[ssm] Instance:  $INSTANCE_ID"

# ─── create role (if missing) ────────────────────────────────────────────────
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "[ssm] Creating role $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true

# ─── create instance profile (if missing) ────────────────────────────────────
if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  echo "[ssm] Creating instance profile $PROFILE_NAME"
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"
  echo "[ssm] Waiting ~10s for IAM propagation..."
  sleep 10
fi

# ─── attach to instance (replacing any existing profile) ────────────────────
EXISTING_ASSOC=$(aws ec2 describe-iam-instance-profile-associations --region "$REGION" \
  --filters "Name=instance-id,Values=$INSTANCE_ID" \
  --query 'IamInstanceProfileAssociations[0].AssociationId' --output text 2>/dev/null || true)

if [[ -n "$EXISTING_ASSOC" && "$EXISTING_ASSOC" != "None" ]]; then
  echo "[ssm] Replacing existing instance profile association"
  aws ec2 replace-iam-instance-profile-association --region "$REGION" \
    --association-id "$EXISTING_ASSOC" \
    --iam-instance-profile "Name=$PROFILE_NAME" >/dev/null
else
  echo "[ssm] Associating instance profile"
  aws ec2 associate-iam-instance-profile --region "$REGION" \
    --instance-id "$INSTANCE_ID" \
    --iam-instance-profile "Name=$PROFILE_NAME" >/dev/null
fi

echo "[ssm] Done. Waiting for SSM agent to register the instance..."
for i in $(seq 1 24); do
  STATUS=$(aws ssm describe-instance-information --region "$REGION" \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
  if [[ "$STATUS" == "Online" ]]; then
    break
  fi
  sleep 5
done

if [[ "$STATUS" != "Online" ]]; then
  echo "[ssm] Warning: instance still not reporting Online in SSM (status: $STATUS)."
  echo "       The SSM agent may take up to 5 minutes to pick up the new role."
  echo "       If it never comes Online:"
  echo "         1. Confirm the instance has internet egress (route table → IGW)."
  echo "         2. Confirm SSM agent is running:   sudo systemctl status amazon-ssm-agent"
  echo "         3. If not installed, install it:   sudo dnf install -y amazon-ssm-agent"
else
  echo "[ssm] Instance is Online in SSM."
fi

cat <<EOF

╔════════════════════════════════════════════════════════════════════════════╗
║ SSM Session Manager is ready                                               ║
╠════════════════════════════════════════════════════════════════════════════╣
║ Connect from your laptop (plug-in required, one-time install:              ║
║   brew install --cask session-manager-plugin                               ║
║   OR https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html )
║                                                                            ║
║   aws ssm start-session --target $INSTANCE_ID --region $REGION
║
║ Or via AWS Console:
║   EC2 → $INSTANCE_ID → Connect → Session Manager → Connect
║
║ You can now SAFELY remove the port-22 rule from the instance's security
║ group. Session Manager does not use port 22.
╚════════════════════════════════════════════════════════════════════════════╝
EOF
