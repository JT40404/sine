# SINE website + market-data API

This is the SINE website together with its backend. The backend is a set of Vercel serverless functions that fetch real Solana market data from GeckoTerminal / CoinGecko. The Fourier analysis runs in the visitor's browser. There's no build step and no npm dependencies.

```
index.html            landing page (shows live $SINE stats once the token trades)
analyzer.html         live analyzer: contract lens, ecosystem pulse, or your own data
config.js             ← official token address + social links
assets/               styles, Fourier core, page scripts, favicon
api/
  market.js           GET /api/market?address=<mint>&interval=1s…1d
  top.js              GET /api/top?weight=cap|equal     (Top 20 Solana market index)
  open.js             GET /api/open?id=<coingecko id>   (token → contract lens redirect)
  ecosystem.js        GET /api/ecosystem?interval=1m…1d (Core 6 on-chain basket)
  token.js            GET /api/token?address=<mint>
  health.js           GET /api/health
  _lib/gecko.js       data-provider client, windows, caching
  _lib/basket.js      ← Top 20 rules (size, filters, weight cap) + Core 6 tokens
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

## Top 20 Solana market index

**Ecosystem pulse** opens on the **Top 20** index by default. It needs exactly **one** CoinGecko call per refresh, cached for 2 minutes, so it works on the free Demo plan.

1. **Membership.** The API takes CoinGecko's *Solana ecosystem* ranking by market cap and walks down it until it has 20 eligible tokens. It filters out tokens that aren't real market assets, using the data already in that one response:
   - **stablecoins**: USD/EUR/GBP in the symbol, or pinned near $1 all week
   - **liquid-staking tokens and other SOL derivatives**: hourly returns move with SOL almost exactly (correlation above 0.95)
   - **wrapped BTC/ETH and tokenized gold**: by symbol

   The page lists what was left out. You can force coins in or out, or change the size, in `api/_lib/basket.js` (`TOP`).
2. **Prices.** The index uses CoinGecko's 7-day hourly price history for each token, so it runs on **1-hour candles over 7 days**.
3. **Weighting.** Two options:
   - **Market-cap weighted** (default). Each token is capped at 20% of the index.
   - **Equal weighted.** Every token counts the same.
4. **Live.** The index level is recalculated from current prices every 2 minutes.

**Clicking a token** calls `/api/open`, which looks up the token's Solana contract address (one call, cached for a day) and opens it in the contract lens. At 1-hour candles, the contract lens compares a token against this Top 20 index. At other intervals it uses the **Core 6** on-chain basket, which is also still available as a basket option.

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

## Troubleshooting

Open **`/api/health?check=1`** on your deployed site. It calls both data providers and reports exactly what failed.

| Error | Cause | Fix |
|---|---|---|
| **HTTP 403 with no key** | CoinGecko or GeckoTerminal is blocking Vercel's shared server IPs on the keyless tier | Add a free Demo key as `COINGECKO_API_KEY` |
| **HTTP 403 with a key** | The key is inactive or mistyped | Regenerate it in the CoinGecko developer dashboard and paste it again |
| **HTTP 401 / error 10002** | The key is missing or wrong | Check `COINGECKO_API_KEY` |
| **Error 10010 / 10011** | The key type doesn't match `COINGECKO_PLAN` | Handled automatically: the API switches to the matching URL. Still set `COINGECKO_PLAN` correctly (`demo` or `pro`). The Vercel function logs say which one. |
| **Error 10005** | That data isn't included in your CoinGecko plan | Upgrade the plan or use a different interval |

After changing any environment variable in Vercel, **redeploy**. Existing deployments keep the old values.

## Run locally

```bash
npm i -g vercel
vercel dev          # serves the pages and runs /api/* locally
```

Put your key in a `.env` file first if you have one. `.env` is gitignored.

## Notes

- Mint addresses in `basket.js` were correct as of writing. Verify them before deploying, and keep the basket to about 8 tokens.
- Everything on the site is measurement, not financial advice. Keep that line if you edit the copy.
