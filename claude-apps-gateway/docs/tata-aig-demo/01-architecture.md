# Claude Apps Gateway on Bedrock — Reference Architecture

*How a developer's Claude Code / Desktop request flows to Bedrock, governed the whole way.*

## Request flow

```
  👤  Developer / Employee
      Claude Code CLI + Claude Desktop — one `claude /login` via SSO
        │
        │  SSO login (OAuth / OIDC)
        ▼
  🪪  Identity Provider (IdP)
      Entra ID / Okta / Google / Cognito — issues token with GROUP CLAIMS.
      Groups drive policy.
        │
        │  bearer token (group-scoped)
        ▼
  🛡️  CLAUDE APPS GATEWAY  (Fargate behind internal ALB)
      ┌───────────────────────────┬───────────────────────────┐
      │ 🎯 Per-team policy         │ 💰 Spend caps              │
      │ engineering → all models   │ org / group / user         │
      │ business → Sonnet + Haiku  │ daily · weekly · monthly   │
      ├───────────────────────────┼───────────────────────────┤
      │ 📋 Audit + admin API       │ 🔌 Managed MCP             │
      │ who changed what           │ web search to Desktop,     │
      │ SSO-group admin UI         │ no extra infra             │
      └───────────────────────────┴───────────────────────────┘
        │
        │  SigV4 (IAM) upstream
        ▼
  🟠  Amazon Bedrock
      Claude Sonnet / Opus / Haiku via inference profiles —
      usage attributed per team
```

## Side channels

- **RDS Postgres** — durable spend-limits + audit + PII. Hardened: `RETAIN` · deletion-protection · multi-AZ · 7-day backup.
- **CloudWatch** — per-model / per-token metrics ("Coding Agent Insights").
- **Secrets Manager** — OIDC + JWT secrets.

## The one-line story for leadership

> One corporate login gets a developer into Claude Code and Desktop; from that point every request is policy-checked (which models this team may use), cost-capped (org/group/user budgets enforced *before* the call), and audited — then signed to Bedrock. No shared keys, no ungoverned spend.
