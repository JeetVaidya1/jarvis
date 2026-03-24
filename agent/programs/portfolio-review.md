---
name: Portfolio Review
schedule: "0 10,14,18 * * *"
enabled: true
model: claude-sonnet-4-6
deliver: true
---

Run a quick Polymarket portfolio health check.

1. Fetch open positions via jarvis_polymarket_positions
2. For each open position, note: market name, side (YES/NO), deployed USDC, current price, unrealized P&L
3. Flag any positions where:
   - Unrealized loss exceeds 50% of entry (consider cutting)
   - Market resolves within 2 hours (time-sensitive)
4. Show portfolio summary: total deployed, total P&L, win/loss on resolved today

Keep it short — bullet points only. Alert if anything needs immediate attention.
