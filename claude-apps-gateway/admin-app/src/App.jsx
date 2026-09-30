import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { client } from './api'
import { getStoredToken, storeToken, clearToken, startDeviceAuth, pollForToken, decodeToken } from './auth'
import Dashboard from './pages/Dashboard'
import SpendLimits from './pages/SpendLimits'
import Users from './pages/Users'
import Audit from './pages/Audit'
import Settings from './pages/Settings'
import GatewayConfig from './pages/GatewayConfig'
import './App.css'

function App() {
  const [token, setToken] = useState(getStoredToken())
  const [health, setHealth] = useState(null)
  const [loginState, setLoginState] = useState(null) // null | 'pending' | { userCode, verificationUri }
  const [loginError, setLoginError] = useState(null)
  const [user, setUser] = useState(null)

  // Set token on client
  useEffect(() => {
    if (token) {
      client.setBearerToken(token)
    }
  }, [token])

  // Check health on load
  useEffect(() => {
    client.health().then(setHealth).catch(() => setHealth({ healthy: false }))
  }, [])

  async function handleLogin() {
    setLoginError(null)
    setLoginState('pending')
    try {
      const authData = await startDeviceAuth()
      setLoginState({
        userCode: authData.user_code,
        verificationUri: authData.verification_uri || `http://localhost:8080/device`,
        deviceCode: authData.device_code,
        interval: authData.interval || 5,
      })

      // Open the verification URI with user_code pre-filled
      window.open(
        (authData.verification_uri || `http://localhost:8080/device`) + `?user_code=${authData.user_code}`,
        '_blank'
      )

      // Poll for token
      const tokenData = await pollForToken(authData.device_code, authData.interval || 5)
      storeToken(tokenData.access_token, tokenData.expires_in || 28800)
      setToken(tokenData.access_token)
      client.setBearerToken(tokenData.access_token)
      setLoginState(null)
    } catch (e) {
      setLoginError(e.message)
      setLoginState(null)
    }
  }

  function handleLogout() {
    clearToken()
    setToken(null)
    client.setBearerToken('')
    client.setApiKey('')
    localStorage.removeItem('gw_admin_key')
    setUser(null)
  }

  // Also support API key fallback
  function handleApiKey(key) {
    client.setApiKey(key)
    localStorage.setItem('gw_admin_key', key)
  }

  const isLoggedIn = !!token || !!localStorage.getItem('gw_admin_key')

  return (
    <BrowserRouter>
      <div className="app">
        <nav className="sidebar">
          <h1 className="logo">⚡ Gateway Admin</h1>
          <div className={`health-badge ${health?.healthy ? 'healthy' : 'unhealthy'}`}>
            {health?.healthy ? '● Healthy' : '○ Offline'}
          </div>

          <div className="auth-status">
            {isLoggedIn && <span className="auth-label">✓ Authenticated</span>}
            {token && decodeToken(token)?.email && (
              <span className="auth-user">{decodeToken(token).email}</span>
            )}
            <button className="login-btn" onClick={handleLogin} disabled={loginState === 'pending'}>
              {isLoggedIn ? '🔄 Re-login with SSO' : '🔐 Login with SSO'}
            </button>
            {isLoggedIn && (
              <button className="logout-btn" onClick={handleLogout}>Logout</button>
            )}
          </div>

          {loginState && loginState !== 'pending' && (
            <div className="login-pending">
              <p>Enter code in browser:</p>
              <code className="user-code">{loginState.userCode}</code>
              <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(loginState.userCode) }}>📋 Copy</button>
              <p className="hint">Waiting for authorization...</p>
            </div>
          )}
          {loginState === 'pending' && <p className="hint">Starting login...</p>}
          {loginError && <p className="error small">{loginError}</p>}

          <ul>
            <li><NavLink to="/">Dashboard</NavLink></li>
            <li><NavLink to="/spend-limits">Spend Limits</NavLink></li>
            <li><NavLink to="/users">Users</NavLink></li>
            <li><NavLink to="/audit">Audit Log</NavLink></li>
            <li><NavLink to="/config">Gateway Config</NavLink></li>
            <li><NavLink to="/settings">Settings</NavLink></li>
          </ul>
        </nav>
        <main className="content">
          {!isLoggedIn ? (
            <div className="api-key-banner">
              🔐 Login with SSO to access admin data. Your Okta account must be in the <strong>QuickAdmin</strong> group.
              <br /><small>Or set an API key in Settings for automation.</small>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/spend-limits" element={<SpendLimits />} />
              <Route path="/users" element={<Users />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/config" element={<GatewayConfig />} />
              <Route path="/settings" element={<Settings onApiKey={handleApiKey} />} />
            </Routes>
          )}
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
