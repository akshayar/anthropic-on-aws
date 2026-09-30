# IdP Discovery — Questions for Tata AIG

*Their answers decide the gateway auth config. We built on Cognito; Tata AIG almost certainly runs Azure Entra ID (Azure/GCP-heavy, Unify.ai). Get these answers and we hand them the right config instead of guessing.*

**Scope for this proposal: the gateway for Claude Code + Chat via Bedrock.** Managed MCP / Desktop tools (web search) are a separate, later track — see the appendix, not part of the ask right now.

## 1 · Which IdP? (decides everything)

- **What is your corporate IdP** — Entra ID (Azure AD), Okta, Ping, Google Workspace, or something else?
- Is it the **same IdP** your developers use for Unify.ai / Azure / GCP today?
- Do you want devs to log in with **existing corporate SSO**, or is a standalone directory acceptable?

> *Why it matters:* Entra and Cognito differ in OIDC details (scope handling, claim names). The gateway supports OIDC generically, so this is a config change, not a rebuild — but we tune the binding to their IdP.

## 2 · Groups & claims (drives per-team policy)

- How are **teams modelled** — IdP groups, app roles, or an attribute? (engineering vs business vs contractors)
- Can the IdP emit **group/role claims in the token**, and what's the claim name? (Entra = `groups` or `roles`; Cognito = `cognito:groups`)
- Any limit on group claims in the token? (Entra caps at ~200 group IDs — needs the "groups overage" or app-role approach)

## 3 · OAuth app registration (gateway login)

- Can your IdP team register an **OIDC app client** for the gateway with an authorization-code flow?
- Who owns app registration — central IT, or can the platform team self-serve?
- **We provide the exact callback URI** (fixed HTTPS on the gateway's internal hostname, e.g. `https://claude-gateway.internal/oauth/callback` — the gateway derives it from `public_url`, not from us guessing). Can your IdP team **register that as an allowed redirect URI**? Any policy against redirect URIs on **internal (non-public) domains**? *(Not an open question about your redirect policy — it's "here's the value, can you allow-list it.")*

## 4 · Region, network & compliance

- Which **AWS region** for the gateway + Bedrock? (India data-residency — ap-south-1?)
- The gateway runs behind a **private (internal) ALB** — VPC-only, never internet-facing. **How will developers privately reach it?**
  - Corporate **VPN** into the VPC, **Direct Connect / Transit Gateway**, or **VPC peering** from their existing network?
  - How does **DNS resolution** work from the client network? A private hosted zone resolves only via the VPC `.2` resolver — a corp-DNS or AD-backed client needs a **Route 53 Resolver inbound endpoint + conditional forwarder** to resolve the gateway hostname.
- Insurance = regulated. Note the split: **we control the vault, the product controls what goes into it.** Ask:
  - **Retention / durability we set on our infra (no product change):** required RDS backup-retention window, deletion-protection, multi-AZ, and **CloudWatch log-retention** period (how long audit logs are kept)? Any long-hold archive requirement (S3 Object Lock / Glacier)?
  - **Encryption / access:** customer-managed **KMS key** for RDS + logs? Who may read the audit DB and logs?
  - **What the gateway captures (verified from its config + README):** prompt/tool-input **content is NOT logged or stored** — CloudWatch logs hold only boot/auth/error messages; telemetry is *metrics-only (no prompt content)*; the Postgres audit trail records auth events + admin actions (e.g. spend-cap changes). It **does** capture **user identifiers** (email / OIDC sub) for per-developer cost attribution and the auth/admin audit — that's identity, not message content. So "does it store our prompts?" → **no**; "does it store who used it and how much?" → **yes, by design**.

---

## The one that changes the recommendation most

**"Is it Entra ID?"** If yes, the Cognito-based config needs re-mapping (claim name, scope handling, group vs app-role strategy) — but the gateway supports OIDC generically, so it's a **config change, not a rebuild**.

Say it to them proactively: *"The pattern is proven; we tune the IdP binding to yours."*

---

## Appendix — Managed MCP / Desktop tools (NOT in scope yet)

> ⚠ **Do not raise these in the current proposal.** The Desktop MCP OAuth path (used to deliver tools like web search to Claude Desktop) relies on a **PKCE public client + loopback redirect**, and that approach is **not yet tested on this setup**. Keep it out of the customer conversation until validated in-house.

When/if managed MCP for Desktop becomes a track, these are the IdP questions to add:

- Can your IdP team register a **public / PKCE (secretless) app client** for the Desktop flow, with a loopback redirect (`http://127.0.0.1:<port>/callback`)?
- Any enterprise policy against **public clients** or **loopback redirect URIs**? (Some IdP hardening forbids both.)

*Rationale (internal):* Claude Desktop is a native app and can't hold a client secret, so its MCP OAuth uses PKCE. A secret-bearing client fails `invalid_client`. This is only relevant for the Desktop-MCP track — the core gateway login is a standard confidential OIDC client and needs none of it.
