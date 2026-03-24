---
name: Morning Briefing
schedule: "0 7 * * *"
enabled: true
model: claude-sonnet-4-6
deliver: true
---

Pull together a morning briefing for Jeet. Keep it concise and actionable.

Include:
1. **Portfolio status** — check Polymarket positions via jarvis_polymarket_positions, show deployed capital, current P&L on open positions
2. **Crypto prices** — BTC, ETH, SOL via jarvis_get_price
3. **Calendar** — today's events via jarvis_calendar_today
4. **Gmail triage** — check for high-priority emails via jarvis_gmail_triage (quick scan only)
5. **One sentence on what to focus on today** — based on the above

Format with markdown headers. Total length: under 300 words.
