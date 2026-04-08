---
name: Weekly Self-Improvement
schedule: "0 9 * * 1"
enabled: true
timeout: 300000
---

Analyze the last 7 days of Jarvis logs and generate a self-improvement report.

**Steps:**

1. Use `shell_exec` to read the last 7 daily log files from `logs/`:
   ```
   ls -la logs/jarvis-*.log | tail -7
   ```
   Then read each one with `file_read`.

2. For each log file, identify:
   - **Tool failures**: lines containing "ERROR" or "failed" — group by tool name, count occurrences
   - **Slow operations**: any tool call or agent response that took >30 seconds
   - **Repeated patterns**: same tool called with same arguments multiple times (loop indicators)
   - **User corrections**: messages where Jeet says "no", "wrong", "stop", "don't" after an agent response

3. Compile a report with these sections:
   - **Error Summary**: top 5 most common errors with frequency and example
   - **Performance Issues**: slow tools or timeout patterns
   - **Behavioral Issues**: repeated mistakes, user corrections
   - **Unused Capabilities**: tools that were never called (potential removal candidates)
   - **Improvement Proposals**: concrete suggestions (system prompt edits, tool parameter changes)

4. For each improvement proposal, rate it:
   - **Low risk**: Safe to auto-apply (e.g., add a fact to memory, adjust a default parameter)
   - **Medium risk**: Should review first (e.g., change system prompt wording)
   - **High risk**: Needs discussion (e.g., remove a tool, change core behavior)

5. Auto-apply low-risk improvements by appending to memory using `memory_update`.

6. For high-risk proposals, create GitHub issues using `github_create_issue` on `JeetVaidya1/jarvis`.

7. Send the full report to Jeet as the response.
