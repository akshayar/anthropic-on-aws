import { useState, useEffect } from 'react'
import { client } from '../api'

export default function Settings({ onApiKey }) {
  const [health, setHealth] = useState(null)
  const [discovery, setDiscovery] = useState(null)
  const [inputKey, setInputKey] = useState(localStorage.getItem('gw_admin_key') || '')

  useEffect(() => {
    client.health().then(setHealth).catch(() => setHealth({ healthy: false }))
    client.discovery().then(setDiscovery).catch(() => {})
  }, [])

  function handleSave(e) {
    e.preventDefault()
    onApiKey(inputKey)
  }

  return (
    <div className="page">
      <h2>Settings</h2>

      <div className="form-card">
        <h3>Authentication</h3>
        <p className="subtitle">
          <strong>Recommended:</strong> Use the "Login with SSO" button in the sidebar.
          Your Okta account must be in the <code>admin_groups</code> configured in gateway.yaml.
        </p>
        <p className="subtitle">
          <strong>Fallback (automation):</strong> Paste an API key below for machine access.
        </p>
      </div>

      <div className="form-card">
        <h3>API Key (for automation only)</h3>
        <p className="subtitle">
          From <code>gateway.yaml</code> → <code>admin.write_keys</code> or <code>admin.read_keys</code>
        </p>
        <form onSubmit={handleSave} className="form-row">
          <input
            type="password"
            value={inputKey}
            onChange={e => setInputKey(e.target.value)}
            placeholder="Paste API key (optional if using SSO)"
            style={{ flex: 1 }}
          />
          <button type="submit" className="primary-btn">Save</button>
          {inputKey && (
            <button type="button" className="danger-btn" onClick={() => { setInputKey(''); onApiKey(''); localStorage.removeItem('gw_admin_key'); }}>Clear</button>
          )}
        </form>
      </div>

      <div className="form-card">
        <h3>Gateway Status</h3>
        <table>
          <tbody>
            <tr>
              <td>Health</td>
              <td className={health?.healthy ? 'success' : 'error'}>
                {health?.healthy ? '✓ Healthy' : '✗ Unhealthy'}
              </td>
            </tr>
            {discovery && (
              <>
                <tr>
                  <td>Issuer</td>
                  <td className="mono">{discovery.issuer}</td>
                </tr>
                <tr>
                  <td>Device Auth Endpoint</td>
                  <td className="mono">{discovery.device_authorization_endpoint}</td>
                </tr>
                <tr>
                  <td>Protocol Version</td>
                  <td>{discovery.gateway_protocol_version}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="form-card">
        <h3>Gateway Config for Admin Access</h3>
        <p>Add this to your <code>gateway.yaml</code> to enable SSO-based admin:</p>
        <pre>{`admin:
  admin_groups: [YourAdminGroup]  # IdP group name
  # Optional: API keys for automation
  # write_keys:
  #   - id: terraform
  #     key: "your-32-char-key"`}</pre>
        <p>Users in <code>admin_groups</code> get full admin access via their normal gateway login — no API key needed.</p>
      </div>
    </div>
  )
}
