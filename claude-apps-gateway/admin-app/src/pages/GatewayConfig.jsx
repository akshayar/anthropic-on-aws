import { useState, useEffect } from 'react'
import { client } from '../api'
import { GATEWAY_CONFIG } from '../gatewayConfig'

/**
 * Gateway Config — shows the CURRENT live gateway configuration:
 *   • Identity & OAuth endpoints  (from /.well-known/oauth-authorization-server)
 *   • Delivered Desktop config    (from /user/bootstrap): models + managed MCP servers
 *   • Raw bootstrap JSON          (collapsible)
 *
 * All read-only. bootstrap requires the admin's IdP group to carry a `desktop:`
 * block in gateway.yaml; otherwise the gateway 404s that endpoint (shown as a hint).
 */
export default function GatewayConfig() {
  const [discovery, setDiscovery] = useState(null)
  const [bootstrap, setBootstrap] = useState(null)
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [bootstrapErr, setBootstrapErr] = useState(null)
  const [showRaw, setShowRaw] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    setBootstrapErr(null)
    const [d, h] = await Promise.allSettled([client.discovery(), client.health()])
    setDiscovery(d.status === 'fulfilled' ? d.value : null)
    setHealth(h.status === 'fulfilled' ? h.value : { healthy: false })
    try {
      setBootstrap(await client.bootstrap())
    } catch (e) {
      setBootstrap(null)
      setBootstrapErr(e.message)
    }
    setLastUpdated(new Date())
    setLoading(false)
  }

  // The bootstrap payload shape mirrors Claude Desktop's managed config.
  // Be defensive about where models / MCP servers live across versions.
  const policy = bootstrap?.policies?.[0] || bootstrap?.policy || bootstrap || {}
  const desktop = policy?.desktop || bootstrap?.desktop || {}
  const availableModels = desktop.availableModels || policy.availableModels || bootstrap?.availableModels || []
  const mcpServers = desktop.managedMcpServers || bootstrap?.managedMcpServers || []

  function copy(text) { navigator.clipboard.writeText(text) }

  const cfg = GATEWAY_CONFIG || {}

  return (
    <div className="page">
      <h2>Gateway Config</h2>
      <p className="subtitle">
        Full gateway configuration — read-only. The complete config (all groups,
        model catalog, OIDC, upstreams, admin, telemetry) is baked into the gateway
        image, so the snapshot below matches what is running. Secrets are redacted.
      </p>

      {/* ── Full config: source + summary ────────────────────────── */}
      <div className="form-card">
        <h3>
          Full Config
          <span className="hint" style={{ marginLeft: '0.75rem' }}>
            source: <code>{cfg.source || '—'}</code>
            {' · '}
            {cfg.stamped
              ? <span className="success">stamped (live deployed values)</span>
              : <span>template (generic placeholders)</span>}
            {cfg.generatedAt && ` · baked ${new Date(cfg.generatedAt).toLocaleString()}`}
          </span>
        </h3>
        {!cfg.stamped && (
          <p className="subtitle">
            This snapshot was built from the committed template, so infra values show
            as <code>@@PLACEHOLDER@@</code>. The image build stamps the real
            <code> gateway.yaml</code>, and the deployed admin app will show the live values.
          </p>
        )}
      </div>

      {/* ── Model catalog ────────────────────────────────────────── */}
      <div className="form-card">
        <h3>Model Catalog <span className="hint">({(cfg.models || []).length})</span></h3>
        {(cfg.models || []).length ? (
          <table>
            <thead><tr><th>ID</th><th>Label</th></tr></thead>
            <tbody>
              {cfg.models.map((m, i) => (
                <tr key={i}>
                  <td className="mono clickable" title="Click to copy" onClick={() => copy(m.id)}>{m.id}</td>
                  <td>{m.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty">No models parsed from config.</p>}
      </div>

      {/* ── Groups ───────────────────────────────────────────────── */}
      <div className="form-card">
        <h3>IdP Groups <span className="hint">({(cfg.groups || []).length})</span></h3>
        {(cfg.groups || []).length ? (
          <table>
            <thead><tr><th>Group</th><th>Role</th></tr></thead>
            <tbody>
              {cfg.groups.map((g, i) => (
                <tr key={i}>
                  <td className="mono">{g}</td>
                  <td>{(cfg.adminGroups || []).includes(g) ? <span className="badge badge-active">admin</span> : 'model policy'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty">No groups parsed from config.</p>}
      </div>

      {/* ── Full redacted YAML ───────────────────────────────────── */}
      {cfg.yaml && (
        <div className="form-card">
          <h3>
            gateway.yaml <span className="hint">(secrets redacted)</span>
            <button className="refresh-btn" style={{ marginLeft: '1rem' }} onClick={() => copy(cfg.yaml)}>📋 Copy</button>
          </h3>
          <pre style={{ maxHeight: '60vh', overflow: 'auto' }}>{cfg.yaml}</pre>
        </div>
      )}

      {/* ── Live identity & OAuth ────────────────────────────────── */}
      {loading && <p className="loading">Loading live endpoints…</p>}
      {/* ── Identity & OAuth ─────────────────────────────────────── */}
      <div className="form-card">
        <h3>Live Identity &amp; OAuth <span className="hint">(from the running gateway)</span></h3>
        <table>
          <tbody>
            <tr>
              <td>Health</td>
              <td className={health?.healthy ? 'success' : 'error'}>
                {health?.healthy ? '✓ Healthy' : '✗ Unhealthy'}
              </td>
            </tr>
            {discovery ? (
              <>
                <tr>
                  <td>Issuer (public_url)</td>
                  <td className="mono clickable" title="Click to copy" onClick={() => copy(discovery.issuer)}>{discovery.issuer}</td>
                </tr>
                <tr>
                  <td>Authorization Endpoint</td>
                  <td className="mono">{discovery.authorization_endpoint}</td>
                </tr>
                <tr>
                  <td>Token Endpoint</td>
                  <td className="mono">{discovery.token_endpoint}</td>
                </tr>
                <tr>
                  <td>Device Auth Endpoint</td>
                  <td className="mono">{discovery.device_authorization_endpoint}</td>
                </tr>
                <tr>
                  <td>Protocol Version</td>
                  <td>{discovery.gateway_protocol_version || '—'}</td>
                </tr>
                {discovery.scopes_supported && (
                  <tr>
                    <td>Scopes Supported</td>
                    <td>{(discovery.scopes_supported || []).join(', ')}</td>
                  </tr>
                )}
              </>
            ) : !loading && (
              <tr><td colSpan="2" className="error">Discovery endpoint unreachable.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Delivered models ─────────────────────────────────────── */}
      <div className="form-card">
        <h3>Delivered Models <span className="hint">(live, your group · {availableModels.length})</span></h3>
        {bootstrapErr ? (
          <p className="subtitle">
            <span className="error">No Desktop config for your group.</span> The
            gateway serves <code>/user/bootstrap</code> only when your IdP group has a
            <code> desktop:</code> block in <code>gateway.yaml</code>. Detail: {bootstrapErr}
          </p>
        ) : availableModels.length ? (
          <table>
            <thead><tr><th>Model ID</th></tr></thead>
            <tbody>
              {availableModels.map((m, i) => {
                const id = typeof m === 'string' ? m : (m.id || m.model || JSON.stringify(m))
                return (
                  <tr key={i}>
                    <td className="mono clickable" title="Click to copy" onClick={() => copy(id)}>{id}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : !loading && <p className="empty">No models in the delivered config.</p>}
      </div>

      {/* ── Managed MCP servers ──────────────────────────────────── */}
      <div className="form-card">
        <h3>Managed MCP Servers <span className="hint">({mcpServers.length})</span></h3>
        {mcpServers.length ? (
          <table>
            <thead>
              <tr><th>Name</th><th>URL</th><th>Auth</th></tr>
            </thead>
            <tbody>
              {mcpServers.map((s, i) => (
                <tr key={i}>
                  <td>{s.name || s.id || '—'}</td>
                  <td className="mono clickable" title="Click to copy" onClick={() => copy(s.url || s.serverUrl || '')}>{s.url || s.serverUrl || '—'}</td>
                  <td>{s.oauth ? 'OAuth' : (s.auth || (s.headers ? 'headers' : 'none'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : !bootstrapErr && !loading ? (
          <p className="empty">No managed MCP servers in the delivered config.</p>
        ) : null}
      </div>

      {/* ── Raw JSON ─────────────────────────────────────────────── */}
      {bootstrap && (
        <div className="form-card">
          <h3>
            Raw Bootstrap Config
            <button className="refresh-btn" style={{ marginLeft: '1rem' }} onClick={() => setShowRaw(v => !v)}>
              {showRaw ? 'Hide' : 'Show'} JSON
            </button>
            <button className="refresh-btn" style={{ marginLeft: '0.5rem' }} onClick={() => copy(JSON.stringify(bootstrap, null, 2))}>
              📋 Copy
            </button>
          </h3>
          {showRaw && <pre>{JSON.stringify(bootstrap, null, 2)}</pre>}
        </div>
      )}

      <button className="refresh-btn" onClick={loadAll}>↻ Refresh</button>
      {lastUpdated && <span className="hint"> Last: {lastUpdated.toLocaleTimeString()}</span>}
    </div>
  )
}
