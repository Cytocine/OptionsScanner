# EMA10/EMA20 Bullish Call Cross Scanner

A GitHub Action port of the CytoOptions app's alert monitor: scans an options
chain (14+ DTE, 1-hour bars by default) for every symbol in your watchlist and
posts a Discord alert when a **call** contract's EMA10 crosses **above**
EMA20 within the last few candles. Puts and bearish crosses are ignored —
this is a calls-only, bullish-only scanner by design.

## What it does

For each underlying symbol:
1. Finds the nearest call expiration that is at least `MIN_DTE` days out.
2. Picks the strike closest to the current spot price at that expiration.
3. Pulls recent option bars at `TIMEFRAME` and computes EMA10/EMA20 on close.
4. Scans the last `CROSS_LOOKBACK_BARS` candles for a bullish cross (EMA10
   moving from at/below EMA20 to above it). If one is found, and it's a cross
   this scanner hasn't already alerted on (tracked by candle timestamp in
   `state.json`), it posts an embed to your Discord webhook.

Looking back a few candles (default 3) instead of only the very latest one
means a cross won't be missed if a run is delayed, skipped, or the workflow
takes a few minutes to start — but each cross still only fires one alert,
ever, since it's deduplicated by the exact candle timestamp it happened on.

## Setup

1. Create a new GitHub repo and push these files to it.
2. In **Settings → Secrets and variables → Actions → Secrets**, add:
   - `ALPACA_API_KEY`
   - `ALPACA_SECRET_KEY`
   - `DISCORD_WEBHOOK_URL` — a Discord channel webhook URL
3. (Optional) In **Settings → Secrets and variables → Actions → Variables**,
   add any of these to override defaults:
   - `ALPACA_ENV` — `paper` (default) or `live`
   - `OPTION_FEED` — `indicative` (default) or `opra` (shown in the alert footer only)
   - `TIMEFRAME` — Alpaca bar timeframe, default `1Hour`
   - `MIN_DTE` — minimum days to expiration, default `14`
   - `LOOKBACK_DAYS` — history window pulled for EMA calc, default `30`
   - `BAR_LIMIT` — max bars per request, default `500`
   - `CROSS_LOOKBACK_BARS` — how many recent candles count as "just crossed", default `3`
   - `MIN_BARS` — minimum bars required before trusting EMA20, default `25`
   - `SYMBOLS` — comma-separated tickers, default is the watchlist from the
     uploaded app (NVDA, TSLA, AAPL, AMZN, MSFT, META, AMD, PLTR, INTC, MU,
     GOOGL, NFLX, SOFI, ORCL, COIN, BABA, MARA, AVGO, DIS, F, SPY, IWM, QQQ,
     HOOD, JPM, C, BAC, XOM, OXY, UBER, ENPH, COST, NKE, LLY, MRK)
4. Make sure Actions has write permission: **Settings → Actions → General →
   Workflow permissions → "Read and write permissions"** (needed so the
   workflow can commit the updated `state.json` back to the repo).
5. The workflow runs on a cron schedule (`.github/workflows/ema-cross-scan.yml`,
   hourly during US market hours) and can also be triggered manually from the
   **Actions** tab (`workflow_dispatch`).

## Notes

- The cron in the workflow is in UTC and roughly targets 9:35am-4:35pm ET
  during EDT. Shift it by an hour for EST (winter), or widen the range by an
  hour on each side if you don't want to think about DST.
- `state.json` is committed back to the repo by the workflow after each run,
  so cross dedup persists across runs even though each Actions run is a fresh
  container.
- Strike selection here mirrors the app's batch scan mode: nearest expiration
  ≥ `MIN_DTE`, then the strike closest to spot (no delta targeting). If you
  want delta-targeted strike selection instead, that logic lives in the app's
  `fetchOptionSide()` and would need to be ported into `scripts/scan.js`.
- Indicative option data is delayed/lower quality vs. OPRA; `OPTION_FEED` is
  informational here (shown in the Discord footer) since bars/contracts
  endpoints used don't take a feed param the way the snapshot endpoint does.
- Because the nearest expiration ≥ `MIN_DTE` naturally gets closer to `MIN_DTE`
  every day, the selected contract will occasionally roll to the next
  expiration. A roll changes the option symbol (OSI), so its bar history
  effectively restarts — expect an occasional "fresh" cross right after a
  roll that isn't really a new bullish signal on the underlying.
