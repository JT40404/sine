# SINE website + market-data API

This is the SINE website together with its backend. The backend is a set of Vercel serverless functions that fetch real Solana market data from GeckoTerminal / CoinGecko. The Fourier analysis runs in the visitor's browser. There's no build step and no npm dependencies.

```
index.html            landing page (shows live $SINE stats once the token trades)
analyzer.html         live analyzer: contract lens, ecosystem pulse, or your own data
config.js             ← official token address + social links
assets/               styles, Fourier core, page scripts, favicon
api/
  market.js           GET /api/market?address=<mint>&window=1d|7d|30d|90d
  ecosystem.js        GET /api/ecosystem?window=1d|7d|30d|90d
  token.js            GET /api/token?address=<mint>
  health.js           GET /api/health
  _lib/gecko.js       data-provider client, windows, caching
  _lib/basket.js      ← tokens in the "Solana ecosystem" basket
vercel.json           clean URLs, function timeout, security headers
.env.example          environment variables (set these in Vercel, not in a file)
```

## Deploy

1. Push the contents of this folder to the root of a GitHub repository.
2. In Vercel, choose **Add New → Project** and import the repository. Set Framework preset to **Other** and leave the build settings empty.
3. Recommended: in Vercel, go to **Settings → Environment Variables** and add:
   - `COINGECKO_API_KEY`: a free Demo key from coingecko.com/en/api
   - `COINGECKO_PLAN`: `demo`, or `pro` if you have a paid key

   Without a key, the site uses GeckoTerminal's keyless tier. That tier is rate-limited per IP address, and Vercel functions share IPs with other projects, so you'll see "rate-limiting" errors under real traffic. After adding the variables, redeploy.
4. Deploy. Then open `https://<your-domain>/api/health` to check that the functions are running and to see which data source is active.

## Set the official token

In `config.js`, replace `PASTE_SINE_MINT_ADDRESS_HERE` with the SINE mint address. The landing page then shows the address with a copy button. Once the token has a trading pool, it also shows live price, 24h change, liquidity and volume, refreshed every minute.

## How the data flows

| Window | Candle | Samples |
|---|---|---|
| 1d | 5m | 288 |
| 7d | 15m | 672 |
| 30d | 1h | 720 |
| 90d | 4h | 540 |

**Contract lens (`/api/market`):**
- Finds the token's most liquid pool.
- Fetches USD candles for that pool.
- Keeps only completed candles.
- Fills empty bars with the previous close, so the samples are evenly spaced as Fourier analysis requires.

The analyzer then runs the analysis and compares the token with the ecosystem basket. It reports the correlation of the detrended prices, and the phase lead or lag at the token's dominant frequency.

**Ecosystem pulse (`/api/ecosystem`):**
- Fetches every token in `api/_lib/basket.js`.
- Lines their candles up on the same timestamps.
- Builds an equal-weight index from them.

The analyzer analyzes that index, then shows each token's own dominant period, its correlation with the index, and its phase against the index.

**Caching.** Responses are cached at Vercel's edge: 1–2 minutes for token data and 5 minutes for the basket. Many visitors therefore cost only a few upstream calls. The analyzer auto-refreshes on the same schedule.

## Run locally

```bash
npm i -g vercel
vercel dev          # serves the pages and runs /api/* locally
```

Put your key in a `.env` file first if you have one. `.env` is gitignored.

## Notes

- Mint addresses in `basket.js` were correct as of writing. Verify them before deploying, and keep the basket to about 8 tokens.
- Everything on the site is measurement, not financial advice. Keep that line if you edit the copy.
