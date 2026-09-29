# SINE website + market-data API

This is the SINE website together with its backend. The backend is a set of Vercel serverless functions that fetch real Solana market data from GeckoTerminal / CoinGecko. The Fourier analysis runs in the visitor's browser. There's no build step and no npm dependencies.

```
index.html            landing page (shows live $SINE stats once the token trades)
analyzer.html         live analyzer: contract lens, ecosystem pulse, or your own data
config.js             ← official token address + social links
assets/               styles, Fourier core, page scripts, favicon
api/
  market.js           GET /api/market?address=<mint>&interval=1s…1d
  top50.js            GET /api/top50?weight=cap|equal   (Top 50 Solana market index)
  ecosystem.js        GET /api/ecosystem?interval=1m…1d (Core 6 on-chain basket)
  token.js            GET /api/token?address=<mint>
  health.js           GET /api/health
  _lib/gecko.js       data-provider client, windows, caching
  _lib/basket.js      ← Top 50 rules (size, exclusions, weight cap) + Core 6 tokens
vercel.json           clean URLs, function timeout, security headers
.env.example          environment variables (set these in Vercel, not in a file)
```

## Deploy

1. Push the contents of this folder to the root of a GitHub repository.
2. In Vercel, choose **Add New → Project** and import the repository. Set Framework preset to **Other** and leave the build settings empty.
3. Recommended: in Vercel, go to **Settings → Environment Variables** and add:
   - `COINGECKO_API_KEY`: a free Demo key from coingecko.com/en/api
   - `COINGECKO_PLAN`: `demo`, or `pro` if you have a paid key. A Pro key also turns on the 1s, 15s and 30s candles.

   Without a key, the site uses GeckoTerminal's keyless tier. That tier is rate-limited per IP address, and Vercel functions share IPs with other projects, so you'll see "rate-limiting" errors under real traffic. After adding the variables, redeploy.
4. Deploy. Then open `https://<your-domain>/api/health` to check that the functions are running and to see which data source is active.

## Set the official token

In `config.js`, replace `PASTE_SINE_MINT_ADDRESS_HERE` with the SINE mint address. The landing page then shows the address with a copy button. Once the token has a trading pool, it also shows live price, 24h change, liquidity and volume, refreshed every minute.

## Top 50 Solana market index

**Ecosystem pulse** opens on the **Top 50** index by default. It is built as follows:

1. **Membership.** On every refresh, the API pulls CoinGecko's *Solana ecosystem* ranking by market cap and walks down it until it has 50 eligible tokens. It skips:
   - stablecoins, liquid-staking tokens, and wrapped or bridged assets (by CoinGecko category, plus a stablecoin price check)
   - anything without a Solana contract address

   Tokens join and leave automatically as the rankings change. The rules are in `api/_lib/basket.js` (`TOP`).
2. **Prices.** All 50 tokens come from **one** API call: CoinGecko's hourly 7-day price history for each token. That's 168 hourly points per token, so this index runs on **1-hour candles over 7 days**, and the interval picker is locked while it's selected.
3. **Index.** Two weighting options:
   - **Market-cap weighted** (default). Weights follow market cap, but each token is capped at 20% so SOL doesn't become the whole index.
   - **Equal weighted.** Every token counts the same.
4. **Live.** The index level is recalculated from current prices every 2 minutes, and a live dot shows it on the chart.

The page shows:
- the index level, 24h and 7-day change
- breadth (how many of the 50 were up or down in the last 24h)
- the trend slope
- the Fourier readout
- a table of all 50 tokens with weight, 24h change, each token's own dominant cycle, correlation with the index, and whether it leads or lags the index

Click any token to open it in the contract lens.

In the contract lens at **1-hour** candles, a token is compared against the Top 50 index. At other intervals it is compared against the **Core 6** on-chain basket, which also remains available as a basket option at any interval from 1 minute up.

**API usage.** A Top 50 refresh costs 1 call. Category and contract-address lookups add about 6 calls, cached for 24 hours. The free Demo plan also has a **monthly** call limit, so check your usage in the CoinGecko dashboard once the site gets traffic.

## Candle intervals and real-time updates

| Interval | Candles analyzed | Window | Page refreshes every | Needs |
|---|---|---|---|---|
| 1 sec | 600 | 10 min | 2 s | CoinGecko **Pro** key |
| 15 sec | 720 | 3 h | 5 s | CoinGecko **Pro** key |
| 30 sec | 720 | 6 h | 10 s | CoinGecko **Pro** key |
| 1 min | 720 | 12 h | 15 s | — |
| 5 min | 576 | 2 d | 30 s | — |
| 15 min | 672 | 7 d | 60 s | — |
| 1 hour | 720 | 30 d | 2 min | — |
| 4 hours | 540 | 90 d | 5 min | — |
| 12 hours | 730 | 1 yr | 10 min | — |
| 1 day | 365 | 1 yr | 15 min | — |

CoinGecko's API only offers second-level candles on its paid **Pro** plan. When `COINGECKO_PLAN=pro` is set with a Pro key, the 1s, 15s and 30s options switch on automatically. Without one, those options stay greyed out. `/api/health` reports which intervals are available.

**What updates live on the page:**
- **Chart.** Each new closed candle slides in from the right, and the price and cycle curves morph to the new analysis.
- **Live dot.** A pulsing dot shows the still-forming candle's price. That candle is displayed but never analyzed.
- **Spectrum and dominant frequency.** Bar heights and the frequency number animate to their new values.
- **Cycle position.** The "where we are in the cycle" marker moves continuously at the measured f₁ frequency. The countdown to the next crest assumes the cycle holds.
- **Pausing.** Updates pause when the tab is hidden, and the **Live** checkbox stops them.
- **Reduced motion.** If the visitor's system asks for reduced motion, the page skips the animations.

**Contract lens (`/api/market?address=…&interval=…`):**
- Finds the token's most liquid pool.
- Returns its completed USD candles, with empty bars filled by the previous close, plus the forming candle.

The page then compares the token with the ecosystem basket, using 1-minute candles and longer.

**Ecosystem pulse (`/api/ecosystem?interval=…`):**
- Supports 1-minute candles and longer.
- Lines up every token in `api/_lib/basket.js` on the same timestamps and builds an equal-weight index.

**Caching.** Each response is cached at Vercel's edge for about as long as the page's refresh interval. However many people are watching, each token and interval costs about one upstream call per refresh period.

## Run locally

```bash
npm i -g vercel
vercel dev          # serves the pages and runs /api/* locally
```

Put your key in a `.env` file first if you have one. `.env` is gitignored.

## Notes

- Mint addresses in `basket.js` were correct as of writing. Verify them before deploying, and keep the basket to about 8 tokens.
- Everything on the site is measurement, not financial advice. Keep that line if you edit the copy.
