#!/bin/bash
# build-admin-image.sh — build & push the claude-gateway-admin image via CodeBuild.
#
# The admin web app (admin-app/, Vite → nginx via admin-app/Dockerfile) is NOT
# built by deploy.sh. This mirrors deploy.sh's CodeBuild path (no local Docker) for
# the admin image so the AdminService has an image to pull when ADMIN_READY=true.
#
# Order of operations for the full admin rollout:
#   1. ADMIN_READY=true ./scripts/deploy.sh    # pass 1 creates BOTH ECR repos...
#      (this will FAIL at pass 2 / AdminService because no admin image exists yet)
#   -- OR, to avoid the failed pass-2, create the repo first with a repo-only pass:
#      ADMIN_READY=true npx cdk deploy -c imageReady=false <ctx...>
#   2. ./scripts/build-admin-image.sh          # build + push the admin image
#   3. ADMIN_READY=true ./scripts/deploy.sh    # now pass 2 brings AdminService up
#
# Build context is the REPO ROOT (admin-app/Dockerfile COPY paths are
# admin-app/... relative). Image is linux/amd64, tag :latest to match the stack's imageTag.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"   # .../claude-apps-gateway/cdk
REPO_ROOT="$(dirname "$PROJECT_DIR")"    # .../claude-apps-gateway (has admin-app/)
cd "$PROJECT_DIR"

[ -f .env ] && source .env
GATEWAY_NAME="${GATEWAY_NAME:-claude-gateway}"
DEPLOY_REGION="${DEPLOY_REGION:-${BEDROCK_REGION:-${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}}}"
: "${DEPLOY_REGION:?set DEPLOY_REGION or BEDROCK_REGION in .env}"
export AWS_REGION="$DEPLOY_REGION" AWS_DEFAULT_REGION="$DEPLOY_REGION"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

ADMIN_REPO="${GATEWAY_NAME}-admin"
ADMIN_URI="${ACCOUNT_ID}.dkr.ecr.${DEPLOY_REGION}.amazonaws.com/${ADMIN_REPO}"
echo "=== Build admin image → ${ADMIN_URI}:latest (region ${DEPLOY_REGION}) ==="

# Ensure the ECR repo exists (created by adminReady pass 1; create here if missing
# so this script is usable stand-alone).
if ! aws ecr describe-repositories --repository-names "$ADMIN_REPO" >/dev/null 2>&1; then
  echo "   admin ECR repo missing — creating $ADMIN_REPO"
  aws ecr create-repository --repository-name "$ADMIN_REPO" \
    --image-scanning-configuration scanOnPush=true >/dev/null
fi

BUCKET="claude-gateway-build-${ACCOUNT_ID}"
aws s3 mb "s3://$BUCKET" 2>/dev/null || true

# Reuse the gateway's CodeBuild IAM role; extend its ECR resource to the admin repo.
ROLE="claude-gateway-codebuild"
aws iam put-role-policy --role-name "$ROLE" --policy-name build-perms-admin \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::${BUCKET}\",\"arn:aws:s3:::${BUCKET}/*\"]},{\"Effect\":\"Allow\",\"Action\":[\"ecr:GetAuthorizationToken\"],\"Resource\":\"*\"},{\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchCheckLayerAvailability\",\"ecr:GetDownloadUrlForLayer\",\"ecr:BatchGetImage\",\"ecr:PutImage\",\"ecr:InitiateLayerUpload\",\"ecr:UploadLayerPart\",\"ecr:CompleteLayerUpload\"],\"Resource\":\"arn:aws:ecr:${DEPLOY_REGION}:${ACCOUNT_ID}:repository/${ADMIN_REPO}\"},{\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"*\"}]}" 2>/dev/null || true

# Separate CodeBuild project for the admin image (privileged for docker build).
if ! aws codebuild batch-get-projects --names claude-gateway-admin-build \
      --query "projects[0].name" --output text 2>/dev/null | grep -q claude-gateway-admin-build; then
  echo "   Creating CodeBuild project claude-gateway-admin-build..."
  aws codebuild create-project --name claude-gateway-admin-build \
    --source "{\"type\":\"S3\",\"location\":\"${BUCKET}/admin/\",\"buildspec\":\"buildspec.yml\"}" \
    --artifacts '{"type":"NO_ARTIFACTS"}' \
    --environment '{"type":"LINUX_CONTAINER","image":"aws/codebuild/standard:7.0","computeType":"BUILD_GENERAL1_SMALL","privilegedMode":true}' \
    --service-role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}" >/dev/null
fi

# buildspec: admin-app/Dockerfile with build context = repo root (COPY paths are
# admin-app/... relative). We upload the whole build context tree under s3://.../admin/.
cat > /tmp/admin-buildspec.yml <<EOF
version: 0.2
phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region ${DEPLOY_REGION} | docker login --username AWS --password-stdin ${ADMIN_URI}
  build:
    commands:
      - docker build --platform=linux/amd64 --provenance=false -f admin-app/Dockerfile -t ${ADMIN_REPO} .
      - docker tag ${ADMIN_REPO}:latest ${ADMIN_URI}:latest
  post_build:
    commands:
      - docker push ${ADMIN_URI}:latest
EOF

# Stage the build context to S3. The Dockerfile + nginx.conf now live INSIDE
# admin-app/, so uploading admin-app/ carries them too (context = repo root).
echo "   Uploading build context to s3://$BUCKET/admin/ ..."
aws s3 cp /tmp/admin-buildspec.yml "s3://$BUCKET/admin/buildspec.yml" --quiet
aws s3 cp "${REPO_ROOT}/admin-app"   "s3://$BUCKET/admin/admin-app"   --recursive --exclude "node_modules/*" --exclude "dist/*" --quiet

echo "   Starting admin build..."
BUILD_ID=$(aws codebuild start-build --project-name claude-gateway-admin-build --query "build.id" --output text)
echo "   Waiting for build to complete ($BUILD_ID)..."
while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query "builds[0].buildStatus" --output text)
  case "$STATUS" in
    SUCCEEDED) echo "✅ Admin image built and pushed to ${ADMIN_URI}:latest"; break ;;
    FAILED|STOPPED|FAULT|TIMED_OUT) echo "❌ Admin build failed: $STATUS"; exit 1 ;;
    *) sleep 10 ;;
  esac
done
