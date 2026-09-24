/**
 * OAuth Device Authorization flow for the admin web app.
 * 
 * Uses the same device auth flow as `claude /login`:
 * 1. POST /oauth/device_authorization → get device_code + user_code + verification_uri
 * 2. User opens verification_uri in browser and enters user_code
 * 3. Poll POST /oauth/token until user completes auth
 * 4. Store bearer token for admin API calls
 */

const BASE = '';  // Proxied through Vite

const TOKEN_KEY = 'gw_admin_token';
const TOKEN_EXPIRY_KEY = 'gw_admin_token_expiry';

export function getStoredToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
  if (token && expiry && Date.now() < parseInt(expiry)) {
    return token;
  }
  // Expired or missing
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  return null;
}

export function storeToken(token, expiresInSeconds) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(Date.now() + expiresInSeconds * 1000));
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

/**
 * Decode JWT payload (no verification — just for display).
 */
export function decodeToken(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

/**
 * Start the device authorization flow.
 * Returns { device_code, user_code, verification_uri, interval }
 */
export async function startDeviceAuth() {
  const res = await fetch(`${BASE}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'client_id=admin-dashboard',
  });

  if (!res.ok) {
    throw new Error(`Device auth failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

/**
 * Poll for token after user authorizes.
 * Resolves with { access_token, expires_in } or rejects on error/timeout.
 */
export async function pollForToken(deviceCode, interval = 5, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));

    const res = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: 'admin-dashboard',
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data;
    }

    const error = await res.json().catch(() => ({}));
    const errorType = error.error;

    if (errorType === 'authorization_pending') {
      // User hasn't completed auth yet, keep polling
      continue;
    } else if (errorType === 'slow_down') {
      // Increase interval
      interval += 1;
      continue;
    } else if (errorType === 'expired_token') {
      throw new Error('Authorization timed out. Please try again.');
    } else {
      throw new Error(error.error_description || `Token exchange failed: ${errorType}`);
    }
  }

  throw new Error('Authorization timed out after maximum attempts.');
}
