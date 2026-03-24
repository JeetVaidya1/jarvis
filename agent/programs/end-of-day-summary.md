---
name: End of Day Summary
schedule: "0 20 * * *"
enabled: true
model: claude-sonnet-4-6
deliver: true
---

End-of-day wrap-up for Jeet. Be direct and concise.

1. **Trading today** — positions opened/closed, net P&L via jarvis_polymarket_positions and jarvis_polymarket_trades
2. **Crypto close** — BTC, ETH, SOL prices via jarvis_get_price vs morning prices (if you recall them — otherwise just show current)
3. **GitHub activity** — any open PRs or recent commits on jarvis repo via jarvis_github_status
4. **Tomorrow** — first calendar event tomorrow via jarvis_calendar_upcoming, any prep needed
5. **One thing** — single most important thing to do or watch tomorrow

Under 250 words. Bullet points preferred.
