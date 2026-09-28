import { useState, useEffect } from 'react'
import { client } from '../api'
import UserDrilldown from './UserDrilldown'

export default function Users() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState('monthly')
  const [drilldown, setDrilldown] = useState(null) // { userId, email } | null

  useEffect(() => { loadUsers() }, [period])

  async function loadUsers() {
    setLoading(true)
    try {
      const data = await client.getEffective({
        period,
        sort: 'spend_desc',
        limit: 50,
        q: search || undefined,
      })
      // Filter to selected period only (API may return multiple)
      const filtered = (data.data || []).filter(r => r.period === period)
      setUsers(filtered)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  function handleSearch(e) {
    e.preventDefault()
    loadUsers()
  }

  // Raise (or set) a per-user cap for the given period. If the binding limit is
  // ALREADY a user-scoped one, the API would stack a second user limit, so we
  // delete the old user limit first and recreate at the new amount. If the user
  // is blocked by a GROUP or ORG limit, we simply add a user override (user scope
  // wins in the precedence order), leaving the group/org cap untouched.
  async function handleRaiseCap(u) {
    const uid = u.scope?.user_id
    if (!uid) {
      setError('Cannot raise cap: this row has no user_id to scope a limit to.')
      return
    }
    const email = u.actor?.email_address || uid
    const currentCap = u.amount ? (parseInt(u.amount) / 100) : null
    const spend = parseFloat(u.period_to_date_spend || '0') / 100
    const bindingType = u.scope?.type

    const suggested = currentCap != null
      ? Math.max(currentCap * 2, Math.ceil(spend) + 10)
      : Math.ceil(spend) + 50
    const input = window.prompt(
      `Raise ${period} cap for ${email}\n`
      + `Current: ${currentCap != null ? '$' + currentCap.toFixed(2) : 'unlimited'} (${bindingType} scope) · spent $${spend.toFixed(2)}\n\n`
      + `Enter new ${period} cap in USD (blank = unlimited for this user):`,
      currentCap != null ? String(suggested.toFixed(2)) : ''
    )
    if (input === null) return // cancelled

    const trimmed = input.trim()
    const amountCents = trimmed === '' ? null : String(Math.round(parseFloat(trimmed) * 100))
    if (trimmed !== '' && (Number.isNaN(parseFloat(trimmed)) || parseFloat(trimmed) < 0)) {
      setError(`Invalid amount "${trimmed}". Enter a non-negative number or leave blank for unlimited.`)
      return
    }

    try {
      // If the binding limit is already this user's own limit, replace it
      // (delete then create) so we don't stack two user limits for one period.
      if (bindingType === 'user' && u.spend_limit_id) {
        await client.deleteLimit(u.spend_limit_id)
      }
      await client.createLimit({
        scope: { type: 'user', user_id: uid },
        amount: amountCents,
        period,
      })
      setError(null)
      await loadUsers()
    } catch (e) {
      setError(`Raise cap failed for ${email}: ${e.message}`)
    }
  }

  function exportCsv() {
    const headers = ['User ID', 'Email', 'Name', 'Groups', 'Spend (USD)', 'Cap (USD)', 'Period']
    const rows = users.map(u => [
      u.scope?.user_id || '',
      u.actor?.email_address || '',
      u.actor?.name || '',
      (u.groups || []).join(';'),
      (parseFloat(u.period_to_date_spend || '0') / 100).toFixed(2),
      u.amount ? (parseFloat(u.amount) / 100).toFixed(2) : 'unlimited',
      period,
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gateway-spend-${period}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div className="page">
      <h2>Users & Spend</h2>

      <div className="toolbar">
        <form onSubmit={handleSearch} className="search-form">
          <input
            placeholder="Search by email or name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
        <select value={period} onChange={e => setPeriod(e.target.value)}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <button className="secondary-btn" onClick={exportCsv}>⬇ Export CSV</button>
      </div>

      {error && <p className="error">⚠️ {error}</p>}

      {loading ? <p className="loading">Loading...</p> : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Name</th>
              <th>Email</th>
              <th>Groups</th>
              <th>Spend ({period})</th>
              <th>Effective Cap</th>
              <th>% Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => {
              const spend = parseFloat(u.period_to_date_spend || '0') / 100
              const cap = u.amount ? parseFloat(u.amount) / 100 : null
              const pct = cap ? Math.round((spend / cap) * 100) : null
              const blocked = cap && spend >= cap
              return (
                <tr key={u.scope?.user_id || i} className={blocked ? 'blocked-row' : pct && pct > 80 ? 'warning-row' : ''}>
                  <td>{i + 1}</td>
                  <td>
                    {blocked
                      ? <span className="badge badge-blocked">🚫 BLOCKED</span>
                      : <span className="badge badge-active">✓ Active</span>
                    }
                  </td>
                  <td>{u.actor?.name || '—'}</td>
                  <td>
                    {u.scope?.user_id ? (
                      <button
                        className="linklike"
                        onClick={() => setDrilldown({ userId: u.scope.user_id, email: u.actor?.email_address || u.scope.user_id })}
                        title="View this user's spend profile"
                      >
                        {u.actor?.email_address || u.scope.user_id}
                      </button>
                    ) : (u.actor?.email_address || '—')}
                  </td>
                  <td>{(u.groups || []).join(', ') || '—'}</td>
                  <td className={blocked ? 'over-limit money' : 'money'}>${spend.toFixed(2)}</td>
                  <td className="money">{cap != null ? `$${cap.toFixed(2)}` : 'Unlimited'}</td>
                  <td>
                    {pct != null ? (
                      <div className="progress-bar">
                        <div className={`progress-fill ${blocked ? 'over' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        <span>{pct}%</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td>
                    {(blocked || (pct != null && pct > 80)) ? (
                      <button
                        className="primary-btn"
                        style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                        onClick={() => handleRaiseCap(u)}
                        title={blocked ? `Raise this user's ${period} cap to unblock them` : `Raise this user's ${period} cap`}
                      >
                        {blocked ? '↑ Raise cap' : '↑ Raise'}
                      </button>
                    ) : u.scope?.user_id ? (
                      <button
                        className="secondary-btn"
                        style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                        onClick={() => handleRaiseCap(u)}
                        title={`Set a per-user ${period} cap`}
                      >
                        Set cap
                      </button>
                    ) : '—'}
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && (
              <tr><td colSpan="9" className="empty">No users found.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {drilldown && (
        <UserDrilldown
          userId={drilldown.userId}
          email={drilldown.email}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  )
}
