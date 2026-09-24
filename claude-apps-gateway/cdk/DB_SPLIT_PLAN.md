# DB-split refactor plan — two stacks, single `deploy.sh`, param-driven

## Goal
Decouple the RDS database from the gateway so gateway redeploys never touch the DB.
Achieve it with **two CloudFormation stacks** — a dedicated `ClaudeGatewayDbStack`
and the existing `ClaudeGatewayStack` — both driven by the **one `deploy.sh` run**.
A parameter decides the DB source:

- **`DB_ENDPOINT` provided** (in `.env`) → gateway **references** that existing DB;
  `DbStack` is NOT created. (create-if-absent / reference-if-provided)
- **`DB_ENDPOINT` absent** → `DbStack` is created (owns the RDS instance, subnet
  group, DB SG, DB secret), and the gateway consumes its exports.

Either way it is one `deploy.sh` invocation; the flag only changes which stacks synth.

## Parameter contract (new context vars, all optional)
| .env key | -c context | meaning |
|---|---|---|
| `DB_ENDPOINT` | `dbEndpoint` | existing RDS endpoint host. If set → reference mode. |
| `DB_SECRET_ARN` | `dbSecretArn` | Secrets Manager ARN of the DB creds (username/password JSON). Required in reference mode. |
| `DB_SG_ID` | `dbSecurityGroupId` | the DB's security group id, so the gateway task SG can be granted 5432 ingress to it. Required in reference mode. |
| `DB_NAME` | `dbName` | database name (default `claudegateway`). |

## Files

### NEW: `lib/db-stack.ts`  (`ClaudeGatewayDbStack`)
- Props: `vpc` (or `vpcId`+`albSubnetIds`-style selection), `taskSecurityGroupId?`
  (optional — cross-stack SG ingress can also be added from the gateway side).
- Creates: `rds.DatabaseInstance` (Postgres 16, db.t3.micro, multiAz, gp3, encrypted,
  **RETAIN + deletionProtection true + 7-day backups** — the hardened settings that
  currently live in the gateway stack), its subnet group, a DB SG, and uses
  `rds.Credentials.fromGeneratedSecret('gateway')`.
- **CfnOutputs** (exported for the gateway stack): `DbEndpoint`, `DbSecretArn`,
  `DbSecurityGroupId`, `DbName`.

### EDIT: `lib/claude-gateway-stack.ts`
- Add props: `dbEndpoint?`, `dbSecretArn?`, `dbSecurityGroupId?`, `dbName?`.
- Replace the current unconditional `new rds.DatabaseInstance(this,'Db',{...})` block
  with a branch:
  - **reference mode** (`props.dbEndpoint` set):
    - `DB_HOST = props.dbEndpoint`
    - `dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this,'DbSecret',props.dbSecretArn!)`
    - import the DB SG: `ec2.SecurityGroup.fromSecurityGroupId(this,'DbSg',props.dbSecurityGroupId!)`
      and add ingress `dbSg ← taskSg : 5432` (from the gateway side, so no cross-stack
      circular dependency).
    - do NOT create any RDS resource.
  - **create mode** (no `dbEndpoint`): keep today's inline `DatabaseInstance` (so the
    single-stack path still works standalone if someone doesn't want two stacks) OR
    require DbStack — **decision D1 below**.
- `DB_HOST` env, `DB_USER`/`DB_PASSWORD` secrets: sourced from whichever branch.

### EDIT: `bin/app.ts`
- Read the 4 new context vars.
- Conditionally instantiate `ClaudeGatewayDbStack` when `dbEndpoint` is NOT provided;
  pass its outputs into `GatewayStack` via stack references (same app, so CDK wires
  the cross-stack exports automatically and orders the deploys).
- When `dbEndpoint` IS provided, only `GatewayStack` is added, in reference mode.

### EDIT: `scripts/deploy.sh`
- Map `.env` → `-c`: `DB_ENDPOINT→dbEndpoint`, `DB_SECRET_ARN→dbSecretArn`,
  `DB_SG_ID→dbSecurityGroupId`, `DB_NAME→dbName`.
- `cdk deploy` **`--all`** (instead of the single stack) so both stacks deploy in one
  run when DbStack exists; CDK deploys `DbStack` first (dependency order) automatically.
- Pass-1 (imageReady=false) / pass-2 logic unchanged; DbStack is unaffected by imageReady.

## Adopting the CURRENT running DB (zero data loss) — recommended first move
Rather than delete/recreate, **adopt the live DB into reference mode**:
1. Put in `.env`:
   - `DB_ENDPOINT=claudegatewaystack-db5d02a0a9-1bny7nb3pxob.cntgfu50evyo.ap-south-1.rds.amazonaws.com`
   - `DB_SECRET_ARN=arn:aws:secretsmanager:ap-south-1:229369268201:secret:ClaudeGatewayStackDbSecret4-E1M8PUlO2ZDp-dh7H19`  (verify exact ARN at deploy time)
   - `DB_SG_ID=sg-0f0d856d2b29bc72a`
   - `DB_NAME=claudegateway`
2. Deploy: the gateway stack drops its `DatabaseInstance` resource. **CAUTION**: with
   `RETAIN`, CFN removes the DB from the gateway stack WITHOUT deleting it — but this
   re-triggers the RETAIN'd-SG cleanup wedge (the DB SG delete fails because the
   RETAIN'd instance still holds it; settles on its own, can wedge the stack in
   UPDATE_COMPLETE_CLEANUP_IN_PROGRESS for a while). Known, non-destructive.
3. Result: the SAME live DB (data intact, spend limits preserved), now referenced not
   managed by the gateway stack. Future gateway redeploys never touch it.

## Orphan cleanup (separate, destructive — user runs)
The RETAIN'd orphan `claudegatewaystack-db5d02a0a9-qoorodgqm8xh` (SG sg-03e0b2ac8feaddffd)
is unused and still billing (multiAz db.t3.micro). To remove (user runs — RDS delete
is policy-blocked for Kiro):
```
aws rds modify-db-instance --db-instance-identifier claudegatewaystack-db5d02a0a9-qoorodgqm8xh \
  --no-deletion-protection --apply-immediately --region ap-south-1
aws rds delete-db-instance --db-instance-identifier claudegatewaystack-db5d02a0a9-qoorodgqm8xh \
  --skip-final-snapshot --delete-automated-backups --region ap-south-1
```

## Open decisions
- **D1 — create mode source:** when `dbEndpoint` absent, should the gateway create the
  DB *inline* (single stack) or *always via DbStack* (two stacks)? Your ask = **two
  stacks**, so: create mode = instantiate `DbStack`; gateway is ALWAYS reference-mode
  internally (consumes endpoint/secret/SG from either DbStack outputs or .env). This is
  the cleanest — the gateway stack NEVER contains an RDS resource. Recommended.
- **D2 — adopt vs recreate:** adopt the current DB via reference mode (no data loss,
  recommended) — or accept the delete+recreate you OK'd (fresh empty DB, re-add the
  two $1 limits). Adopt is strictly better now that reference mode exists.

## Deploy sequence (single run)
1. `.env` gets DB params (adopt) OR is left blank (create → DbStack).
2. `./scripts/deploy.sh` → `cdk deploy --all` → DbStack (if any) then GatewayStack.
3. Re-point Route53 A-record to the new ALB IPs (ALB replaced as usual); refresh /etc/hosts.
4. (optional, user) delete the orphan DB.

## Verification
- `cdk synth --all` clean; GatewayStack template contains **no** `AWS::RDS::DBInstance`
  in reference mode (grep the template).
- Both ECS services healthy; `gw-limits.sh list` returns (limits preserved if adopted).
