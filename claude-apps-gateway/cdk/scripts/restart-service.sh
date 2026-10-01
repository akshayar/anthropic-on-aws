#!/usr/bin/env bash
# restart-service.sh — force a zero-downtime rolling restart of the gateway's
# ECS service(s) so freshly-started tasks re-read Secrets Manager.
#
# WHY THIS EXISTS
#   ECS resolves `secrets:` (DB_PASSWORD, OIDC_CLIENT_SECRET, GATEWAY_JWT_SECRET)
#   at TASK-LAUNCH time and injects them as env vars. A running task holds the
#   value it started with. So after a DB password ROTATION (RDS-managed or manual),
#   or after re-seeding any secret, the live tasks keep using the OLD value until
#   they are replaced. This forces that replacement WITHOUT a cdk deploy — the task
#   definition and the secret ARNs are unchanged; only the tasks are cycled.
#
#   With desiredCount >= 2 (the default), ECS brings up new tasks before draining
#   the old ones, so this is zero-downtime.
#
# USAGE
#   ./restart-service.sh                         # restart the gateway service
#   ./restart-service.sh --admin                 # also restart the admin service
#   GATEWAY_NAME=claude-gateway AWS_REGION=ap-south-1 ./restart-service.sh
#
# ENV
#   GATEWAY_NAME  cluster + gateway service name (default: claude-gateway)
#   AWS_REGION    region (default: from the AWS CLI config / profile)
#   AWS_PROFILE   optional profile, passed through to the AWS CLI
#
# This performs NO destructive operation: it neither deletes nor scales to zero.
set -euo pipefail

GATEWAY_NAME="${GATEWAY_NAME:-claude-gateway}"
CLUSTER="${GATEWAY_NAME}"
REGION_ARG=()
[ -n "${AWS_REGION:-}" ] && REGION_ARG=(--region "${AWS_REGION}")

restart_one() {
  local service="$1"
  echo "▶  Forcing rolling restart of ECS service '${service}' on cluster '${CLUSTER}'..."
  if ! aws ecs describe-services --cluster "${CLUSTER}" --services "${service}" "${REGION_ARG[@]}" \
        --query "services[?status=='ACTIVE'].serviceName" --output text 2>/dev/null | grep -q .; then
    echo "   ⚠️  Service '${service}' not found or not ACTIVE on cluster '${CLUSTER}'. Skipping."
    return 1
  fi
  aws ecs update-service --cluster "${CLUSTER}" --service "${service}" \
    --force-new-deployment "${REGION_ARG[@]}" >/dev/null
  echo "   Waiting for '${service}' to reach a stable single-deployment state..."
  aws ecs wait services-stable --cluster "${CLUSTER}" --services "${service}" "${REGION_ARG[@]}"
  echo "✅ '${service}' restarted; new tasks are serving with the current secret values."
}

restart_one "${GATEWAY_NAME}"

if [ "${1:-}" = "--admin" ]; then
  # The admin service (when adminReady deploys it) is named ${GATEWAY_NAME}-admin.
  restart_one "${GATEWAY_NAME}-admin" || true
fi

echo ""
echo "Done. Confirm a single PRIMARY deployment:"
echo "  aws ecs describe-services --cluster ${CLUSTER} --services ${GATEWAY_NAME} ${AWS_REGION:+--region ${AWS_REGION}} \\"
echo "    --query \"services[0].deployments[].{status:status,rollout:rolloutState,running:runningCount}\""
