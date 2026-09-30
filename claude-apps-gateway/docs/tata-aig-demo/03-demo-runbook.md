# Live Demo Runbook — Click Path & Fallback

*Exact click path for the Gurgaon session. Each step ties to a governance message.*

## ⚠ Reachability — confirm BEFORE the day

The admin app is behind the **internal ALB** (`claude-gateway.internal`, ap-south-1). From a Gurgaon room you need VPN/VPC access.

**Fallback:** record a screen capture of the full flow in advance — never demo live on an unproven network.

## Click path

1. **Login via SSO** — click *Login with SSO*, land as a `gateway-admins` member.
   > *"Access is driven by your corporate identity + group — no shared keys."*

2. **Show per-team model policy** — engineering gets all models, business gets Sonnet + Haiku.
   > *"Teams get exactly the models they should — governed centrally."*

3. **Spend Limits → + New Limit** — flip Scope org → group → user; show the group autocomplete (engineering / business).
   > *"Cost caps at any granularity, enforced before the request hits Bedrock."*

4. **Users page → blocked user → ↑ Raise cap** — one click lifts a blocked developer.
   > *"Governance in action — not just dashboards, real operational control."* **(This is the moment leadership remembers.)**

5. **Click a user's email → drilldown** — spend vs cap across daily / weekly / monthly.
   > *"Full cost accountability per person."*

6. **Audit page** — show who changed which cap.
   > *"Every governance action is logged — audit-ready."*

*(Managed MCP / Desktop web search is deliberately NOT in this demo — that path is untested on this setup. Add it only once validated in-house.)*

## Pre-flight (day before)

- Hard-refresh admin app (loads the new bundle).
- Seed 2–3 users with spend so `/effective` returns rows.
- Pre-create one **zero-cap user** so the *blocked → raise* flow is guaranteed to fire.
- Test VPN from the actual room network.
- Have the recording ready as fallback.
