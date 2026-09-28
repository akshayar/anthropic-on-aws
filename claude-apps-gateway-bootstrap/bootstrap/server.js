// Claude Desktop / Cowork-3p bootstrap RESOURCE server (PKCE mode).
//
// Architecture (PKCE mode — bootstrapOidc set on the client):
//   The DESKTOP APP is a public client that runs its OWN authorization-code+PKCE flow against
//   your OIDC IdP (Amazon Cognito, Microsoft Entra, Okta, …), obtains an ACCESS TOKEN, and
//   presents it as `Authorization: Bearer` when fetching GET /user/bootstrap. This server is
//   an OAuth RESOURCE SERVER that applies two checks before returning a configuration:
//     1. Authentication — validate the token as a standard OIDC resource server (signature via
//        the IdP JWKS + iss + aud/client-id + exp). All IdP-specifics are CONFIG, not code
//        (OIDC_ISSUER / OIDC_JWKS_URI / OIDC_AUDIENCE / OIDC_AUDIENCE_CLAIM / OIDC_GROUPS_CLAIM).
//     2. Authorization  — confirm the caller is ENTITLED, via an optional group/role gate
//        (OIDC_REQUIRED_GROUPS / OIDC_REQUIRED_ROLES). Authentication proves who the caller
//        is; authorization decides whether they receive a configuration.
//
// Why PKCE (vs the earlier device-code single-origin design): device-code mode fences the
// bootstrap response — managedMcpServers whose URL is not same-origin as the bootstrap URL are
// DROPPED (observed: `bootstrap response contained cross-origin URL field(s); dropped`). That
// forced every managed MCP server to be reverse-proxied through our origin. PKCE mode DISABLES
// origin-pinning, so we deliver managed MCP servers with their REAL cross-origin URLs and their
// NATIVE auth (no proxy): a no-auth AgentCore search, an OAuth/Cognito SAPBW, a built-in M365,
// a future Databricks with its own inbound+outbound auth — each connects directly from the app.
//
// Inference is INDEPENDENT of bootstrap mode (per Anthropic docs): we keep
// inferenceProvider=gateway + inferenceCredentialKind=interactive, so the app does the Claude
// apps gateway's OWN device-code login for inference. The gateway is UNCHANGED — it does not
// (and cannot) validate the app's OIDC token; it remains the device-code auth server for
// inference. Net: two sign-ins at launch (OIDC PKCE for config/MCP + gateway device-code for
// inference), against the same IdP, same identity.
//
// Org plugins/skills: network delivery (organizationPluginsUrl) is NOT available in PKCE mode.
// Plugins ship via the filesystem org-plugins/ directory instead. We therefore do NOT emit
// organizationPluginsUrl here.

import express from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { getConfig } from './config.js';
import { isEntitled, parseList } from './authorize.js';

// ---- Config from environment ----
const PORT = parseInt(process.env.PORT || '8081', 10);
// Origin of the Claude apps gateway (unchanged) used for inferenceGatewayBaseUrl. In PKCE mode
// this need NOT be same-origin as the bootstrap server, but here they still share the gateway
// host — the app just authenticates to it via the gateway's own device-code login.
const PUBLIC_ORIGIN = required('PUBLIC_ORIGIN'); // e.g. https://claude-gw.example.com

// ---- Generic OIDC token validation (resource server) ----
// The desktop app runs its own auth-code + PKCE flow against ANY OIDC IdP (Amazon Cognito,
// Microsoft Entra, Okta, …), obtains an access token, and presents it as `Authorization:
// Bearer` to GET /user/bootstrap. We validate it as a standard OIDC resource server:
// signature via the IdP JWKS + issuer + audience/client-id + expiry. All IdP-specifics are
// CONFIG, not code:
//   OIDC_ISSUER      the token `iss` (e.g. https://cognito-idp.<region>.amazonaws.com/<poolId>
//                    or https://login.microsoftonline.com/<tenant>/v2.0)
//   OIDC_JWKS_URI    the IdP's JWKS endpoint. Optional — defaults to <issuer>/.well-known/jwks.json,
//                    which is correct for Cognito. Set explicitly for IdPs whose JWKS path
//                    differs from the issuer (Entra: /discovery/v2.0/keys).
//   OIDC_AUDIENCE    the expected audience / client id (the desktop public client's id).
//   OIDC_AUDIENCE_CLAIM  which claim carries the audience. Default 'aud' (OIDC id tokens, Entra).
//                    Cognito ACCESS tokens have no `aud` — the client id is in `client_id`, so
//                    set this to 'client_id' for Cognito access tokens.
//   OIDC_ADDITIONAL_ISSUERS  optional comma-separated extra accepted issuers.
//   OIDC_GROUPS_CLAIM  claim holding group memberships for the entitlement gate. Default
//                    'groups' (Entra); set 'cognito:groups' for Cognito.
// Back-compat: the legacy ENTRA_TENANT_ID / ENTRA_AUDIENCE / ENTRA_REQUIRED_* vars are still
// honoured (mapped onto the generic ones) so existing Entra deployments keep working.

const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID; // legacy convenience

// NO-AUTH mode (demo / trusted-network only). When OIDC_AUTH_DISABLED=true the server
// serves /user/bootstrap to ANY caller with NO token validation and NO entitlement gate.
// Use ONLY behind a trusted network boundary (e.g. an internal ALB / private VPC) and
// when the delivered config is itself non-sensitive (e.g. a no-auth managed MCP URL).
// It is fail-CLOSED: you must set the env var to the exact string "true" to turn it on.
const AUTH_DISABLED = process.env.OIDC_AUTH_DISABLED === 'true';

const OIDC_ISSUER = process.env.OIDC_ISSUER
  || (ENTRA_TENANT_ID ? `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0` : undefined);
if (!AUTH_DISABLED && !OIDC_ISSUER) throw new Error('Missing required env var: OIDC_ISSUER (or legacy ENTRA_TENANT_ID). Set OIDC_AUTH_DISABLED=true to run without auth.');

const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE || process.env.ENTRA_AUDIENCE;
if (!AUTH_DISABLED && !OIDC_AUDIENCE) throw new Error('Missing required env var: OIDC_AUDIENCE (or legacy ENTRA_AUDIENCE). Set OIDC_AUTH_DISABLED=true to run without auth.');

// Which claim carries the audience. Default 'aud'; Cognito ACCESS tokens use 'client_id'.
const OIDC_AUDIENCE_CLAIM = process.env.OIDC_AUDIENCE_CLAIM || 'aud';
// Which claim carries group memberships for the entitlement gate.
const OIDC_GROUPS_CLAIM = process.env.OIDC_GROUPS_CLAIM || 'groups';

// JWKS endpoint. Default to <issuer>/.well-known/jwks.json (correct for Cognito and most OIDC
// IdPs). For Entra, set OIDC_JWKS_URI explicitly or rely on the legacy tenant default.
const OIDC_JWKS_URI = process.env.OIDC_JWKS_URI
  || (ENTRA_TENANT_ID
    ? `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`
    : (OIDC_ISSUER ? `${OIDC_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json` : undefined));

// Accepted issuers: the primary one, plus explicit extras, plus the legacy Entra v1 issuer
// when only a tenant id was supplied (Entra issues v1 or v2 iss depending on the manifest).
const OIDC_ISSUERS = [
  ...(OIDC_ISSUER ? [OIDC_ISSUER] : []),
  ...parseList(process.env.OIDC_ADDITIONAL_ISSUERS),
  ...(ENTRA_TENANT_ID && !process.env.OIDC_ISSUER
    ? [`https://sts.windows.net/${ENTRA_TENANT_ID}/`]
    : []),
];

// Authorization (entitlement) gate. Authentication proves WHO the caller is; authorization
// decides whether they are ENTITLED. When either variable is set (comma-separated), a token
// must carry at least one matching value in the corresponding claim or the request is refused
// with 403. Both unset = every valid token from the issuer is served.
//   OIDC_REQUIRED_GROUPS — matched against the OIDC_GROUPS_CLAIM claim (e.g. cognito:groups)
//   OIDC_REQUIRED_ROLES  — matched against the `roles` claim (Entra app-role values)
const REQUIRED_GROUPS = parseList(process.env.OIDC_REQUIRED_GROUPS || process.env.ENTRA_REQUIRED_GROUPS);
const REQUIRED_ROLES = parseList(process.env.OIDC_REQUIRED_ROLES || process.env.ENTRA_REQUIRED_ROLES);

// IdP JWKS (cached + auto-refreshed by jose). Not built in no-auth mode.
const OIDC_JWKS = AUTH_DISABLED ? null : createRemoteJWKSet(new URL(OIDC_JWKS_URI));

const app = express();
app.disable('x-powered-by');

// Log every request path (concise; helps trace client behaviour in CloudWatch).
app.use((req, _res, next) => {
  console.log(`[bootstrap] req ${req.method} ${req.originalUrl}`);
  next();
});

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

// Validate the OIDC access token the app presents (PKCE mode). Checks signature against the
// IdP JWKS + issuer + audience/client-id + expiry. Returns the claims, or null (and sends 401)
// on any failure. Doc-specified contract: "Verify the bearer token's signature against your
// identity provider's JWKS, and check iss, aud, and exp." The audience is checked against
// OIDC_AUDIENCE_CLAIM because Cognito ACCESS tokens carry the client id in `client_id`, not `aud`.
async function requireToken(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    console.log('[bootstrap] 401 no bearer token');
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
  try {
    // Verify signature + issuer + expiry with jose. When the audience lives in the standard
    // `aud` claim, let jose enforce it; otherwise verify iss/exp here and check the custom
    // audience claim (e.g. Cognito `client_id`) explicitly below.
    const verifyOpts = { issuer: OIDC_ISSUERS };
    if (OIDC_AUDIENCE_CLAIM === 'aud') verifyOpts.audience = OIDC_AUDIENCE;
    const { payload } = await jwtVerify(token, OIDC_JWKS, verifyOpts);

    if (OIDC_AUDIENCE_CLAIM !== 'aud') {
      const got = payload[OIDC_AUDIENCE_CLAIM];
      const ok = Array.isArray(got) ? got.includes(OIDC_AUDIENCE) : got === OIDC_AUDIENCE;
      if (!ok) {
        console.log(`[bootstrap] 401 audience mismatch (${OIDC_AUDIENCE_CLAIM}=${got})`);
        res.status(401).json({ error: 'invalid_token' });
        return null;
      }
    }
    console.log(`[bootstrap] auth.ok sub=${payload.sub || '?'} email=${payload.email || payload.username || payload['cognito:username'] || payload.upn || '?'}`);
    return payload;
  } catch (e) {
    console.log(`[bootstrap] 401 token verify failed: ${e.message}`);
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
}

// Authorize an already-authenticated caller (entitlement logic in authorize.js).
// Returns true when entitled; otherwise sends 403 and returns false.
function authorize(claims, res) {
  if (isEntitled(claims, REQUIRED_GROUPS, REQUIRED_ROLES, OIDC_GROUPS_CLAIM)) return true;
  console.log(`[bootstrap] 403 not entitled sub=${claims.sub || '?'}`);
  res.status(403).json({ error: 'not_entitled' });
  return false;
}

// ---- Liveness ----
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- Per-user bootstrap config (v2). PKCE mode: origin-pinning is disabled. ----
app.get('/user/bootstrap', async (req, res) => {
  noStore(res);
  let claims = {};
  if (!AUTH_DISABLED) {
    claims = await requireToken(req, res);          // authN — proves who
    if (!claims) return;
    if (!authorize(claims, res)) return;            // authZ — proves entitled
  }
  // NO-AUTH mode: no token required, config served to any caller (see AUTH_DISABLED).
  const cfg = await getConfig();
  res.json({
    // Inference stays on the Claude apps gateway via its OWN device-code login (independent of
    // bootstrap mode). PKCE lifts origin-pinning, so this cross-origin gateway URL is allowed.
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: PUBLIC_ORIGIN,
    inferenceCredentialKind: 'interactive',
    inferenceModels: cfg.inferenceModels,
    // Governance: when false, BARS user-added (local/stdio) MCP servers so ONLY the managed
    // servers below are available. Omit in the S3 config to keep the client default (true).
    ...(cfg.allowUserAddedMcpServers === undefined
      ? {}
      : { isLocalDevMcpEnabled: cfg.allowUserAddedMcpServers }),
    // Surface toggles (bootstrap-config-v2 schema): chatTabEnabled / coworkTabEnabled /
    // isClaudeCodeForDesktopEnabled. Emitted only when set in the S3 config so an omitted
    // key keeps the client default.
    ...(cfg.chatTabEnabled === undefined ? {} : { chatTabEnabled: cfg.chatTabEnabled }),
    ...(cfg.coworkTabEnabled === undefined ? {} : { coworkTabEnabled: cfg.coworkTabEnabled }),
    ...(cfg.isClaudeCodeForDesktopEnabled === undefined
      ? {}
      : { isClaudeCodeForDesktopEnabled: cfg.isClaudeCodeForDesktopEnabled }),
    // Disable the app's BUILT-IN server-side web search (Anthropic web_search_20250305 tool,
    // executed by the inference provider). Bedrock rejects that tool type with a 400, so chat
    // burns two failed attempts before falling back to the managed web-search MCP. False =
    // go straight to the MCP. Mirrors the CLI-side `permissions.deny: [WebSearch]` in
    // gateway.yaml — same reason, different surface.
    ...(cfg.coworkWebSearchEnabled === undefined
      ? {}
      : { coworkWebSearchEnabled: cfg.coworkWebSearchEnabled }),
    // Governance knobs (schema v2), passed through verbatim when set in the S3 config so
    // future flips are config-only. banner: org banner bar. disableNonessentialTelemetry:
    // blocks Segment + event_logging (no message content either way). disableNonessential-
    // Services: ALSO kills artifact previews + connector icons — leave unset/false unless a
    // security review demands it. disabledBuiltinTools/builtinToolPolicy: remove or gate
    // built-in tools app-wide. Token-window keys: client-side token cap per rolling window.
    ...Object.fromEntries(
      [
        'banner',
        'disableNonessentialTelemetry',
        'disableNonessentialServices',
        'disabledBuiltinTools',
        'builtinToolPolicy',
        'isDesktopExtensionSignatureRequired',
        'inferenceMaxTokensPerWindow',
        'inferenceTokenWindowHours',
        'allowedWorkspaceFolders',
      ]
        .filter(k => cfg[k] !== undefined)
        .map(k => [k, cfg[k]]),
    ),
    // Org-wide managed MCP servers, emitted under the published bootstrap-config
    // schema's flat `managedMcpServers` key. Per the platform contract, the bootstrap
    // overlay's value REPLACES (never merges with) any static MDM-tier value, so this
    // response owns the whole fleet; omit `managedMcpServers` in the S3 config to
    // leave the key out entirely. Entry kinds:
    //   1. BUILT-IN (`server`): in-process connector (microsoft365, websearch) — verbatim.
    //   2. OAUTH remote (`oauth`): client runs its own OAuth code+loopback flow, connects
    //      directly to the real url with its own token.
    //   3. NO-AUTH remote: plain remote HTTP/SSE endpoint (PKCE mode = no origin-pinning).
    ...((cfg.managedMcpServers ?? cfg.mcpServers) === undefined ? {} : {
      managedMcpServers: (cfg.managedMcpServers ?? cfg.mcpServers).map(s => {
        if (s.server) {
          const { upstream, url, transport, ...builtin } = s;
          return builtin;
        }
        const out = {
          name: s.name,
          transport: s.transport || 'http',
          // Accept either `url` (native) or legacy `upstream` (proxy-era config) as the
          // real endpoint. No rewriting — the client connects here directly.
          url: s.url || s.upstream,
        };
        if (s.oauth) out.oauth = s.oauth;
        if (s.headers) out.headers = s.headers;
        if (s.toolPolicy) out.toolPolicy = s.toolPolicy;
        return out;
      }),
    }),
    coworkEgressAllowedHosts: cfg.coworkEgressAllowedHosts || ['*.internal.claude.local'],
    // OTLP export (Desktop/Cowork): pass through whatever collector endpoint the S3
    // config names. With claude-apps-gateway, point it at the gateway ALB's :4318 OTLP
    // listener (the stack's OtelForwardTo output) — the same ADOT collector the gateway
    // pushes CLI telemetry to.
    ...(cfg.otlpEndpoint === undefined ? {} : { otlpEndpoint: cfg.otlpEndpoint }),
    ...(cfg.otlpProtocol === undefined ? {} : { otlpProtocol: cfg.otlpProtocol }),
    ...(cfg.otlpHeaders === undefined ? {} : { otlpHeaders: cfg.otlpHeaders }),
    // Static attributes from S3 config merge under the per-user identity stamp.
    otlpResourceAttributes: {
      ...(cfg.otlpResourceAttributes || {}),
      'user.email': String(claims.email || claims.upn || ''),
    },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    // NOTE: organizationPluginsUrl intentionally omitted — network plugin delivery is not
    // available in PKCE mode. Org plugins/skills ship via the filesystem org-plugins/ directory
    // (/Library/Application Support/Claude/org-plugins/ on macOS).
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(AUTH_DISABLED
    ? `[bootstrap] resource server listening on 0.0.0.0:${PORT}, origin=${PUBLIC_ORIGIN}, AUTH DISABLED (no token required — trusted-network/demo mode)`
    : `[bootstrap] PKCE resource server listening on 0.0.0.0:${PORT}, origin=${PUBLIC_ORIGIN}, iss=${OIDC_ISSUER}, aud=${OIDC_AUDIENCE} (${OIDC_AUDIENCE_CLAIM}), groupsClaim=${OIDC_GROUPS_CLAIM}`);
});
