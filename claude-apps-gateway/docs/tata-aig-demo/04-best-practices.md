# Gateway Best Practices — Hard-Won Gotchas

*Distilled from what actually bit us building this — the things a customer's team will hit.*

### 🔐 Auth: standard OIDC for the gateway
The gateway login (`claude /login` → gateway → Bedrock) is a standard OIDC authorization-code flow with the gateway as a **confidential client**. Match the IdP's claim names for group-based policy (Cognito = `cognito:groups`; Entra = `groups`/`roles`).

### 💾 Harden RDS from day one
Once admin / spend-limits are on, Postgres holds durable spend + audit + PII. Set `removalPolicy RETAIN`, deletion-protection, multi-AZ, 7-day backup **in the same deploy** — before storing anything real.

### 🚀 Redeploys don't self-restart
Reusing the `:latest` tag leaves ECS on the old task — CloudFormation reports `UPDATE_COMPLETE` but the change isn't live. Always `force-new-deployment` and verify the task `startedAt` is post-deploy.

### 🧩 Gateway-only redeploys
Carry `adminReady=true` or a surgical deploy silently tears down the whole admin tier (`:3000` UI, ECR repo, roles). Use `--exclusively`, never `--all` (deadlocks on the in-use DB export).

### ⚙️ Config validated at boot
An unrecognized `desktop:` sub-key **crash-loops** the gateway (not a warning). Confirm the deployed gateway version supports any new Desktop config key before baking it in.

### 👥 SSO-group admin, no API keys
Set `admin_groups:[gateway-admins]` + `groups_claim: cognito:groups`; omit the API-key vars or the container crash-loops.

---

*Note: the group-claim name is IdP-specific (`cognito:groups` for Cognito, `groups`/`roles` for Entra). If the customer runs Entra ID, the equivalents change — see the IdP discovery sheet.*

---

## Appendix — Managed MCP / Desktop tools (NOT tested yet, out of scope)

> ⚠ **Not validated on this setup — keep out of the customer proposal until tested in-house.**

For the Desktop-MCP track (delivering tools like web search to Claude Desktop):

- Claude Desktop sends the **access token** (client_id + scope, *no* `aud` claim), so the MCP authorizer uses `allowedClients` + `allowedScopes` — **not** `allowedAudience`.
- Desktop's MCP OAuth is **PKCE** — needs a **public client** (no secret; a secret-bearing client fails `invalid_client`) + a **loopback redirect**.
- The in-gateway `desktop.managedMcpServers` block is the intended delivery path (no separate bootstrap server) — but confirm end-to-end before proposing it.
