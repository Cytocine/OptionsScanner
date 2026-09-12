#!/usr/bin/env node
/**
 * EMA10 / EMA20 bullish-crossover scanner for CALL option contracts (Alpaca)
 * -> Discord alerts.
 *
 * Ported from the CytoOptions browser app's runAlertScan() + fetchOptionSide()
 * logic: for each underlying, picks the nearest expiration at/after MIN_DTE
 * and the strike closest to spot, pulls historical option bars, computes
 * EMA10/EMA20 on close, and fires a Discord webhook when EMA10 crosses above
 * EMA20 within the last CROSS_LOOKBACK_BARS candles. Puts and bearish crosses
 * are intentionally ignored — this is a calls-only, bullish-only scanner.
 *
 * Each cross is identified by the timestamp of the candle it occurred on, and
 * that timestamp is recorded per symbol in state.json (committed back to the
 * repo by the workflow) so the same cross never fires more than one alert,
 * even though a hit stays inside the lookback window for a few runs in a row.
 *
 * Env vars:
 *   ALPACA_API_KEY        (required)
 *   ALPACA_SECRET_KEY     (required)
 *   DISCORD_WEBHOOK_URL   (required)
 *   ALPACA_ENV            "paper" | "live"        default "paper"
 *   OPTION_FEED           "indicative" | "opra"    default "indicative" (informational; used in the Discord footer)
 *   TIMEFRAME             Alpaca bar timeframe      default "1Hour"
 *   MIN_DTE               minimum days to expiry    default 14
 *   LOOKBACK_DAYS         history window for bars   default 30
 *   BAR_LIMIT             max bars per request      default 500
 *   CROSS_LOOKBACK_BARS   how many recent candles count as "just crossed"  default 3
 *   MIN_BARS              minimum bars required before trusting EMA20      default 25
 *   SYMBOLS               comma-separated tickers  (default: the watchlist from the uploaded app)
 */

import fs from 'node:fs';
import path from 'node:path';

const STATE_PATH = path.join(process.cwd(), 'state.json');

// GitHub Actions renders an unset `vars.X` as an empty string, not undefined,
// so plain destructuring defaults (`X = 'default'`) don't catch it — only
// `undefined` triggers those. Use this helper for every optional env var so
// a blank repo/environment Variable falls back to the default instead of
// silently becoming ''.
function envOr(value, fallback) {
  return value === undefined || value === '' ? fallback : value;
}

const env = process.env;
const ALPACA_API_KEY = env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = env.ALPACA_SECRET_KEY;
const DISCORD_WEBHOOK_URL = env.DISCORD_WEBHOOK_URL;
const ALPACA_ENV = envOr(env.ALPACA_ENV, 'paper');
const OPTION_FEED = envOr(env.OPTION_FEED, 'indicative');
const TIMEFRAME = envOr(env.TIMEFRAME, '1Hour');
const MIN_DTE = envOr(env.MIN_DTE, '14');
const LOOKBACK_DAYS = envOr(env.LOOKBACK_DAYS, '30');
const BAR_LIMIT = envOr(env.BAR_LIMIT, '500');
const CROSS_LOOKBACK_BARS = envOr(env.CROSS_LOOKBACK_BARS, '3');
const MIN_BARS = envOr(env.MIN_BARS, '25');
const SYMBOLS = envOr(
  env.SYMBOLS,
  'NVDA,TSLA,AAPL,AMZN,MSFT,META,AMD,PLTR,INTC,MU,GOOGL,NFLX,SOFI,ORCL,COIN,BABA,MARA,AVGO,DIS,F,SPY,IWM,QQQ,HOOD,JPM,C,BAC,XOM,OXY,UBER,ENPH,COST,NKE,LLY,MRK'
);

if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) {
  console.error('Missing ALPACA_API_KEY / ALPACA_SECRET_KEY');
  process.exit(1);
}
if (!DISCORD_WEBHOOK_URL) {
  console.error('Missing DISCORD_WEBHOOK_URL');
  process.exit(1);
}

const HEADERS = {
  'APCA-API-KEY-ID': ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
  accept: 'application/json',
};
const TRADING_HOST = ALPACA_ENV === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
const DATA_HOST = 'https://data.alpaca.markets';
const MIN_DTE_N = parseInt(MIN_DTE, 10);
const LOOKBACK_N = parseInt(LOOKBACK_DAYS, 10);
const BAR_LIMIT_N = parseInt(BAR_LIMIT, 10);
const CROSS_LOOKBACK_N = parseInt(CROSS_LOOKBACK_BARS, 10);
const MIN_BARS_N = parseInt(MIN_BARS, 10);
const SYMS = SYMBOLS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} for ${url} :: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Same exponential-smoothing formula as calculateEMA() in the uploaded app.
function calculateEMA(bars, period) {
  const k = 2 / (period + 1);
  const ema = [];
  if (bars.length === 0) return ema;
  let cur = bars[0].c;
  for (let i = 0; i < bars.length; i++) {
    cur = bars[i].c * k + cur * (1 - k);
    ema.push(cur);
  }
  return ema;
}

// Returns the index of the most recent bar where EMA10 crossed from
// <= EMA20 to > EMA20, scanning only the last `windowBars` transitions.
// Returns null if no bullish cross happened inside that window.
function findRecentBullishCross(ema10, ema20, windowBars) {
  const last = ema10.length - 1;
  const start = Math.max(1, last - windowBars + 1);
  let found = null;
  for (let i = start; i <= last; i++) {
    const prevDiff = ema10[i - 1] - ema20[i - 1];
    const currDiff = ema10[i] - ema20[i];
    if (prevDiff <= 0 && currDiff > 0) found = i; // keep the latest match
  }
  return found;
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    parsed.positions ||= {};
    return parsed;
  } catch {
    return { positions: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchSnapshots(symbols) {
  const out = {};
  for (const group of chunk(symbols, 50)) {
    const url = `${DATA_HOST}/v2/stocks/snapshots?symbols=${group.join(',')}&feed=iex`;
    const data = await fetchJson(url);
    Object.assign(out, data);
  }
  return out;
}

async function fetchAllContracts(symbols, type, minExpiryStr, maxExpiryStr) {
  const all = [];
  for (const group of chunk(symbols, 50)) {
    let pageToken = null;
    do {
      let url =
        `${TRADING_HOST}/v2/options/contracts?underlying_symbols=${group.join(',')}` +
        `&status=active&expiration_date_gte=${minExpiryStr}&expiration_date_lte=${maxExpiryStr}` +
        `&type=${type}&limit=1000`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
      const data = await fetchJson(url);
      all.push(...(data.option_contracts || []));
      pageToken = data.next_page_token || null;
    } while (pageToken);
  }
  return all;
}

async function fetchOptionBars(osiList) {
  const barsBySymbol = {};
  const startStr = isoDate(new Date(Date.now() - LOOKBACK_N * 24 * 60 * 60 * 1000));
  for (const group of chunk(osiList, 30)) {
    let pageToken = null;
    do {
      let url =
        `${DATA_HOST}/v1beta1/options/bars?symbols=${group.join(',')}` +
        `&timeframe=${TIMEFRAME}&start=${startStr}&limit=${BAR_LIMIT_N}`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
      const data = await fetchJson(url);
      for (const [sym, bars] of Object.entries(data.bars || {})) {
        (barsBySymbol[sym] ||= []).push(...bars);
      }
      pageToken = data.next_page_token || null;
    } while (pageToken);
  }
  return barsBySymbol;
}

async function postDiscord(target, crossBar, barsAgo, ema10Last, ema20Last, lastBar) {
  const embed = {
    title: `🐂 Bullish Cross (Call): ${target.symbol}`,
    description: `EMA10 crossed above EMA20 ${barsAgo === 0 ? 'on the latest' : `${barsAgo} candle(s) ago on the`} ${TIMEFRAME} candle.`,
    color: 0x22c55e,
    fields: [
      { name: 'Contract', value: target.osi, inline: false },
      { name: 'Strike', value: `$${target.strike}`, inline: true },
      { name: 'Expiration', value: `${target.expiration} (${target.dte} DTE)`, inline: true },
      { name: 'Cross Candle', value: crossBar.t, inline: true },
      { name: 'Last Price', value: lastBar ? `$${lastBar.c.toFixed(2)}` : '—', inline: true },
      { name: 'EMA10 / EMA20', value: `${ema10Last.toFixed(3)} / ${ema20Last.toFixed(3)}`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `Alpaca ${ALPACA_ENV} · ${OPTION_FEED} feed` },
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Discord post failed: ${res.status} ${body}`);
  }
}

async function main() {
  console.log(
    `Scanning ${SYMS.length} symbols · timeframe=${TIMEFRAME} · minDTE=${MIN_DTE_N}+ · env=${ALPACA_ENV} · feed=${OPTION_FEED}`
  );

  const minExpiryStr = isoDate(new Date(Date.now() + MIN_DTE_N * 24 * 60 * 60 * 1000));
  const maxExpiryStr = isoDate(new Date(Date.now() + (MIN_DTE_N + 60) * 24 * 60 * 60 * 1000));

  const snapshots = await fetchSnapshots(SYMS);
  const allContracts = await fetchAllContracts(SYMS, 'call', minExpiryStr, maxExpiryStr);

  // For each symbol: nearest expiration that satisfies MIN_DTE, then the
  // strike closest to the current spot price (same rule as the app's batch
  // runAlertScan(), which does not do delta-targeted selection). Calls only.
  const targets = [];
  for (const sym of SYMS) {
    const spot = snapshots[sym]?.latestTrade?.p;
    if (spot == null) continue;
    const pool = allContracts.filter((c) => c.underlying_symbol === sym);
    if (pool.length === 0) continue;
    const nearestExpiration = pool.reduce(
      (soonest, c) => (!soonest || c.expiration_date < soonest ? c.expiration_date : soonest),
      null
    );
    const atExpiry = pool.filter((c) => c.expiration_date === nearestExpiration);
    const contract = atExpiry.sort(
      (a, b) => Math.abs(a.strike_price - spot) - Math.abs(b.strike_price - spot)
    )[0];
    if (!contract) continue;
    const dte = Math.round((new Date(contract.expiration_date) - Date.now()) / 86400000);
    targets.push({
      symbol: sym,
      side: 'call',
      osi: contract.symbol,
      strike: contract.strike_price,
      expiration: contract.expiration_date,
      dte,
    });
  }

  console.log(`Resolved ${targets.length} call targets (min ${MIN_DTE_N} DTE)`);
  if (targets.length === 0) return;

  const barsBySymbol = await fetchOptionBars(targets.map((t) => t.osi));

  const state = loadState();
  let checked = 0;
  const alerts = [];

  for (const t of targets) {
    const bars = (barsBySymbol[t.osi] || []).slice().sort((a, b) => new Date(a.t) - new Date(b.t));
    if (bars.length < MIN_BARS_N) continue;
    checked++;

    const ema10 = calculateEMA(bars, 10);
    const ema20 = calculateEMA(bars, 20);
    const last = bars.length - 1;

    const crossIdx = findRecentBullishCross(ema10, ema20, CROSS_LOOKBACK_N);
    if (crossIdx === null) continue; // no bullish cross within the lookback window

    const crossBar = bars[crossIdx];
    const key = `${t.symbol}:call`;
    const alreadyAlerted = state.positions[key]?.lastAlertedCrossTime === crossBar.t;
    if (alreadyAlerted) continue; // same cross we already alerted on — don't repeat

    state.positions[key] = { lastAlertedCrossTime: crossBar.t };
    alerts.push({
      target: t,
      crossBar,
      barsAgo: last - crossIdx,
      ema10Last: ema10[last],
      ema20Last: ema20[last],
      lastBar: bars[last],
    });
  }

  for (const a of alerts) {
    await postDiscord(a.target, a.crossBar, a.barsAgo, a.ema10Last, a.ema20Last, a.lastBar);
    console.log(`Alert sent: ${a.target.symbol} call, crossed ${a.barsAgo} bar(s) ago`);
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  console.log(`Checked ${checked} charts · ${alerts.length} alert(s) sent`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
