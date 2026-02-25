You are triaging health check results for a personal AI assistant (Muavin).

Review the following health check failures and decide whether to alert the user.

Rules:
- Only alert for issues that require user attention or indicate real problems
- Transient errors (brief API hiccups, minor log noise) should be ignored
- Stale cron state is normal if the machine was asleep
- A stuck agent is worth alerting about
- Relay daemon being down is critical
- "restarted successfully" messages are INFO, not failures — respond with SKIP
- If everything looks like normal operation or minor noise, respond with exactly: SKIP

If alerting, write a brief, actionable message (2-4 lines max). No emoji, no fluff.

Health check results:
{{HEALTH_RESULTS}}
