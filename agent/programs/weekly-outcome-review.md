---
name: Weekly Outcome Review
schedule: "0 9 * * 1"
enabled: true
model: claude-sonnet-4-6
deliver: true
---

Run the full LLM-as-Judge outcome review on Polymarket trade history.

Use the jarvis_outcome_review tool with full:true.

After it returns, summarize:
- Win rate and Brier score trend vs last week
- Which market types are performing best vs worst
- Top 2 actionable adjustments to the forecaster strategy
- Any calibration drift (overconfident or underconfident)

This runs every Monday at 9am to kick off the week with a learning loop update.
