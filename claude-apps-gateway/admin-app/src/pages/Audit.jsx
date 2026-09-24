import { useState, useEffect } from 'react'
import { client } from '../api'

export default function Audit() {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => { loadAudit() }, [])

  async function loadAudit() {
    setLoading(true)
    try {
      const data = await client.getAudit({ limit: 50 })
      setEntries(data.data || [])
      setError(null)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  function formatTime(ts) {
    if (!ts) return '—'
    return new Date(ts).toLocaleString()
  }

  return (
    <div className="page">
      <h2>Audit Log</h2>
      <p className="subtitle">Spend limit changes — who changed what and when.</p>

      {error && <p className="error">⚠️ {error}</p>}

      {loading ? <p className="loading">Loading...</p> : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Scope</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <tr key={i}>
                <td className="mono">{formatTime(entry.created_at)}</td>
                <td>{entry.actor || '—'}</td>
                <td>
                  <span className={`badge badge-${entry.action}`}>
                    {entry.action || 'unknown'}
                  </span>
                </td>
                <td>
                  {entry.scope?.type}: {entry.scope?.user_id || entry.scope?.rbac_group_id || 'org'}
                </td>
                <td className="money">
                  {entry.before?.amount != null ? `$${(parseInt(entry.before.amount) / 100).toFixed(2)}` : '—'}
                </td>
                <td className="money">
                  {entry.after?.amount != null ? `$${(parseInt(entry.after.amount) / 100).toFixed(2)}` : '—'}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan="6" className="empty">No audit entries yet.</td></tr>
            )}
          </tbody>
        </table>
      )}

      <button className="refresh-btn" onClick={loadAudit}>↻ Refresh</button>
    </div>
  )
}
