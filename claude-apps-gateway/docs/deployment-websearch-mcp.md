# Deploy web search to Claude Desktop via an AgentCore Gateway MCP server

This is the **working recipe** for delivering a web-search tool to Claude Desktop
(engineering group) as a managed MCP server fronted by an Amazon Bedrock AgentCore
Gateway, authenticated with the same Cognito user pool the Claude Apps Gateway uses.

Verified live end-to-end on 2026-09-26 (Cognito pool `ap-south-1_lweAUOK9r`,
AgentCore gateway in `us-east-1`, gateway image `claude` 2.1.274).

---

## Why the moving parts exist (read this first)

Claude Desktop's managed MCP client, when the target server is OAuth-gated, sends
the **Cognito ACCESS token** on the MCP call (its protocol version-negotiation
probe uses it) — **not** the id_token. That single fact drives the whole config:

- A Cognito **access token** carries `client_id` and `scope`, but **no `aud`
  claim**. Therefore the AgentCore JWT authorizer must validate
  **`allowedClients`** (matches `client_id`) — **NOT `allowedAudience`** (which only
  matches an id_token's `aud` and never matches the access token).
- AgentCore validates the access token **as a resource server**, so a plain
  Cognito token (`scope: openid profile email`) is rejected with
  `insufficient_scope`. You must define a **Cognito resource server + custom scope**,
  request it, and list it in the gateway's **`allowedScopes`**.
- Desktop's PKCE flow sends **no client secret**, so the Cognito app-client must be
  a **PUBLIC client** (no secret). A confidential (secret-bearing) client fails the
  token exchange with `invalid_client_secret`.
- Cognito matches `redirect_uri` **exactly, including the port**, so Desktop's
  callback must be **pinned** to a fixed loopback port and that exact URI registered.

---

## Working configuration (live values)

**AgentCore Gateway** (`us-east-1`, `web-search-noauth-ekqe2qxv5u`):
- MCP URL: `https://web-search-noauth-ekqe2qxv5u.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp`
- Inbound auth: `CUSTOM_JWT`
- Authorizer:
  - `discoveryUrl`: `https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_lweAUOK9r/.well-known/openid-configuration`
  - `allowedClients`: `["e0h6vpqku8rehvufiv4r0mn80"]` (the Desktop PUBLIC client)
  - `allowedScopes`: `["websearch-gw/invoke"]`

**Cognito resource server** (pool `ap-south-1_lweAUOK9r`):
- Identifier `websearch-gw`, scope `invoke` -> full scope string `websearch-gw/invoke`

**Cognito public app-client for Desktop** (`e0h6vpqku8rehvufiv4r0mn80`):
- No client secret
- OAuth flow: `code` (PKCE), flows-user-pool-client enabled
- Scopes: `openid email profile websearch-gw/invoke`
- Callback URL: `http://127.0.0.1:8100/callback` (exact, port pinned)
- Logout URL: `https://claude-gateway.internal`

**Gateway policy** (`cdk/gateway.yaml.template`, engineering `desktop:` block):
```yaml
managedMcpServers:
  - name: web-search
    transport: http                 # Desktop takes an ARRAY; key is transport, not type
    url: https://web-search-noauth-ekqe2qxv5u.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp
    oauth:
      clientId: e0h6vpqku8rehvufiv4r0mn80        # PUBLIC client, no secret
      authorizationServer:
        - https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_lweAUOK9r
      scope: openid websearch-gw/invoke          # requests the resource scope
      callbackHost: 127.0.0.1                     # pin host + port so redirect_uri
      callbackPort: 8100                          # matches Cognito exactly
```
> Do NOT set `oauth.bearerTokenType` — gateway 2.1.274 rejects it as an unknown
> key and crash-loops the container at boot.

---

## Steps (from scratch)

1. **Create the Cognito resource server + scope**
   ```bash
   aws cognito-idp create-resource-server --region ap-south-1 \
     --user-pool-id ap-south-1_lweAUOK9r \
     --identifier websearch-gw --name "AgentCore WebSearch Gateway" \
     --scopes ScopeName=invoke,ScopeDescription="Invoke web-search MCP"
   ```

2. **Create the PUBLIC Desktop app-client** (no secret, PKCE, pinned callback)
   ```bash
   aws cognito-idp create-user-pool-client --region ap-south-1 \
     --user-pool-id ap-south-1_lweAUOK9r \
     --client-name claude-desktop-pkce --no-generate-secret \
     --callback-urls "http://127.0.0.1:8100/callback" \
     --logout-urls "https://claude-gateway.internal" \
     --allowed-o-auth-flows code \
     --allowed-o-auth-scopes openid email profile "websearch-gw/invoke" \
     --allowed-o-auth-flows-user-pool-client \
     --supported-identity-providers COGNITO \
     --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH
   ```
   Note the returned `ClientId` (used below as `<DESKTOP_CLIENT_ID>`).

3. **Set the AgentCore authorizer** to `allowedClients` + `allowedScopes`
   (auth TYPE stays `CUSTOM_JWT`, so this in-place config change is allowed)
   ```bash
   aws bedrock-agentcore-control update-gateway --region us-east-1 \
     --gateway-identifier web-search-noauth-ekqe2qxv5u \
     --name web-search-noauth \
     --role-arn <GATEWAY_SERVICE_ROLE_ARN> \
     --protocol-type MCP --authorizer-type CUSTOM_JWT \
     --authorizer-configuration '{"customJWTAuthorizer":{"discoveryUrl":"https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_lweAUOK9r/.well-known/openid-configuration","allowedClients":["<DESKTOP_CLIENT_ID>"],"allowedScopes":["websearch-gw/invoke"]}}'
   ```

4. **Add the MCP entry to the engineering `desktop:` block** in
   `cdk/gateway.yaml.template` (see the YAML above), with `oauth.clientId` =
   `<DESKTOP_CLIENT_ID>` and `scope: openid websearch-gw/invoke`.

5. **Redeploy the gateway image** (baked config) and **force an ECS rollout** so
   the running task serves the new config:
   ```bash
   # gateway-only deploy that skips the DB stack (see caveat below), then:
   aws ecs update-service --region ap-south-1 --cluster claude-gateway \
     --service claude-gateway --force-new-deployment
   ```
   `cdk deploy` alone with an unchanged `:latest` tag does NOT restart the tasks —
   you must force a new deployment for the new image to be pulled.

6. **On the Desktop machine:** ensure `bootstrapUrl` points at
   `https://claude-gateway.internal/user/bootstrap`, the user is in the
   **engineering** Cognito group (only that group's policy has a `desktop:` block;
   others 404), fully quit and relaunch Desktop, then complete the browser sign-in
   when web-search reconnects.

---

## Verify the gateway independent of Desktop

Mint a token for the public client (authorization_code or refresh_token grant,
region ap-south-1) and call `/mcp` with the **access token**:
```bash
curl -s -X POST <MCP_URL> \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```
- `HTTP 200` + `serverInfo` -> working.
- `HTTP 401 Invalid Bearer token` -> `allowedClients` doesn't match the token's `client_id`.
- `HTTP 403 insufficient_scope` -> the access token lacks `websearch-gw/invoke`, or
  the gateway's `allowedScopes` doesn't list it.
Negotiate protocol `2025-11-25` (the gateway rejects the older `2025-03-26` default).

---

## Caveats learned the hard way

- **`allowedAudience` is the wrong lever** for Desktop — the access token has no
  `aud`. Use `allowedClients`.
- **`oauth.bearerTokenType` fails boot** on gateway 2.1.274 (unknown key).
- **Confidential client -> `invalid_client_secret`**; use a public client.
- **Port must match** — Cognito exact-matches `redirect_uri` incl. port; pin
  `callbackPort` and register that exact loopback URI.
- **Gateway-only redeploys must skip the DB stack** — `cdk deploy --all` deadlocks
  on the in-use cross-stack export (`Cannot delete export ...DbSecretAttachment...
  in use`); deploy `ClaudeGatewayStack --exclusively` instead.
- **Keep `adminReady=true`** on gateway-only deploys or the admin app (`:3000`) is
  torn down (it is gated behind `adminReady`, default false).
