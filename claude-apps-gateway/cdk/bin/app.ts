#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GatewayStack } from '../lib/claude-gateway-stack';
import { DbStack } from '../lib/db-stack';

/**
 * CDK entry point for the Claude apps gateway on ECS Fargate (Bedrock upstream).
 *
 * This is a WORKED EXAMPLE, not a supported production artifact. It provisions
 * the SAME Fargate deployment as setup.sh; the two are kept in sync.
 *
 * Two-pass deploy (the only forced ordering is image-must-exist-before-service):
 *   Pass 1:  cdk deploy --context imageReady=false   # creates the ECR repo only
 *   build + push the image (binary download + SHA-verify happens OUTSIDE CDK)
 *   Pass 2:  cdk deploy --context imageReady=true    # full stack incl. the service
 *
 * Context vars (pass with -c key=value, or set in cdk.json / cdk.context.json):
 *   RUNTIME / INFRA (consumed by the stack):
 *     region          region the STACK deploys into — VPC/ALB/RDS/ECR/ECS
 *                     (default: CDK_DEFAULT_REGION or us-east-1)
 *     bedrockRegion   region of the Bedrock endpoint the task calls — the upstream
 *                     `region:` + inference-profile ARN (default: region). Any region
 *                     works: the gateway uses global.anthropic.* inference profiles
 *     gatewayName     name prefix for repo/cluster/service/secrets/log group (default: claude-gateway)
 *     publicUrl       internal ALB https origin, e.g. https://claude-gateway.example.com   (required)
 *     imageTag        ECR image tag (default: the claudeVersion below)
 *     certArn         ACM cert ARN for publicUrl's hostname — IMPORTED   (required for pass 2)
 *     zoneName        Route 53 PRIVATE hosted-zone name (holds the A-record)   (required for pass 2)
 *     zoneId          private hosted-zone id (optional; looked up from zoneName if omitted)
 *     ingressCidr     VPN/corp CLIENT CIDR developers connect from — NOT the VPC CIDR   (required for pass 2)
 *     vpcId           import an existing VPC instead of creating one (optional)
 *     createVpcEndpoints  "false" to skip VPC endpoint creation when reusing a VPC
 *                     (`vpcId`) that already has them; default true (optional)
 *     imageReady      "false" for pass 1 (repo only), "true"/unset for pass 2
 *     adminReady      "true" to deploy the WIP admin app (repo + service + :3000
 *                     listener); default false. Needs a pushed ${gatewayName}-admin
 *                     image at imageTag that passes /healthz, else its rollback
 *                     circuit breaker fails the whole stack update.
 *   BUILD-TIME (stamped into the image by stamp-config.sh; shown here for parity,
 *   not passed to the running task — changing them means a new image, by design):
 *     claudeVersion   default 2.1.274
 *     oidcIssuer, oidcClientId, allowedEmailDomains
 */
const app = new cdk.App();

const ctx = (k: string): string | undefined => app.node.tryGetContext(k);
const region = ctx('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
// Region of the Bedrock endpoint the task calls. Defaults to the deploy region
// (the common single-region case); set -c bedrockRegion to point the upstream +
// the inference-profile IAM ARN at a different region. NOTE: cross-region Bedrock
// also needs the VPC Bedrock interface endpoint reworked — see the stack.
const bedrockRegion = ctx('bedrockRegion') ?? region;
const claudeVersion = ctx('claudeVersion') ?? '2.1.274';

// Database source (create-if-absent / reference-if-provided). If dbEndpoint is
// given, that INDEPENDENT database is referenced as-is (owned by neither stack).
// Otherwise the companion ClaudeGatewayDbStack creates + owns the DB and its outputs
// are passed into the gateway. The gateway stack NEVER owns an RDS resource.
const dbEndpointCtx = ctx('dbEndpoint');
const vpcId = ctx('vpcId');
let dbEndpoint = dbEndpointCtx;
let dbSecretArn = ctx('dbSecretArn');
let dbSecurityGroupId = ctx('dbSecurityGroupId');
let dbName = ctx('dbName');

if (!dbEndpoint) {
  const dbStack = new DbStack(app, 'ClaudeGatewayDbStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
    description: 'Claude apps gateway database (separate lifecycle from the gateway stack)',
    vpcId,
    dbName,
  });
  dbEndpoint = dbStack.dbEndpoint;
  dbSecretArn = dbStack.dbSecretArn;
  // Import the DB SG id by STABLE export name rather than the live cross-stack
  // token (dbStack.dbSecurityGroupId). Passing the token makes CDK synthesize a
  // usage-derived auto-export that it may try to prune while the gateway still
  // imports it -> "Cannot delete export ... in use" deadlock. A fixed-name
  // Fn.importValue is constant across synths, so the export is never pruned.
  dbSecurityGroupId = cdk.Fn.importValue(DbStack.SG_EXPORT_NAME);
  dbName = dbStack.dbName;
}

new GatewayStack(app, 'ClaudeGatewayStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description: 'Claude apps gateway on ECS Fargate with Amazon Bedrock (worked example)',
  gatewayName: ctx('gatewayName'),
  bedrockRegion,
  publicUrl: ctx('publicUrl'),
  imageTag: ctx('imageTag') ?? claudeVersion,
  certArn: ctx('certArn'),
  zoneName: ctx('zoneName'),
  zoneId: ctx('zoneId'),
  ingressCidr: ctx('ingressCidr'),
  vpcId,
  albSubnetIds: ctx('albSubnetIds'),
  dbEndpoint,
  dbSecretArn,
  dbSecurityGroupId,
  dbName,
  // Default true; only 'false' opts out (for a reused VPC that already has endpoints).
  createVpcEndpoints: ctx('createVpcEndpoints') !== 'false',
  // Pass 1 sets imageReady=false to create just the ECR repo; pass 2 (default)
  // deploys the full stack including the Fargate service.
  imageReady: ctx('imageReady') !== 'false',
  // Admin app is WIP; default OFF. Only 'true' opts in (needs a pushed
  // ${gatewayName}-admin image at imageTag that passes /healthz).
  adminReady: ctx('adminReady') === 'true',
});

app.synth();
