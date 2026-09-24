import { useState, useEffect } from 'react'
import { client } from '../api'

export default function Users() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState('monthly')

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
                  <td>{u.actor?.email_address || u.scope?.user_id || '—'}</td>
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
                </tr>
              )
            })}
            {users.length === 0 && (
              <tr><td colSpan="8" className="empty">No users found.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
