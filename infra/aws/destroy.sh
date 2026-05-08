#!/usr/bin/env bash
# destroy.sh — tear down a REVAMP stack provisioned by deploy.sh.
# Usage: ./destroy.sh --region us-east-1 --domain lamp.tavant.com

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DOMAIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    -h|--help) echo "Usage: $0 --region <aws-region> --domain <fqdn>"; exit 0;;
    *) echo "Unknown: $1" >&2; exit 1;;
  esac
done
[[ -z "$DOMAIN" ]] && { echo "--domain required" >&2; exit 1; }

STACK="revamp-$(echo "$DOMAIN" | tr '.' '-')"
ROLE_NAME="${STACK}-role"
PROFILE_NAME="${STACK}-profile"
SECRET_NAME="revamp/${STACK}/github-token"

echo "[destroy] stack: $STACK"

# ─── terminate instances ────────────────────────────────────────────────────
INST=$(aws ec2 describe-instances --region "$REGION" \
  --filters \
    Name=tag:revamp:stack,Values="$STACK" \
    Name=instance-state-name,Values=running,pending,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [[ -n "$INST" && "$INST" != "None" ]]; then
  echo "[destroy] terminating $INST"
  aws ec2 terminate-instances --region "$REGION" --instance-ids $INST >/dev/null
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids $INST
fi

# ─── release EIP ─────────────────────────────────────────────────────────────
EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
  --filters Name=tag:revamp:stack,Values="$STACK" \
  --query 'Addresses[].AllocationId' --output text)
if [[ -n "$EIP_ALLOC" && "$EIP_ALLOC" != "None" ]]; then
  echo "[destroy] releasing EIP $EIP_ALLOC"
  aws ec2 release-address --region "$REGION" --allocation-id $EIP_ALLOC
fi

# ─── delete security group ───────────────────────────────────────────────────
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values="${STACK}-sg" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ -n "$SG_ID" && "$SG_ID" != "None" ]]; then
  echo "[destroy] deleting security group $SG_ID"
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" || true
fi

# ─── detach + delete instance profile + role ────────────────────────────────
if aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  echo "[destroy] removing instance profile $PROFILE_NAME"
  aws iam remove-role-from-instance-profile \
    --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" 2>/dev/null || true
  aws iam delete-instance-profile --instance-profile-name "$PROFILE_NAME" 2>/dev/null || true
fi
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "[destroy] deleting role $ROLE_NAME"
  # Delete all inline policies first
  POLICIES=$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames[]' --output text)
  for p in $POLICIES; do
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$p" || true
  done
  aws iam delete-role --role-name "$ROLE_NAME" || true
fi

# ─── delete the Secrets Manager secret (immediate, no recovery window) ──────
if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "[destroy] deleting secret $SECRET_NAME"
  aws secretsmanager delete-secret --region "$REGION" \
    --secret-id "$SECRET_NAME" \
    --force-delete-without-recovery >/dev/null
fi

echo "[destroy] done"
