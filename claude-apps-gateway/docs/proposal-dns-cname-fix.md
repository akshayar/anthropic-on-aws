# Proposal — kill the internal-ALB IP-churn with a non-apex CNAME

## The problem (why you keep re-adding IPs)

Every time the gateway's internal ALB is **replaced** (many redeploys replace it), it
gets **new private IPs**. The current DNS record is an **alias A-record to the ELB**
(`setup.sh` §6d: `AliasTarget` → ALB DNS). Two failure modes follow:

1. **Cross-region alias doesn't resolve.** An alias-to-ELB in a *private* hosted zone
   only resolves within the ELB's own region. A resolver in another region gets
   NXDOMAIN — so the fallback becomes pinning the ALB's **literal private IPs** in a
   plain A-record or `/etc/hosts`.
2. **Pinned IPs go stale on the next deploy.** New ALB → new IPs → the record (or
   `/etc/hosts`) silently points at dead IPs → connect timeouts. That's the manual
   "add the IP address again" step you keep hitting.

The CDK stack itself creates **no** DNS record (it only looks up the zone), so nothing
owns a stable record — which is why the churn recurs.

## The fix

Replace the alias/literal-IP record with a **non-apex CNAME to the ALB's DNS name**:

```
gw.claude-gateway.internal.  CNAME  internal-Claude-Gatew-xxxx.ap-south-1.elb.amazonaws.com
```

- A **CNAME follows the ALB across replacements** — the ALB DNS name is stable even when
  its IPs change, so **no more re-pinning, ever**.
- A CNAME to the ELB DNS name **resolves cross-region** (unlike the alias).

### The one hard constraint: CNAME cannot sit at the zone apex

Your current hostname `claude-gateway.internal` **is the apex** of that zone, and a
CNAME at a zone apex is illegal (it collides with SOA/NS). So the fix requires a
**non-apex hostname**, e.g. `gw.claude-gateway.internal`. This is a hostname change, and
`PUBLIC_URL` is the single value that drives **four** things:

| Driven by PUBLIC_URL | Impact of the hostname change |
| --- | --- |
| Route 53 record name | new CNAME at the new name |
| OIDC `redirect_uri` (`<PUBLIC_URL>/oauth/callback`) | must be re-registered in Cognito |
| ACM certificate hostname | cert must cover the new hostname (SAN or reissue) |
| Baked `public_url` in the image | requires an image rebuild + rollout |

Because the CLI **pins the cert fingerprint per hostname on first `/login`**, every
developer re-confirms the fingerprint once after the migration.

## Migration steps (one-time)

1. **Pick the non-apex hostname** — e.g. `gw.claude-gateway.internal`.
2. **Cert:** import/reissue an ACM cert whose SAN covers the new hostname (keep the old
   name too during transition if you want a cutover window).
3. **Cognito:** add `https://gw.claude-gateway.internal/oauth/callback` to the gateway
   OIDC client's allowed callback URLs (re-supply the full existing callback/scope/flow
   set — `update-user-pool-client` replaces the whole config; hand that command over
   rather than clobbering it).
4. **Redeploy** with `PUBLIC_URL=https://gw.claude-gateway.internal` → stamps the new
   `public_url`, rebuilds the image, rolls out ECS (force-new-deployment).
5. **DNS:** replace the apex alias A-record with a **CNAME** `gw.claude-gateway.internal
   → <ALB DNS name>`. (Handed over: `route53 change-resource-record-sets` is a mutation
   on live DNS.)
6. **Clients:** point Desktop/CLI at the new hostname; each dev re-confirms the cert
   fingerprint once on next `/login`.

## Code changes required

- **`setup.sh` §6d** — swap the `AliasTarget` A-record UPSERT for a `CNAME` record whose
  value is the ALB DNS name (only valid for a non-apex `RECORD_NAME`; keep a guard that
  errors if `RECORD_NAME` equals the zone apex).
- **CDK (`claude-gateway-stack.ts`)** — optionally own the record in-stack as a
  `route53.CnameRecord` targeting the ALB DNS name, so the record is managed and never
  drifts. (Today the stack creates none.)
- **`DB_SPLIT_PLAN.md`** — remove the stale "re-point A-record to the new ALB IPs;
  refresh /etc/hosts" recovery note once the CNAME is in place.

## Decision: cross-region is possible → non-apex CNAME (chosen)

Because resolution **could be cross-region** (multi-region as the Azure/GCP→AWS migration
proceeds, or a resolver/WorkSpace in another region), the apex is a dead end:

- **Apex + alias** → does not resolve cross-region (NXDOMAIN from another region).
- **Apex + literal IPs** → the churn you keep hitting (new IPs every ALB replacement).
- **Non-apex + CNAME** → follows the ALB by name (no churn) **and** resolves cross-region.

Only the non-apex CNAME satisfies both constraints, so that is the recommended solution.

### Second gotcha cross-region brings (don't miss it)

A private hosted zone resolves **only through the associated VPC's `.2` resolver**. A
CNAME fixes the *record*, but a client in another region (or an AD-backed WorkSpace on
corp DNS) still won't reach the `.2` resolver of the gateway's VPC. For a fleet, that
needs a **Route 53 Resolver inbound endpoint** in the gateway VPC + a **conditional
forwarder** from the client network's DNS to it. The CNAME and the resolver path are
**both** required for cross-region — fixing only the record leaves it unresolved.

## Zero-downtime cutover (old hostname stays live during migration)

Keep `claude-gateway.internal` working until every client moves, so nobody is locked out:

1. **Cert** — reissue/import an ACM cert whose SANs cover **both** the old apex name and
   the new `gw.claude-gateway.internal`. Attach it to the ALB listener.
2. **Cognito** — **add** (don't replace) `https://gw.claude-gateway.internal/oauth/callback`
   alongside the existing apex callback (re-supply the full existing config — the update
   API clobbers omitted fields; hand that command over).
3. **New CNAME** — create `gw.claude-gateway.internal → <ALB DNS name>` while the old apex
   alias still exists. Both names now resolve to the same ALB.
4. **Redeploy** with `PUBLIC_URL=https://gw.claude-gateway.internal` (stamps public_url,
   rebuilds image, force-new-deployment). The gateway now issues redirects on the new
   name; the old name still routes to the ALB for anyone mid-migration.
5. **Migrate clients** — point Desktop/CLI at the new hostname; each dev re-confirms the
   cert fingerprint once on next `/login`.
6. **Retire the apex** — once no client uses it, delete the apex alias A-record and drop
   the old SAN/callback. (Handed over: live-DNS + live-auth mutations.)

## Recommendation

**Migrate to the non-apex CNAME** — it is the only option that is churn-free under ALB
replacement AND resolves cross-region, and the cutover above keeps the old name live so
there is no lockout. Pair it with the Route 53 Resolver inbound endpoint for any
cross-region client network. Staying on the apex would force either the churn (literal
IPs) or a cross-region resolution failure, so it is not the best solution here.
