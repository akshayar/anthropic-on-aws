# Claude Apps Gateway — Customer Deployment Guide (Google Workspace)

This guide walks you through the prerequisites and deployment of the Claude Apps Gateway using Google Workspace as your identity provider. The gateway gives your developers Claude Code (and Claude Desktop) on AWS without putting AWS credentials on every machine.

---

## What you're deploying

A single internal service in your AWS VPC that:
- Authenticates developers via Google Workspace SSO
- Routes all Claude inference to Amazon Bedrock (no data leaves your AWS account)
- Provides per-user cost tracking and spend limits
- Includes an admin dashboard for managing users and budgets
- Requires no API keys or AWS credentials on developer machines

---

## Prerequisites checklist

Complete all items below before starting deployment. Each is a common failure point if missed.

### AWS account

- [ ] **AWS account with admin-level access** (IAM permissions to create VPC, ECS, ECR, RDS, ALB, IAM roles, Secrets Manager, Route 53 records, VPC endpoints)
- [ ] **Amazon Bedrock model access enabled** — In the AWS Console → Amazon Bedrock → Model access, request access for:
  - Claude Opus 5
  - Claude Sonnet 5
  - Claude Haiku 4.5
  
  > The gateway uses global cross-region inference profiles, so enable access in your primary region and any region the global profile may route to.

- [ ] **ACM certificate** for your chosen gateway hostname
  - Recommended: a **public** ACM certificate (DNS-validated) — even though the ALB is internal, DNS validation doesn't need a public endpoint. A public cert means developers get no fingerprint prompt on first login.
  - Note the certificate ARN.

- [ ] **Route 53 hosted zone** — either:
  - A public zone (simplest) where you'll add an A-record pointing to the internal ALB's private IPs
  - Or a private hosted zone (requires Route 53 Resolver for off-VPC DNS resolution)
  - Note the Zone ID and Zone Name.

- [ ] **VPN or Direct Connect** providing network connectivity from developer laptops to the VPC's private subnets
  - Know your **client CIDR** (the IP range developer traffic arrives from)
  - If using AWS Client VPN: the CIDR is actually the **VPC CIDR** (due to source-NAT), not the VPN client pool

### Google Workspace

- [ ] **Google Workspace admin access** to manage OAuth credentials
- [ ] **Google Cloud project** with OAuth consent screen configured:
  - User type: Internal (restricts to your org)
  - Scopes: `openid`, `profile`, `email`
- [ ] **OAuth 2.0 Client ID** (Web application type) created in Google Cloud Console → APIs & Credentials:
  - **Authorized redirect URI:** `https://<your-gateway-hostname>/oauth/callback`
  - Note the **Client ID** and **Client Secret**

  > ⚠️ The redirect URI must exactly match your gateway hostname. If it's wrong, SSO will fail with a redirect_uri_mismatch error.

- [ ] **(Optional) Google Groups** for role-based model access control
  - Create groups like `claude-admins@yourcompany.com`, `claude-users@yourcompany.com`
  - If you want group-based policies, you'll also need the Google Cloud Identity Groups API enabled

### Networking decisions

- [ ] **Choose a gateway hostname** (e.g., `claude-gateway.internal.yourcompany.com`)
  - Must resolve to a **private** IP from developer machines (the Claude CLI rejects public gateway addresses)
  - Developers must be able to reach it via VPN/Direct Connect
- [ ] **Know your VPN/client CIDR** — this is what the ALB security group allows inbound on port 443 and 3000

### Developer machines

- [ ] **Claude Code v2.1.195 or later** installed (recommend v2.1.199+)
  - Developers update with `claude update`
- [ ] **A way to push a JSON file to developer machines** (the managed-settings file that tells Claude Code where the gateway is):
  - macOS: Jamf, or manual placement
  - Windows: Intune, Group Policy
  - Linux: Ansible, Chef, Puppet, or manual

### Deployer's workstation

- [ ] AWS CLI v2 (configured with credentials for the target account)
- [ ] Node.js 18+
- [ ] Docker (or podman/finch)
- [ ] `jq`, `openssl`, `curl`

---

## Values to collect before starting

Fill in this table before running any deploy commands:

| Parameter | Your value | Example |
|-----------|-----------|---------|
| Gateway hostname | | `claude-gateway.internal.acme.com` |
| Route 53 Zone ID | | `Z0XXXXXXXXXXXXXXXXX` |
| Route 53 Zone Name | | `internal.acme.com` |
| ACM certificate ARN | | `arn:aws:acm:us-east-1:123456789012:certificate/abc-123` |
| VPN client CIDR | | `10.0.0.0/16` |
| AWS region | | `us-east-1` |
| Google OAuth Client ID | | `242196034593-xxxx.apps.googleusercontent.com` |
| Google OAuth Client Secret | | `GOCSPX-xxxxxxxxxxxx` |
| Allowed email domain(s) | | `acme.com` |

---

## Deployment steps (high level)

Once prerequisites are complete, deployment follows this sequence:

### Step 1 — Deploy infrastructure (CDK pass 1)

Creates ECR repositories for the gateway and admin images.

```bash
cd claude-apps-gateway/cdk
npm install
npx cdk bootstrap          # first time only
npx cdk deploy -c imageReady=false
```

### Step 2 — Build and push container images

**Gateway image** (the Claude binary + gateway.yaml config):
```bash
# Stamp config, download Claude binary, verify SHA, build distroless image, push to ECR
```

**Admin image** (React SPA + nginx):
```bash
docker build --platform=linux/amd64 -f admin-app/Dockerfile -t <AdminEcrUri>:latest .
docker push <AdminEcrUri>:latest
```

### Step 3 — Deploy full stack (CDK pass 2)

Creates VPC, ALB, RDS, ECS services, IAM roles, DNS record, VPC endpoints.

```bash
npx cdk deploy \
  -c publicUrl=https://<gateway-hostname> \
  -c zoneName=<zone-name> \
  -c zoneId=<zone-id> \
  -c certArn=<cert-arn> \
  -c ingressCidr=<vpn-cidr>
```

### Step 4 — Seed secrets and verify

```bash
# Set the Google OAuth client secret in Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id claude-gateway-oidc-client-secret \
  --secret-string '<google-client-secret>'

# Restart the service to pick up the secret
aws ecs update-service --cluster claude-gateway --service claude-gateway --force-new-deployment

# Verify
curl https://<gateway-hostname>/.well-known/oauth-authorization-server
curl -X POST https://<gateway-hostname>/oauth/device_authorization
```

### Step 5 — Push managed settings to developer machines

Deploy this JSON file to each developer's machine:

```json
{
  "forceLoginMethod": "gateway",
  "forceLoginGatewayUrl": "https://<gateway-hostname>"
}
```

| Platform | File path |
|----------|-----------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux / WSL | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

### Step 6 — Developers log in

Each developer runs:
```bash
claude /login
```
A browser opens → Google SSO → done. No API keys, no AWS credentials.

---

## Google Workspace-specific configuration

### gateway.yaml OIDC section

```yaml
oidc:
  issuer: https://accounts.google.com
  client_id: <your-google-client-id>.apps.googleusercontent.com
  client_secret: ${OIDC_CLIENT_SECRET}
  allowed_email_domains: [yourcompany.com]
  userinfo_fallback: true          # required for Google (id_token is sparse)
  scopes: [openid, profile, email]
  extra_auth_params:
    access_type: offline           # Google ignores offline_access; this gets refresh tokens
    prompt: consent                # ensures refresh token is issued on first sign-in

session:
  jwt_secret: ${GATEWAY_JWT_SECRET}
  ttl_hours: 1                     # offboarding latency bound
```

### Key differences from Entra/Okta

| Item | Google Workspace | Notes |
|------|-----------------|-------|
| Issuer URL | `https://accounts.google.com` | Same for all Google Workspace orgs |
| Refresh tokens | `access_type: offline` + `prompt: consent` | Standard `offline_access` scope is ignored |
| Group claims | Via `userinfo_fallback: true` + Groups API | Not in the id_token by default |
| One OAuth client | Covers both gateway and admin dashboard | No second app registration needed |

---

## What's NOT supported with Google Workspace

- **Claude Desktop bootstrap (PKCE mode)** — Google rejects the RFC 8707 `resource` parameter. If you need Claude Desktop config delivery, add Amazon Cognito as a PKCE bridge.
- **Native group claims in id_token** — groups require `userinfo_fallback: true` and the Cloud Identity Groups API enabled.

---

## Cost estimate

| Resource | ~Daily cost (idle) |
|----------|-------------------|
| VPC interface endpoints (6 × 2 AZs) | $2.90 |
| NAT gateway | $1.15 |
| ECS Fargate (2× gateway + 1× admin) | $1.30 |
| ALB | $0.60 |
| RDS db.t4g.micro | $0.45 |
| **Total infrastructure** | **~$6.40/day** |

Plus Amazon Bedrock inference at standard pay-per-token pricing (no markup from the gateway).

---

## FAQ

**Q: Do developers need AWS credentials?**
No. The gateway holds a single IAM role; developers authenticate with Google SSO only.

**Q: What if someone leaves the company?**
Disable them in Google Workspace. Their gateway session expires within 1 hour (configurable). No credential rotation needed.

**Q: Can we restrict who can use which models?**
Yes. Use `managed.policies` in gateway.yaml to map Google Groups to model allowlists. Without groups, all authenticated users get the same policy.

**Q: Can CI/CD use the gateway?**
No — the gateway requires browser SSO. CI/CD should use Bedrock directly with IAM credentials.

**Q: Is there a per-seat license?**
No. The gateway is open source. You pay only for AWS infrastructure (~$6/day) plus Bedrock inference.

**Q: Where's the admin dashboard?**
At `https://<gateway-hostname>:3000`. It authenticates via the same Google SSO device-auth flow. Access port 3000 over VPN.
