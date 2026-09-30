# Which gateway for Claude on Bedrock? — Decision Matrix

*The three patterns are not competitors — they occupy different lanes. Recommendation at the bottom.*

| Dimension | **Claude Apps Gateway** (what we built) | Bedrock-native controls | Unify.ai (their existing layer) |
|---|---|---|---|
| **Purpose** | Governs **Claude Code + Desktop** specifically | Governs **any** Bedrock workload | Cross-cloud model routing + monitoring (Azure/GCP/AWS) |
| **SSO / per-team model access** | ✔ Built-in, group-driven | △ IAM policies (coarser, no dev-friendly login) | △ Platform-dependent |
| **Spend caps (org/group/user)** | ✔ Enforced pre-request + admin UI | △ Budgets alert, don't hard-block | ✔ Its own quota model |
| **Claude Code login UX** | ✔ One `claude /login`, native | ✘ Manual creds / env plumbing | △ Via platform, not native |
| **Managed MCP (web search etc.)** | ✔ Delivered to Desktop | ✘ Not its job | ✘ Not its job |
| **Multi-cloud reach** | ✘ AWS/Bedrock only | ✘ AWS only | ✔ Azure + GCP + AWS |
| **Ops to run** | △ You own Fargate + RDS + Cognito | ✔ Fully managed | ✔ SaaS |

Legend: ✔ strong fit · △ partial / caveat · ✘ not a fit

## Recommendation — clear lanes, no overlap

- **Claude Apps Gateway** for the Claude Code / Desktop consumption path — it's native, dev-friendly, and enforces caps + policy per team.
- **Bedrock-native controls** (IAM, Guardrails, Cost Explorer, inference profiles) for the wider Azure/GCP → AWS workload migration.
- **Unify.ai stays** as the cross-cloud umbrella — the Claude gateway sits *under* it for the Bedrock-Claude slice, not replacing it.

The honest framing for the room: *Claude gateway for Claude Code consumption; Bedrock-native controls for the wider migrated workloads; Unify.ai as the multi-cloud umbrella. No overlap, clear lanes.*
