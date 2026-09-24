import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface DbStackProps extends cdk.StackProps {
  /** Import an existing VPC (must match the gateway stack's VPC). In practice always
   *  pass the gateway's vpcId so the gateway can reach the DB. */
  readonly vpcId?: string;
  /** Database name (default 'claude_gateway'). */
  readonly dbName?: string;
}

/**
 * ClaudeGatewayDbStack - owns the gateway's PostgreSQL database on its OWN lifecycle,
 * SEPARATE from the gateway stack. Created by bin/app.ts ONLY when no DB_ENDPOINT is
 * provided (create-if-absent). Exports the endpoint, credentials-secret ARN, SG id,
 * and db name; the gateway stack consumes those and never owns an RDS resource itself.
 *
 * Hardened for durable data (admin spend-limits/audit/PII): multiAz, deletion
 * protection, 7-day backups, RETAIN.
 */
export class DbStack extends cdk.Stack {
  /** Stable CloudFormation export name for the DB security group id (imported by the gateway stack by name). */
  public static readonly SG_EXPORT_NAME = 'ClaudeGatewayDb-SecurityGroupId';

  public readonly dbEndpoint: string;
  public readonly dbSecretArn: string;
  public readonly dbSecurityGroupId: string;
  public readonly dbName: string;

  constructor(scope: Construct, id: string, props: DbStackProps = {}) {
    super(scope, id, props);

    const dbName = props.dbName ?? 'claude_gateway';
    const vpc = props.vpcId
      ? (ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId }) as ec2.IVpc)
      : new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    // Dedicated DB security group. The gateway grants its task SG 5432 ingress to THIS
    // group from the gateway side (no cross-stack circular dependency); created here
    // with no ingress, its id exported.
    const dbSg = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Claude gateway database - 5432 from the gateway task SG (added by the gateway stack)',
      allowAllOutbound: true,
    });

    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      databaseName: dbName,
      credentials: rds.Credentials.fromGeneratedSecret('gateway'),
      securityGroups: [dbSg],
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: true,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.dbEndpoint = db.dbInstanceEndpointAddress;
    this.dbSecretArn = db.secret!.secretArn;
    this.dbSecurityGroupId = dbSg.securityGroupId;
    this.dbName = dbName;

    new cdk.CfnOutput(this, 'DbEndpoint', { value: this.dbEndpoint });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: this.dbSecretArn });
    // Stable, explicit export name for the DB SG id. The gateway stack imports this
    // by NAME (cdk.Fn.importValue) rather than via a live cross-stack token, so CDK
    // never recomputes a usage-derived export name and never tries to prune an
    // in-use export (which previously deadlocked DbStack updates with
    // "Cannot delete export ... as it is in use by ClaudeGatewayStack").
    new cdk.CfnOutput(this, 'DbSecurityGroupId', {
      value: this.dbSecurityGroupId,
      exportName: DbStack.SG_EXPORT_NAME,
    });
    new cdk.CfnOutput(this, 'DbName', { value: this.dbName });
  }
}
