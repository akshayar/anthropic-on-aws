/**
 * Gateway Admin API client.
 * 
 * Supports two auth methods:
 * 1. Bearer token (from OAuth SSO login) — preferred for human admins
 * 2. x-api-key header — for machines/automation
 */

const BASE = '';  // Proxied through Vite to localhost:8080

class GatewayAdminClient {
  constructor() {
    this.apiKey = '';
    this.bearerToken = '';
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  setBearerToken(token) {
    this.bearerToken = token;
  }

  isAuthenticated() {
    return !!(this.bearerToken || this.apiKey);
  }

  async _fetch(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Bearer token takes priority (SSO login)
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    } else if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `API error: ${res.status} ${res.statusText}`;
      throw new Error(`Request rejected (${res.status}) · ${msg}`);
    }
    return res.json();
  }

  // ─── Health (no auth needed) ──────────────────────────────────────

  async health() {
    const res = await fetch(`${BASE}/healthz`);
    return { healthy: res.ok, status: await res.text() };
  }

  async discovery() {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    return res.json();
  }

  // ─── Gateway Config (bootstrap) ───────────────────────────────────
  // /user/bootstrap serves the Desktop config for the caller's group
  // (models, managed MCP servers, desktop block). Requires the caller's
  // group to have a `desktop:` block in gateway.yaml — else 404.
  async bootstrap() {
    return this._fetch(`/user/bootstrap`);
  }

  // ─── Spend Limits ─────────────────────────────────────────────────

  async listLimits({ limit = 20, afterId } = {}) {
    let path = `/v1/organizations/spend_limits?limit=${limit}`;
    if (afterId) path += `&after_id=${afterId}`;
    return this._fetch(path);
  }

  async createLimit({ scope, amount, period }) {
    return this._fetch('/v1/organizations/spend_limits', {
      method: 'POST',
      body: JSON.stringify({ scope, amount, period }),
    });
  }

  async deleteLimit(id) {
    return this._fetch(`/v1/organizations/spend_limits/${id}`, {
      method: 'DELETE',
    });
  }

  async getLimit(id) {
    return this._fetch(`/v1/organizations/spend_limits/${id}`);
  }

  // ─── Effective (Top Spenders) ─────────────────────────────────────

  async getEffective({ period = 'monthly', sort = 'spend_desc', limit = 20, page, userIds, q } = {}) {
    const params = new URLSearchParams();
    params.set('period[]', period);
    if (sort) params.set('sort', sort);
    if (limit) params.set('limit', limit);
    if (page) params.set('page', page);
    if (q) params.set('q', q);
    if (userIds) {
      userIds.forEach(id => params.append('user_ids[]', id));
    }
    return this._fetch(`/v1/organizations/spend_limits/effective?${params}`);
  }

  // ─── Audit ────────────────────────────────────────────────────────

  async getAudit({ limit = 50 } = {}) {
    return this._fetch(`/v1/organizations/spend_limits/audit?limit=${limit}`);
  }
}

export const client = new GatewayAdminClient();
export default GatewayAdminClient;
