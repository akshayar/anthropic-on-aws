import { useState, useEffect } from 'react'
import { client } from '../api'

/**
 * Per-user spend drilldown.
 *
 * Shows one user's spend across all three periods (daily / weekly / monthly),
 * each against its effective cap, as a small SVG bar chart.
 *
 * DATA NOTE: the gateway's spend API exposes only `period_to_date_spend` — the
 * CURRENT running total for each period — NOT a historical time series. So this
 * is a "spend profile" across the three period windows, not a day-by-day trend
 * line. A true historical sparkline would need the telemetry backend
 * (CloudWatch Coding Agent Insights), which is outside this admin API.
 *
 * Props:
 *   userId  — OIDC sub to fetch (required)
 *   email   — display label
 *   onClose — close handler
 */
export default function UserDrilldown({ userId, email, onClose }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        // Fetch all three periods scoped to this one user.
        const [daily, weekly, monthly] = await Promise.all([
          client.getEffective({ period: 'daily', userIds: [userId], limit: 5 }),
          client.getEffective({ period: 'weekly', userIds: [userId], limit: 5 }),
          client.getEffective({ period: 'monthly', userIds: [userId], limit: 5 }),
        ])
        if (cancelled) return
        const pick = (data, period) =>
          (data.data || []).find(r => (r.scope?.user_id === userId) && r.period === period)
          || (data.data || [])[0]
        const built = [
          ['daily', pick(daily, 'daily')],
          ['weekly', pick(weekly, 'weekly')],
          ['monthly', pick(monthly, 'monthly')],
        ].map(([period, r]) => ({
          period,
          spend: r ? parseFloat(r.period_to_date_spend || '0') / 100 : 0,
          cap: r && r.amount ? parseFloat(r.amount) / 100 : null,
          scopeType: r?.scope?.type || null,
        }))
        setRows(built)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [userId])

  // Chart geometry
  const W = 420, H = 160, PAD = 34, BARW = 70
  const maxVal = rows
    ? Math.max(0.01, ...rows.map(r => Math.max(r.spend, r.cap || 0)))
    : 1

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Spend profile — {email}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading && <p className="loading">Loading…</p>}
        {error && <p className="error">⚠️ {error}</p>}

        {rows && !loading && (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Spend by period">
              {/* baseline */}
              <line x1={PAD} y1={H - PAD} x2={W - 8} y2={H - PAD} stroke="var(--border, #ccc)" />
              {rows.map((r, i) => {
                const x = PAD + 8 + i * (BARW + 30)
                const usableH = H - PAD - 14
                const spendH = Math.round((r.spend / maxVal) * usableH)
                const capY = r.cap != null ? (H - PAD) - Math.round((r.cap / maxVal) * usableH) : null
                const over = r.cap != null && r.spend >= r.cap
                return (
                  <g key={r.period}>
                    {/* spend bar */}
                    <rect
                      x={x} y={(H - PAD) - spendH} width={BARW} height={spendH}
                      fill={over ? 'var(--danger, #d9534f)' : 'var(--accent, #4a90d9)'}
                      rx="3"
                    />
                    {/* cap line */}
                    {capY != null && (
                      <line
                        x1={x - 4} y1={capY} x2={x + BARW + 4} y2={capY}
                        stroke="var(--danger, #d9534f)" strokeDasharray="4 3" strokeWidth="1.5"
                      />
                    )}
                    {/* spend label */}
                    <text x={x + BARW / 2} y={(H - PAD) - spendH - 5} textAnchor="middle"
                      fontSize="11" fill="var(--text, #333)">${r.spend.toFixed(2)}</text>
                    {/* period label */}
                    <text x={x + BARW / 2} y={H - PAD + 16} textAnchor="middle"
                      fontSize="11" fill="var(--text-muted, #777)">{r.period}</text>
                  </g>
                )
              })}
            </svg>

            <table className="drilldown-table">
              <thead>
                <tr><th>Period</th><th>Spend</th><th>Cap</th><th>Scope</th><th>% Used</th></tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const pct = r.cap ? Math.round((r.spend / r.cap) * 100) : null
                  const over = r.cap != null && r.spend >= r.cap
                  return (
                    <tr key={r.period} className={over ? 'blocked-row' : ''}>
                      <td>{r.period}</td>
                      <td className={over ? 'over-limit money' : 'money'}>${r.spend.toFixed(2)}</td>
                      <td className="money">{r.cap != null ? `$${r.cap.toFixed(2)}` : 'Unlimited'}</td>
                      <td>{r.scopeType || '—'}</td>
                      <td>{pct != null ? `${pct}%` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <p className="hint" style={{ marginTop: '0.75rem' }}>
              Dashed red line = effective cap. This is period-to-date spend for each
              window (the gateway does not expose a day-by-day history), so it is a
              spend <em>profile</em>, not a trend line. For historical trends use
              CloudWatch Coding Agent Insights.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
