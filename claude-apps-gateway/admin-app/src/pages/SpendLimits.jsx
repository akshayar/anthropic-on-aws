import { useState, useEffect } from 'react'
import { client } from '../api'
import { CONFIG_GROUPS } from '../configGroups'

export default function SpendLimits() {
  const [limits, setLimits] = useState([])
  const [effective, setEffective] = useState({})
  const [knownUsers, setKnownUsers] = useState([])
  const [knownGroups, setKnownGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)

  // Form state
  const [scopeType, setScopeType] = useState('organization')
  const [scopeId, setScopeId] = useState('')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState('monthly')

  useEffect(() => { loadLimits() }, [])

  async function loadLimits() {
    setLoading(true)
    try {
      const [limitsData, dailyData, weeklyData, monthlyData] = await Promise.all([
        client.listLimits({ limit: 100 }),
        client.getEffective({ period: 'daily', limit: 50 }),
        client.getEffective({ period: 'weekly', limit: 50 }),
        client.getEffective({ period: 'monthly', limit: 50 }),
      ])
      setLimits(limitsData.data || [])

      // Build a map: limitId -> current spend, and collect known users
      const spendMap = {}
      const users = []
      const seenUsers = new Set()
      // Seed with groups declared in the gateway config (baked in at build time),
      // so a group that exists in config but has generated no spend yet still shows.
      const seenGroups = new Set(CONFIG_GROUPS)
      for (const entry of [...(dailyData.data || []), ...(weeklyData.data || []), ...(monthlyData.data || [])]) {
        if (entry.spend_limit_id) {
          spendMap[entry.spend_limit_id] = spendMap[entry.spend_limit_id] || []
          spendMap[entry.spend_limit_id].push({
            user: entry.actor?.email_address || entry.scope?.user_id,
            spend: parseFloat(entry.period_to_date_spend || '0') / 100,
            period: entry.period,
          })
        }
        const uid = entry.scope?.user_id
        if (uid && !seenUsers.has(uid)) {
          seenUsers.add(uid)
          users.push({ id: uid, email: entry.actor?.email_address || uid })
        }
        // Harvest distinct IdP group names so the group-cap picker can suggest them
        // instead of the admin typing a group blind.
        for (const g of entry.groups || []) {
          if (g && !seenGroups.has(g)) seenGroups.add(g)
        }
      }
      setEffective(spendMap)
      setKnownUsers(users)
      setKnownGroups([...seenGroups].sort())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    const scope = { type: scopeType }
    if (scopeType === 'user') {
      // The API keys user limits on the OIDC sub (user_id), NOT email. The picker
      // stores known users as {id: sub, email}. If the admin typed/selected an
      // email (or a datalist entry whose value is the sub), resolve it to the sub;
      // otherwise pass the raw value through so a directly-pasted sub still works.
      const trimmed = scopeId.trim()
      const byId = knownUsers.find(u => u.id === trimmed)
      const byEmail = knownUsers.find(u => u.email.toLowerCase() === trimmed.toLowerCase())
      scope.user_id = (byId && byId.id) || (byEmail && byEmail.id) || trimmed
    }
    if (scopeType === 'rbac_group') scope.rbac_group_id = scopeId.trim()

    // Guard against silently stacking a second cap on the same scope+period.
    // The API allows it, but it's almost always an accident, so confirm first.
    const dup = limits.find(l =>
      l.period === period &&
      l.scope?.type === scope.type &&
      (l.scope?.user_id || '') === (scope.user_id || '') &&
      (l.scope?.rbac_group_id || '') === (scope.rbac_group_id || '')
    )
    if (dup) {
      const existing = dup.amount ? `$${(parseInt(dup.amount) / 100).toFixed(2)}` : 'Unlimited'
      if (!confirm(`A ${period} limit already exists for this scope (${existing}). Create another anyway? Delete the old one instead if you meant to change it.`)) {
        return
      }
    }

    try {
      await client.createLimit({
        scope,
        amount: amount ? String(Math.round(parseFloat(amount) * 100)) : null,
        period,
      })
      setShowForm(false)
      setAmount('')
      setScopeId('')
      loadLimits()
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this spend limit?')) return
    try {
      await client.deleteLimit(id)
      loadLimits()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="page">
      <h2>Spend Limits</h2>
      <p className="subtitle">Set per-user, per-group, or org-wide spend caps.</p>

      <button className="primary-btn" onClick={() => setShowForm(!showForm)}>
        {showForm ? 'Cancel' : '+ New Limit'}
      </button>

      {showForm && (
        <form className="form-card" onSubmit={handleCreate}>
          <div className="form-row">
            <label>Scope</label>
            <select value={scopeType} onChange={e => setScopeType(e.target.value)}>
              <option value="organization">Organization (all users)</option>
              <option value="rbac_group">Group</option>
              <option value="user">User</option>
            </select>
          </div>
          {scopeType !== 'organization' && (
            <div className="form-row">
              <label>{scopeType === 'user' ? 'User' : 'Group name'}</label>
              {scopeType === 'user' && knownUsers.length > 0 ? (
                <div className="autocomplete">
                  <input
                    value={scopeId}
                    onChange={e => setScopeId(e.target.value)}
                    placeholder="Search by email or user ID..."
                    list="user-list"
                    required
                  />
                  <datalist id="user-list">
                    {knownUsers
                      .filter(u => !scopeId || u.email.toLowerCase().includes(scopeId.toLowerCase()) || u.id.includes(scopeId))
                      .map(u => (
                        <option key={u.id} value={u.id}>{u.email}</option>
                      ))}
                  </datalist>
                  {scopeId && knownUsers.find(u => u.id === scopeId) && (
                    <span className="hint">✓ {knownUsers.find(u => u.id === scopeId).email}</span>
                  )}
                  <span className="hint">Pick a known user by email, or paste an OIDC sub (user ID) directly.</span>
                </div>
              ) : scopeType === 'rbac_group' && knownGroups.length > 0 ? (
                <div className="autocomplete">
                  <input
                    value={scopeId}
                    onChange={e => setScopeId(e.target.value)}
                    placeholder="Search or type a group name..."
                    list="group-list"
                    required
                  />
                  <datalist id="group-list">
                    {knownGroups
                      .filter(g => !scopeId || g.toLowerCase().includes(scopeId.toLowerCase()))
                      .map(g => (
                        <option key={g} value={g} />
                      ))}
                  </datalist>
                  <span className="hint">Pick a known IdP group, or type a group name the gateway config uses.</span>
                </div>
              ) : (
                <input value={scopeId} onChange={e => setScopeId(e.target.value)} required
                  placeholder={scopeType === 'user' ? 'OIDC sub (user ID)' : 'Group name'} />
              )}
            </div>
          )}
          <div className="form-row">
            <label>Amount (USD) — leave empty for unlimited</label>
            <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 500.00" />
          </div>
          <div className="form-row">
            <label>Period</label>
            <select value={period} onChange={e => setPeriod(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <button type="submit" className="primary-btn">Create Limit</button>
        </form>
      )}

      {error && <p className="error">⚠️ {error}</p>}

      {loading ? <p className="loading">Loading...</p> : (
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Target</th>
              <th>Cap</th>
              <th>Period</th>
              <th>Current Usage</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {limits.map(lim => {
              const cap = lim.amount ? parseInt(lim.amount) / 100 : null
              const usages = effective[lim.id] || []
              const maxSpend = usages.length > 0 ? Math.max(...usages.map(u => u.spend)) : 0
              const pct = cap ? Math.round((maxSpend / cap) * 100) : null
              const breached = cap && maxSpend >= cap
              return (
                <tr key={lim.id} className={breached ? 'blocked-row' : ''}>
                  <td>{lim.scope?.type}</td>
                  <td>{lim.scope?.user_id || lim.scope?.rbac_group_id || '(all users)'}</td>
                  <td className="money">
                    {cap != null ? `$${cap.toFixed(2)}` : 'Unlimited'}
                  </td>
                  <td>{lim.period}</td>
                  <td>
                    {cap && usages.length > 0 ? (
                      <div>
                        <span className={breached ? 'over-limit' : ''}>${maxSpend.toFixed(2)} / ${cap.toFixed(2)}</span>
                        <div className="progress-bar small">
                          <div className={`progress-fill ${breached ? 'over' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                          <span>{pct}%</span>
                        </div>
                      </div>
                    ) : usages.length === 0 ? <span className="hint">No usage yet</span> : '—'}
                  </td>
                  <td>
                    <button className="danger-btn" onClick={() => handleDelete(lim.id)}>Delete</button>
                  </td>
                </tr>
              )
            })}
            {limits.length === 0 && (
              <tr><td colSpan="6" className="empty">No spend limits configured.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
