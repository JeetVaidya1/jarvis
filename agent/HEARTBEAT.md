# Heartbeat Checklist
Run silently every 30 minutes. Only message Jeet if something needs attention. Otherwise respond with exactly: HEARTBEAT_OK

## Checks
- [ ] Are there any obvious system issues? Run `df -h /` to check disk space (flag if >90% used).
- [ ] Check system load with `uptime` — flag if load average exceeds 8.
- [ ] Any critical errors in recent shell history? Check `~/.zsh_history` tail for failed commands.

## Morning Briefing (7am only)
If current time is between 7:00-7:30am Pacific, send Jeet a morning briefing with:
- Today's date and day of week
- Weather in Kelowna (use `curl wttr.in/Kelowna?format=3`)
- Any important items from MEMORY.md that are relevant today
- A brief motivational note

## Rules
- Do NOT send a message for routine HEARTBEAT_OK results.
- Only alert Jeet if something genuinely needs attention.
- Keep heartbeat messages brief — one paragraph max unless critical.
