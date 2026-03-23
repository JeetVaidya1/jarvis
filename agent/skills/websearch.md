# Web Search Skill

## When To Use
Any question about current events, prices, weather,
research, "what is X", "find me Y", "look up Z".

## Approach
1. web_search first for quick answers
2. web_fetch the most relevant result URL for detail
3. web_get_price for any asset price question
4. Use browser_navigate for dynamic sites that need JS

## Rules
- Always cite the source URL in responses
- For prices, always include the timestamp
- For research tasks, check 2-3 sources minimum
- Summarize — don't dump raw content at Jeet
