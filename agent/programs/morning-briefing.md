---
name: Morning Briefing
schedule: "0 8 * * *"
enabled: true
model: claude-sonnet-4-6
deliver: true
---

Pull together a morning briefing for Jeet. Keep it concise and actionable.

Include:
1. **Weather** — fetch current Kelowna weather from `https://wttr.in/Kelowna?format=3` via jarvis_browser_navigate or a simple fetch. One line: condition + temp.
2. **Portfolio status** — check Polymarket positions via jarvis_polymarket_positions, show deployed capital, current P&L on open positions, any expiring today
3. **Crypto prices** — BTC, ETH, SOL via jarvis_get_price (price + 24h change)
4. **Calendar** — today's events + next 48hrs via jarvis_calendar_today and jarvis_calendar_upcoming
5. **Gmail triage** — action-required emails only via jarvis_gmail_triage (skip info-only)
6. **GitHub** — open PRs needing review and any CI failures via jarvis_github_prs for repo JeetVaidya1/jarvis
7. **One sentence on what to focus on today** — based on the above

Format with markdown headers. Keep each section to 1-3 lines max. Total length: under 350 words.
