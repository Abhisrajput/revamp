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

echo "[destroy] stack: $STACK"

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

EIP_ALLOC=$(aws ec2 describe-addresses --region "$REGION" \
  --filters Name=tag:revamp:stack,Values="$STACK" \
  --query 'Addresses[].AllocationId' --output text)
if [[ -n "$EIP_ALLOC" && "$EIP_ALLOC" != "None" ]]; then
  echo "[destroy] releasing EIP $EIP_ALLOC"
  aws ec2 release-address --region "$REGION" --allocation-id $EIP_ALLOC
fi

SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values="${STACK}-sg" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ -n "$SG_ID" && "$SG_ID" != "None" ]]; then
  echo "[destroy] deleting security group $SG_ID"
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" || true
fi

echo "[destroy] done"
