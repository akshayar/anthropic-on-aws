import { useState, useEffect } from 'react'
import { client } from '../api'

export default function Dashboard() {
  const [allData, setAllData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      // Fetch all periods to detect which cap is breached
      const [daily, weekly, monthly] = await Promise.all([
        client.getEffective({ period: 'daily', sort: 'spend_desc', limit: 20 }),
        client.getEffective({ period: 'weekly', sort: 'spend_desc', limit: 20 }),
        client.getEffective({ period: 'monthly', sort: 'spend_desc', limit: 20 }),
      ])

      // Group by user
      const userMap = {}
      for (const entry of [...(daily.data || []), ...(weekly.data || []), ...(monthly.data || [])]) {
        const uid = entry.scope?.user_id || entry.actor?.user_id || entry.user_id || 'unknown'
        if (!userMap[uid]) {
          userMap[uid] = { actor: entry.actor, groups: entry.groups, periods: {} }
        }
        userMap[uid].periods[entry.period] = {
          spend: parseFloat(entry.period_to_date_spend || '0') / 100,
          cap: entry.amount ? parseFloat(entry.amount) / 100 : null,
        }
      }

      setAllData(Object.entries(userMap).map(([uid, data]) => ({ uid, ...data })))
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  // Calculate totals from monthly
  const totalMonthlySpend = allData.reduce((sum, u) => sum + (u.periods.monthly?.spend || 0), 0)
  const activeUsers = allData.length
  const blockedUsers = allData.filter(u =>
    Object.values(u.periods).some(p => p.cap && p.spend >= p.cap)
  ).length

  function isBreached(periods) {
    return Object.values(periods).some(p => p.cap && p.spend >= p.cap)
  }

  function getBreachedPeriod(periods) {
    for (const [period, p] of Object.entries(periods)) {
      if (p.cap && p.spend >= p.cap) return period
    }
    return null
  }

  return (
    <div className="page">
      <h2>Dashboard</h2>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">${totalMonthlySpend.toFixed(2)}</div>
          <div className="stat-label">Total Spend (This Month)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{activeUsers}</div>
          <div className="stat-label">Active Users</div>
        </div>
        <div className="stat-card">
          <div className={`stat-value ${blockedUsers > 0 ? 'danger-text' : ''}`}>{blockedUsers}</div>
          <div className="stat-label">Blocked Users</div>
        </div>
      </div>

      <h3>Users & Limits</h3>
      {loading && <p className="loading">Loading...</p>}
      {error && <p className="error">⚠️ {error}</p>}
      {!loading && !error && (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Email</th>
              <th>User ID</th>
              <th>Groups</th>
              <th>Daily</th>
              <th>Weekly</th>
              <th>Monthly</th>
            </tr>
          </thead>
          <tbody>
            {allData.map((user, i) => {
              const blocked = isBreached(user.periods)
              const breachedPeriod = getBreachedPeriod(user.periods)
              return (
                <tr key={user.uid} className={blocked ? 'blocked-row' : ''}>
                  <td>
                    {blocked
                      ? <span className="badge badge-blocked">🚫 BLOCKED ({breachedPeriod})</span>
                      : <span className="badge badge-active">✓ Active</span>
                    }
                  </td>
                  <td>{user.actor?.email_address || user.uid}</td>
                  <td className="mono" style={{fontSize:'0.75rem', cursor:'pointer'}} title="Click to copy" onClick={() => navigator.clipboard.writeText(user.uid)}>{user.uid}</td>
                  <td>{(user.groups || []).join(', ')}</td>
                  {['daily', 'weekly', 'monthly'].map(period => {
                    const p = user.periods[period]
                    if (!p) return <td key={period}>—</td>
                    const pct = p.cap ? Math.round((p.spend / p.cap) * 100) : null
                    const over = p.cap && p.spend >= p.cap
                    return (
                      <td key={period} className={over ? 'over-limit' : ''}>
                        <div>${p.spend.toFixed(2)} {p.cap ? `/ $${p.cap.toFixed(2)}` : ''}</div>
                        {pct != null && (
                          <div className="progress-bar small">
                            <div
                              className={`progress-fill ${over ? 'over' : ''}`}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                            <span>{pct}%</span>
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {allData.length === 0 && (
              <tr><td colSpan="7" className="empty">No spend data yet.</td></tr>
            )}
          </tbody>
        </table>
      )}

      <button className="refresh-btn" onClick={loadData}>↻ Refresh</button>
      {lastUpdated && <span className="hint"> Auto-refreshes every 30s · Last: {lastUpdated.toLocaleTimeString()}</span>}
    </div>
  )
}
