import { latestReport } from './reportStore.js'

export function getCachedReport(market) {
  const latest = latestReport(market)
  if (!latest || !latest.expires_at || Date.now() >= Date.parse(latest.expires_at)) return null
  return {
    ok: true,
    cached: true,
    market,
    date: latest.date,
    audit: latest.html_path,
    expires_at: latest.expires_at,
  }
}
