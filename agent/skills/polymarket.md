# Polymarket Trading Skill

## When To Use
Any message about: Polymarket, trading, positions, markets,
placing bets, checking portfolio, P&L, prediction markets.

## Trading Rules (non-negotiable)
- ALWAYS run polymarket_get_market first before any trade recommendation
- ALWAYS use dryRun:true first, show Jeet the simulation, get confirmation
- NEVER place a live order without explicit "yes" confirmation from Jeet
- NEVER place a single order over $50 USDC without extra confirmation
- Log every trade (real and simulated) via memory_update

## Analysis Framework
Before recommending a trade, evaluate:
1. Current probability vs your estimated true probability
2. Volume and liquidity (avoid thin markets)
3. Time to resolution (prefer shorter windows for arb)
4. Order book spread (wide spread = bad entry)
5. Edge = (your_prob - market_prob). Only trade if edge > 5%

## Position Sizing
- Max 20% of bankroll per single position
- Max 3 open positions at once
- Prefer $10-30 size for testing new markets

## Workflow
Check positions → analyze market → calculate edge →
dry run → confirm → place → log → monitor
