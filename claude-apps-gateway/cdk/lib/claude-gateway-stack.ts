import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as r53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export interface GatewayStackProps extends cdk.StackProps {
  /** Internal ALB https origin, e.g. https://claude-gateway.example.com */
  readonly publicUrl?: string;
  /** ECR image tag (defaults to the pinned claude version). */
  readonly imageTag: string;
  /** ACM cert ARN for publicUrl's hostname — IMPORTED. Required for pass 2. */
  readonly certArn?: string;
  /** Route 53 PRIVATE hosted-zone name, e.g. example.com (holds the A-record). */
  readonly zoneName?: string;
  /** Route 53 private hosted-zone id (optional; looked up from zoneName if omitted). */
  readonly zoneId?: string;
  /**
   * Extra stable hostname always published as a CNAME to the ALB (default gw.<zoneName>).
   * Churn-free + cross-region-resolvable; the durable name to migrate clients onto later.
   * Skipped automatically when it would duplicate the primary (publicUrl) host.
   */
  readonly secondaryHost?: string;
  /** VPN/corp CLIENT CIDR developers connect from — NOT the VPC CIDR. */
  readonly ingressCidr?: string;
  /** Import an existing VPC instead of creating one. */
  readonly vpcId?: string;
  /**
   * Create the interface + S3 VPC endpoints (default true). Set false ONLY when
   * reusing a VPC (`vpcId`) that ALREADY provides private egress to Bedrock,
   * Secrets Manager, ECR, CloudWatch Logs/Monitoring, and S3 — otherwise the
   * gateway loses its "AWS traffic never touches the internet" posture. AWS
   * permits only one private-DNS-enabled interface endpoint per service per VPC,
   * so recreating endpoints a reused VPC already has fails the deploy; this flag
   * is the opt-out for that case.
   */
  readonly createVpcEndpoints?: boolean;
  /**
   * When reusing a VPC (`vpcId`), the explicit subnets for the internal ALB and
   * Fargate tasks, as a comma-separated list of `subnetId:availabilityZone:routeTableId`
   * (e.g. `subnet-aaa:ap-south-1a:rtb-xxx,subnet-bbb:ap-south-1b:rtb-xxx`). Use this
   * when the reused VPC has more than one subnet in the same AZ (an ALB rejects two
   * subnets in one AZ) — pick exactly one subnet per AZ across >=2 AZs. Ignored for a
   * fresh CDK-created VPC (which already has one subnet per AZ per tier).
   */
  readonly albSubnetIds?: string;
  /**
   * Database wiring. The gateway NEVER owns an RDS resource; it always REFERENCES a
   * database by these values. When deploying via bin/app.ts with no DB_ENDPOINT, the
   * companion ClaudeGatewayDbStack creates the DB and passes its outputs here; when
   * DB_ENDPOINT is provided, that independent DB is referenced as-is (owned by neither
   * stack, untouched by deploys). All four are required for a pass-2 (service) deploy.
   */
  readonly dbEndpoint?: string;
  /** Secrets Manager ARN of the DB credentials secret (username/password JSON). */
  readonly dbSecretArn?: string;
  /** Security group id of the referenced DB, granted 5432 ingress from the task SG. */
  readonly dbSecurityGroupId?: string;
  /** Database name (default 'claude_gateway'). */
  readonly dbName?: string;
  /**
   * Name prefix for the stack's named resources (ECR repo, cluster, service,
   * secrets, log group). Mirrors setup.sh's PROJECT. Defaults to 'claude-gateway'.
   * deploy.sh passes this through from the .env GATEWAY_NAME.
   */
  readonly gatewayName?: string;
  /**
   * Region of the Bedrock endpoint the gateway calls — used for the upstream and
   * for scoping the inference-profile IAM ARN. Defaults to the stack's own region.
   * The gateway uses GLOBAL cross-region inference profiles (global.anthropic.*),
   * which resolve from any Bedrock region, so any value works.
   */
  readonly bedrockRegion?: string;
  /** false = pass 1 (ECR repo only); true = pass 2 (full stack incl. service). */
  readonly imageReady: boolean;
  /**
   * Gate the admin web app (its ECR repo, Fargate service, ALB :3000 listener,
   * log group, and security-group rules). Defaults to false because the admin
   * app is a WORK IN PROGRESS: it shares the gateway's imageTag, so with no
   * admin image pushed the admin task can't pull an image, and its
   * circuitBreaker:{rollback:true} then rolls back the WHOLE stack update.
   * Leave false to deploy the gateway alone; set true once a matching
   * `${gatewayName}-admin` image exists at imageTag and passes /healthz.
   */
  readonly adminReady?: boolean;
}

/**
 * The same Fargate deployment setup.sh provisions, expressed in CDK L2 constructs.
 * A WORKED EXAMPLE — see the repo README "Productionising" before relying on it.
 */
export class GatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // Name prefix for the stack's named resources. Mirrors setup.sh's PROJECT so
    // the two tracks name resources identically; deploy.sh passes it from GATEWAY_NAME.
    const gatewayName = props.gatewayName ?? 'claude-gateway';
    // Region of the Bedrock endpoint; defaults to the deploy region. The gateway
    // uses global.anthropic.* inference profiles, which resolve from any region.
    const bedrockRegion = props.bedrockRegion ?? this.region;
    // Admin app is a WORK IN PROGRESS; default OFF. When false, none of the admin
    // resources (repo, service, listener, log group, SG rules) are created, so the
    // untested admin container can't trip its rollback circuit breaker and fail the
    // whole stack update. Flip to true once a matching admin image exists.
    const adminReady = props.adminReady ?? false;

    // ── ECR repository (the pass-1 target) ────────────────────────────────────
    // Created first so the image can be built+pushed before the service exists.
    const repo = new ecr.Repository(this, 'Repo', {
      repositoryName: gatewayName,
      imageScanOnPush: true,
      // Example posture: clean teardown. Harden for production (see README).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: repo.repositoryUri });

    // ── ECR repository for the admin web app (only when adminReady) ───────────
    // Gated so the WIP admin app is fully absent until opted in. Created in both
    // passes (like the gateway repo) so its image can be pushed during pass 1.
    const adminRepo = adminReady
      ? new ecr.Repository(this, 'AdminRepo', {
          repositoryName: `${gatewayName}-admin`,
          imageScanOnPush: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          emptyOnDelete: true,
        })
      : undefined;

    if (adminRepo) {
      new cdk.CfnOutput(this, 'AdminEcrRepositoryUri', { value: adminRepo.repositoryUri });
    }

    // Pass 1 stops here: create just the repo, then build+push the image.
    if (!props.imageReady) {
      new cdk.CfnOutput(this, 'NextStep', {
        value:
          'Pass 1 complete. Build + push the image to the repo above, then re-run: ' +
          'cdk deploy -c imageReady=true -c publicUrl=... -c zoneName=... -c ingressCidr=... ' +
          '-c certArn=... (imported ACM cert for the gateway hostname).',
      });
      return;
    }

    // Pass-2 required inputs. We fail fast with a clear message rather than let
    // CDK synth a half-configured stack.
    const publicUrl = req(props.publicUrl, 'publicUrl');
    const zoneName = req(props.zoneName, 'zoneName');
    const ingressCidr = req(props.ingressCidr, 'ingressCidr');
    const certArn = req(props.certArn, 'certArn');
    // publicUrl is https://<host>; the record name is the host part.
    const recordHost = publicUrl.replace(/^https?:\/\//, '');

    // Private zone: holds the gateway A-record → internal ALB.
    const privateZone = props.zoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: props.zoneId,
          zoneName,
        })
      : route53.HostedZone.fromLookup(this, 'Zone', { domainName: zoneName, privateZone: true });

    // The one certificate both listeners share: an imported ACM cert for the
    // gateway hostname. The CLI pins its SHA-256 fingerprint on first /login
    // (the CertFingerprintHint output below prints how to read it). Want no
    // prompt? Import a public, browser-trusted ACM cert — DNS validation needs
    // no public endpoint, so the ALB can stay internal (see docs/deployment.md).
    const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', certArn);

    // ── VPC (2 AZs, public + private-with-egress) ─────────────────────────────
    // NAT is retained for the IdP leg only (public OIDC issuer); all AWS-service
    // traffic uses the VPC endpoints below and never touches the internet.
    const vpc = props.vpcId
      ? (ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId }) as ec2.IVpc)
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 2,
          natGateways: 1,
          ipProtocol: ec2.IpProtocol.IPV4_ONLY,
          subnetConfiguration: [
            { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
          ],
        });

    // When reusing an existing VPC (`vpcId`), that VPC may have MORE THAN ONE
    // private-with-egress subnet in the same Availability Zone (common in default
    // VPCs). An ALB rejects being attached to two subnets in the same AZ, so the
    // caller passes `albSubnetIds` — one subnet per AZ across >=2 AZs — as
    // `subnetId:az:routeTableId` entries, reused for both the tasks and the internal
    // ALB. For a fresh CDK-created VPC we fall back to the built-in private tier.
    const appSubnets: ec2.SubnetSelection = props.albSubnetIds
      ? {
          subnets: props.albSubnetIds.split(',').map((entry, i) => {
            const [subnetId, availabilityZone, routeTableId] = entry.split(':').map((s) => s.trim());
            return ec2.Subnet.fromSubnetAttributes(this, `GwSubnet${i}`, {
              subnetId,
              availabilityZone,
              routeTableId,
            });
          }),
        }
      : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    // ── Interface VPC endpoints (AWS backbone, no internet) + S3 gateway ──────
    // Always created for a fresh VPC. When reusing a VPC (`vpcId`), set
    // `createVpcEndpoints=false` IF that VPC already has these endpoints —
    // AWS allows only one private-DNS-enabled interface endpoint per service per
    // VPC, so recreating them fails the deploy. Skipping them is safe ONLY when
    // the reused VPC provides the same private egress; otherwise AWS traffic
    // silently falls back to the internet via NAT (see props doc).
    const createVpcEndpoints = props.createVpcEndpoints ?? true;
    const vpceSg = new ec2.SecurityGroup(this, 'VpceSg', {
      vpc,
      description: 'VPC endpoints: 443 from the gateway task SG',
      allowAllOutbound: true,
    });
    if (createVpcEndpoints) {
      const addIfaceEndpoint = (id: string, svc: ec2.InterfaceVpcEndpointAwsService) =>
        vpc.addInterfaceEndpoint(id, { service: svc, securityGroups: [vpceSg], privateDnsEnabled: true });
      addIfaceEndpoint('BedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME);
      addIfaceEndpoint('SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
      addIfaceEndpoint('EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR);
      addIfaceEndpoint('EcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER);
      addIfaceEndpoint('CloudWatchLogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
      addIfaceEndpoint('CloudWatchMonitoringEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING);
      vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    }

    // ── Three-tier security groups ────────────────────────────────────────────
    // The ALB's own security group is created by the ApplicationLoadBalanced-
    // FargateService pattern below; we set openListener:false there and restrict
    // its 443 ingress to ingressCidr after construction (a standalone ALB SG here
    // would be dangling, since the pattern attaches its own).
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'Gateway tasks: 8080 from the ALB only',
      allowAllOutbound: true,
    });
    // ALB -> task on 8080 is wired by the pattern; here we only add task -> endpoints.
    vpceSg.connections.allowFrom(taskSg, ec2.Port.tcp(443), 'tasks to VPC endpoints');

    // ── RDS PostgreSQL 16 (private, not public, encrypted, managed master secret)─
    // Example posture: easy teardown. See README "Productionising" to harden
    // (deletion protection, multi-AZ, longer backups, RETAIN) the moment you
    // enable spend limits, because then Postgres holds durable spend + PII.
    // The gateway NEVER creates an RDS instance — it REFERENCES a database provided
    // via props (either the companion ClaudeGatewayDbStack's outputs, or an
    // independent DB passed through DB_ENDPOINT). This decouples the DB lifecycle
    // from gateway redeploys entirely.
    const dbEndpoint = req(props.dbEndpoint, 'dbEndpoint');
    const dbSecretArn = req(props.dbSecretArn, 'dbSecretArn');
    const dbSecurityGroupId = req(props.dbSecurityGroupId, 'dbSecurityGroupId');
    const dbHost = dbEndpoint;
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'DbSecret', dbSecretArn);
    // Grant the gateway task SG ingress to the referenced DB's SG on 5432 (from the
    // gateway side, so there is no cross-stack circular dependency).
    const dbSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'DbSg', dbSecurityGroupId, {
      mutable: true,
    });
    dbSg.addIngressRule(taskSg, ec2.Port.tcp(5432), 'gateway tasks to referenced RDS');

    // ── Gateway-owned secrets (DB creds come from the RDS-managed secret) ─────
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: `${gatewayName}-jwt-secret`,
      description: 'Claude gateway JWT signing secret (>=32 bytes)',
      generateSecretString: {
        // >= 32 bytes of entropy; no JSON wrapper — the whole string is the secret.
        passwordLength: 44,
        excludePunctuation: false,
      },
    });
    const oidcSecret = new secretsmanager.Secret(this, 'OidcClientSecret', {
      secretName: `${gatewayName}-oidc-client-secret`,
      description: 'Claude gateway OIDC client secret — seeded out-of-band after deploy',
      // Generated placeholder rather than a fixed value ON PURPOSE: `generateSecretString`
      // only sets the value at CREATE time and CloudFormation never overwrites it on
      // update, so seeding the real secret out-of-band survives future deploys. A fixed
      // `secretStringValue` would reset the real value to the placeholder on every deploy.
      // deploy.sh seeds it from .env OIDC_CLIENT_SECRET (see its Step 4b); with setup.sh
      // export OIDC_CLIENT_SECRET so it seeds the value directly. Either way:
      //   aws secretsmanager put-secret-value --secret-id <gatewayName>-oidc-client-secret \
      //     --secret-string '<your-oidc-client-secret>'
      generateSecretString: {
        // Placeholder entropy only — the real IdP client secret is seeded post-deploy.
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    // ── Log group (gateway stderr: audit events + operational logs) ───────────
    const logGroup = new logs.LogGroup(this, 'GatewayLogGroup', {
      logGroupName: `/${gatewayName}/gateway`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── ECS cluster ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: gatewayName,
    });


    // ── Gateway task role: dual-ARN Bedrock policy ────────────────────────────
    // BOTH inference-profile (global.anthropic.*) AND foundation-model (anthropic.*)
    // ARNs — missing either yields 403 on invoke. auth: {} in gateway.yaml picks
    // this up via the ECS container-credentials endpoint (no IMDS, no hop-limit trap).
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Claude gateway task role: Bedrock invoke + CloudWatch metrics',
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          // From 2.1.260 the gateway counts an ABORTED request's input tokens with
          // Bedrock's free CountTokens API. It is not load-bearing: on failure the
          // gateway logs one warning and falls back to a max_tokens:1 invoke, so the
          // grant buys a free path instead of a billable probe. Verified 2026-09-15:
          // Bedrock's CountTokens takes only a BARE foundation-model id (the gateway
          // strips the global./us. prefix itself), and of this catalog only
          // anthropic.claude-haiku-4-5-20251001-v1:0 supports it — Opus 5 and Sonnet 5
          // return "The provided model doesn't support counting tokens", so they take
          // the fallback whatever IAM says.
          'bedrock:CountTokens',
        ],
        resources: [
          // GLOBAL cross-region inference profiles (gateway.yaml uses global.anthropic.*).
          // The profile ARN is scoped to the source (bedrock) region; global profiles
          // resolve from any region, so any bedrockRegion works. The foundation-model
          // ARN is region-wildcarded (::) because global routes to any commercial region.
          `arn:aws:bedrock:${bedrockRegion}:${this.account}:inference-profile/global.anthropic.*`,
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      }),
    );

    // ── Gateway Fargate service behind an internal IPv4 ALB ───────────────────
    // IPv4-only on purpose: internal dual-stack ALBs return public-range AAAA
    // records that /login rejects.
    const image = ecs.ContainerImage.fromEcrRepository(repo, props.imageTag);

    // Build the internal ALB EXPLICITLY so we control its subnets. The
    // ApplicationLoadBalancedFargateService pattern otherwise picks ALB subnets
    // from the VPC's default selection (ALL matching subnets), which fails in a
    // reused VPC that has >1 subnet in the same AZ ("a load balancer cannot be
    // attached to multiple subnets in the same Availability Zone"). taskSubnets
    // constrains only the tasks, NOT the ALB — so the LB subnets must be pinned here.
    const gatewayAlb = new elbv2.ApplicationLoadBalancer(this, 'GatewayAlb', {
      vpc,
      internetFacing: false, // internal → private IPs only (satisfies /login)
      ipAddressType: elbv2.IpAddressType.IPV4,
      vpcSubnets: appSubnets, // one subnet per AZ across >=2 AZs
    });

    const fargate = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Gateway', {
      cluster,
      serviceName: gatewayName,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2, // zero-downtime rolling deploys + AZ resilience; Postgres is the shared layer
      minHealthyPercent: 100, // keep all replicas up during a rolling deploy (the gateway is stateless)
      circuitBreaker: { rollback: true }, // fail a bad deploy fast and roll back instead of hanging for hours
      loadBalancer: gatewayAlb, // explicit internal ALB pinned to appSubnets (above)
      openListener: false, // don't open 443 to 0.0.0.0/0; we restrict to ingressCidr below
      taskSubnets: appSubnets,
      securityGroups: [taskSg],
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificate,
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      idleTimeout: cdk.Duration.seconds(3600), // long streaming responses
      // NOTE: DNS record is created explicitly AFTER this service (see below), NOT via
      // the pattern's domainName/domainZone props. Those always create an ALIAS A-record,
      // which (a) doesn't resolve cross-region in a private zone and (b) is illegal to
      // co-exist with a CNAME at the same name. We create a CNAME for a non-apex host
      // (churn-free + cross-region) and fall back to the alias A-record only at the apex.
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      taskImageOptions: {
        image,
        containerPort: 8080,
        taskRole,
        // NO non-secret app config here — it's baked into the image by design.
        // DB_HOST is the non-secret RDS endpoint (the RDS-managed secret holds
        // only username/password, not host).
        environment: {
          CLAUDE_GATEWAY_LOG_LEVEL: 'info',
          CLAUDE_CONFIG_DIR: '/tmp/.claude',
          DB_HOST: dbHost,
          CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1', // ADOT sidecar is on localhost
        },
        secrets: {
          GATEWAY_JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
          OIDC_CLIENT_SECRET: ecs.Secret.fromSecretsManager(oidcSecret),
          DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        },
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'gateway', logGroup }),
      },
    });

    // Give the gateway's SIGTERM drain room to finish. From 2.1.274 the gateway lets
    // in-flight requests complete for up to 25s before exiting
    // (CLAUDE_GATEWAY_DRAIN_TIMEOUT_MS) instead of cutting every open stream; ECS
    // SIGKILLs the container at stopTimeout, so a value below that window truncates
    // the drain and a rolling deploy severs live streaming responses again — the very
    // thing the 3600s ALB idle timeout above exists to prevent. The ECS default is 30s,
    // which only just covers 25s, so pin it explicitly with headroom.
    // ApplicationLoadBalancedFargateService's taskImageOptions exposes no stopTimeout,
    // hence the property override. Index 0 is the taskImageOptions container ("web");
    // the ADOT sidecar added below is index 1. The CDK test asserts the container
    // named "web" is the one carrying it, so a reordering can't silently move it.
    const cfnGatewayTaskDef = fargate.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnGatewayTaskDef.addPropertyOverride('ContainerDefinitions.0.StopTimeout', 40);

    // ── Route 53 private records → the internal ALB ───────────────────────────
    // We publish TWO names for the one ALB so the gateway can be baked to the
    // hostname CLIENTS actually bootstrap from (public_url drives the OIDC redirect,
    // so it MUST match what clients use) WHILE a stable, churn-free alias also exists:
    //
    //  • PRIMARY  = recordHost (whatever public_url is). At the zone apex this must be
    //    an ALIAS A-record (a CNAME is illegal at the apex — collides with SOA/NS);
    //    for a non-apex host it is a CNAME to the ALB DNS name.
    //  • SECONDARY = gw.<zoneName>, ALWAYS a CNAME to the ALB DNS name. A CNAME follows
    //    the ALB across replacements (the ALB DNS name is stable even when its private
    //    IPs change) and resolves cross-region — unlike a private-zone alias A-record.
    //    This is the durable name to migrate clients onto later; it costs nothing to
    //    keep published now. Skipped only when it would duplicate the primary.
    const norm = (h: string) => h.replace(/\.$/, '');
    const isApex = norm(recordHost) === norm(zoneName);
    const secondaryHost = props.secondaryHost ?? `gw.${zoneName}`;

    // IMPORTANT — distinct logical IDs per record TYPE. The primary host can be an
    // ARecord (apex) OR a CnameRecord (non-apex) depending on public_url. If BOTH
    // used one logical id (e.g. 'GatewayDns'), flipping public_url apex<->non-apex
    // would make CloudFormation mutate the SAME logical id from A to CNAME, which it
    // does as delete-old + create-new; on Route 53 that delete has, in practice,
    // raced and wiped the sibling gw. record (observed 2026-09-28). Giving each type
    // its own id ('...Apex' vs '...Host') makes a mode switch a clean create of the
    // new id + delete of the old id — never an in-place type mutation. Only one of
    // the two ever exists per deploy.
    if (isApex) {
      new route53.ARecord(this, 'GatewayDnsApex', {
        zone: privateZone,
        recordName: recordHost,
        target: route53.RecordTarget.fromAlias(new r53targets.LoadBalancerTarget(gatewayAlb)),
      });
    } else {
      new route53.CnameRecord(this, 'GatewayDnsHost', {
        zone: privateZone,
        recordName: recordHost,
        domainName: gatewayAlb.loadBalancerDnsName,
        ttl: cdk.Duration.seconds(60),
      });
    }

    // Secondary stable CNAME (gw.<zone>) — always published unless it equals the primary.
    if (norm(secondaryHost) !== norm(recordHost)) {
      new route53.CnameRecord(this, 'GatewayDnsSecondary', {
        zone: privateZone,
        recordName: secondaryHost,
        domainName: gatewayAlb.loadBalancerDnsName,
        ttl: cdk.Duration.seconds(60),
      });
    }

    // Restrict the ALB's 443 ingress to the VPN/corp client CIDR (not 0.0.0.0/0).
    // openListener:false above suppressed the pattern's default wide-open rule.
    fargate.loadBalancer.connections.allowFrom(
      ec2.Peer.ipv4(ingressCidr),
      ec2.Port.tcp(443),
      'developers to ALB (HTTPS)',
    );

    // ── ADOT collector sidecar (OTLP receiver → CW native OTLP metrics) ─────
    // Receives OTLP from the gateway on localhost:4318 and forwards to CloudWatch's
    // native OTLP endpoint using SigV4 via the task role.
    // Runs as a sidecar in the same task (no ALB listener, no extra SG).
    const adotConfig = [
      'extensions:',
      '  sigv4auth:',
      '    service: monitoring',
      `    region: ${this.region}`,
      'receivers:',
      '  otlp:',
      '    protocols:',
      '      http:',
      '        endpoint: 127.0.0.1:4318',
      'processors:',
      '  batch:',
      '    send_batch_size: 200',
      '    timeout: 10s',
      'exporters:',
      '  otlphttp:',
      `    metrics_endpoint: https://monitoring.${this.region}.amazonaws.com/v1/metrics`,
      '    auth:',
      '      authenticator: sigv4auth',
      '    compression: gzip',
      'service:',
      '  extensions: [sigv4auth]',
      '  pipelines:',
      '    metrics:',
      '      receivers: [otlp]',
      '      processors: [batch]',
      '      exporters: [otlphttp]',
    ].join('\n');
    fargate.taskDefinition.addContainer('otel-collector', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:latest'),
      essential: false, // gateway continues if the collector crashes; telemetry is non-critical
      environment: { AOT_CONFIG_CONTENT: adotConfig },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'otel', logGroup }),
      memoryReservationMiB: 128,
    });

    // Health check → /healthz (liveness). Keeps replicas in rotation during a
    // Postgres blip; pointing it at /readyz would drain all replicas at once.
    fargate.targetGroup.configureHealthCheck({
      path: '/healthz',
      healthyHttpCodes: '200',
    });

    // ── Admin web app: React SPA behind nginx (port 3000 on the same ALB) ────
    // A lightweight dashboard for gateway admin operations (spend limits, users,
    // audit). Authenticates via the gateway's device-auth flow. nginx proxies
    // /v1, /oauth, /.well-known to the gateway ALB and serves the SPA on /.
    //
    // GATED on adminReady (default false): the admin app is a WIP that shares the
    // gateway's imageTag. With no admin image pushed, the task can't pull an image
    // and its circuitBreaker:{rollback:true} rolls back the WHOLE stack update.
    // Keeping it off entirely until opted in lets the gateway deploy cleanly.
    if (adminReady) {
      // adminRepo is guaranteed defined here: both are gated on the same flag.
      const adminSg = new ec2.SecurityGroup(this, 'AdminSg', {
        vpc,
        description: 'Admin tasks: 3000 from the ALB only',
        allowAllOutbound: true,
      });

      const adminLogGroup = new logs.LogGroup(this, 'AdminLogGroup', {
        logGroupName: `/${gatewayName}/admin`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const adminTaskDef = new ecs.FargateTaskDefinition(this, 'AdminTaskDef', {
        cpu: 256,
        memoryLimitMiB: 512,
      });

      adminTaskDef.addContainer('admin', {
        image: ecs.ContainerImage.fromEcrRepository(adminRepo!, props.imageTag),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'admin', logGroup: adminLogGroup }),
        portMappings: [{ containerPort: 3000 }],
        environment: {
          // The ALB DNS name so nginx can proxy API calls to the gateway.
          GATEWAY_HOST: fargate.loadBalancer.loadBalancerDnsName,
        },
      });

      const adminService = new ecs.FargateService(this, 'AdminService', {
        cluster,
        serviceName: `${gatewayName}-admin`,
        taskDefinition: adminTaskDef,
        desiredCount: 1,
        securityGroups: [adminSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        assignPublicIp: false,
        circuitBreaker: { rollback: true },
        minHealthyPercent: 0, // single task, allow replacement
      });

      // Admin listener on port 3000 (HTTPS, same cert as :443).
      const adminListener = fargate.loadBalancer.addListener('AdminListener', {
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.TLS13_RES,
      });

      adminListener.addTargets('AdminTargets', {
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [adminService],
        healthCheck: {
          path: '/healthz',
          healthyHttpCodes: '200',
          interval: cdk.Duration.seconds(30),
        },
        deregistrationDelay: cdk.Duration.seconds(10),
      });

      // Allow ingressCidr → ALB on port 3000 (admin dashboard).
      fargate.loadBalancer.connections.allowFrom(
        ec2.Peer.ipv4(ingressCidr),
        ec2.Port.tcp(3000),
        'admins to ALB (admin dashboard)',
      );

      // Allow ALB → admin tasks on port 3000.
      adminSg.addIngressRule(
        fargate.loadBalancer.connections.securityGroups[0],
        ec2.Port.tcp(3000),
        'ALB to admin tasks',
      );

      // Allow the admin container → gateway ALB on 443. The admin nginx proxies
      // /oauth, /v1, /.well-known to the gateway (GATEWAY_HOST = the ALB DNS);
      // without this the admin task's traffic hits the ALB's 443 listener whose
      // SG only admits ingressCidr, so the proxy times out with a 504 at login.
      fargate.loadBalancer.connections.allowFrom(
        adminSg,
        ec2.Port.tcp(443),
        'admin container to gateway ALB (API proxy)',
      );

      // Admin dashboard URL (port 3000 on the same ALB).
      new cdk.CfnOutput(this, 'AdminUrl', {
        value: `https://${recordHost}:3000`,
        description: 'Admin dashboard URL (port 3000 on the same ALB)',
      });
    }

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', { value: fargate.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'PublicUrl', { value: publicUrl });
    new cdk.CfnOutput(this, 'OAuthRedirectUri', {
      value: `${publicUrl}/oauth/callback`,
      description: 'Register this redirect URI on your OIDC client',
    });
    new cdk.CfnOutput(this, 'TaskRoleArn', { value: taskRole.roleArn });
    new cdk.CfnOutput(this, 'RdsEndpoint', { value: dbHost });
    new cdk.CfnOutput(this, 'CertFingerprintHint', {
      value: `openssl s_client -connect ${recordHost}:443 -servername ${recordHost} | openssl x509 -noout -fingerprint -sha256`,
      description: 'Run this to get the cert SHA-256 to publish to developers (the CLI pins it)',
    });
  }
}

/** Fail synth with a clear message when a pass-2 required input is missing. */
function req(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required context "${name}". For pass 2 deploy with: ` +
        `-c publicUrl=... -c zoneName=... -c ingressCidr=... -c certArn=... ` +
        `(imported ACM cert for the gateway hostname). ` +
        `Or set imageReady=false for the pass-1 ECR-repo-only deploy.`,
    );
  }
  return value;
}
