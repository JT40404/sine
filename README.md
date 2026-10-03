# SINE website + market-data API

This is the SINE website together with its backend. The backend is a set of Vercel serverless functions that fetch real Solana market data from GeckoTerminal / CoinGecko, plus **SINE Forge**, a launchpad built on Meteora's bonding-curve programs. The Fourier analysis runs in the visitor's browser. There's no build step; Vercel installs the few npm dependencies (Solana and Meteora SDKs) automatically.

```
index.html            landing page
learn.html            plain-English guide: what SINE measures, how to read it, the edge, the limits (shows live $SINE stats once the token trades)
analyzer.html         live analyzer: contract lens, ecosystem pulse, or your own data
forge.html            SINE Forge: create wizard (any pair, fees, anti-sniper tax, vesting, LP locks)
coin.html             Forge coin page: trade, live launch tax, graduation, creator studio / fee router
explore.html          every coin launched through SINE
launch.html           the original pump.fun launchpad
config.js             ← official token address + social links
assets/               styles, Fourier core, page scripts, favicon
api/
  market.js           GET /api/market?address=<mint>&interval=1s…1d
  top.js              GET /api/top?weight=cap|equal     (Top 20 Solana market index)
  open.js             GET /api/open?id=<coingecko id>   (token → contract lens redirect)
  ecosystem.js        GET /api/ecosystem?interval=1m…1d (Core 6 on-chain basket)
  token.js            GET /api/token?address=<mint>
  forge.js            SINE Forge transaction builder (all Forge actions, one function)
  _lib/forge.js       launch form → Meteora DBC config (presets, limits, platform policy)
  health.js           GET /api/health
  _lib/gecko.js       data-provider client, windows, caching
  _lib/basket.js      ← Top 20 rules (size, filters, weight cap) + Core 6 tokens
vercel.json           clean URLs, function timeout, security headers
.env.example          environment variables (set these in Vercel, not in a file)
```

## Credits

The X and GitHub header icons come from [Simple Icons](https://simpleicons.org) (CC0). They are brand marks, used only to link to the SINE accounts.

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

## Plain-English layer

The analyzer opens in **Simple** view. **Detailed** view adds the cycle table, the spectrum and the measurement panel. The choice is remembered per browser.

**"What this means" summary.** Written in the browser from the live numbers every time the data refreshes. It covers:
- **Rhythm strength**, rated from how much of the movement the top rhythms explain:

  | Rating | Top three rhythms explain |
  |---|---|
  | No clear rhythm | under 15% |
  | Weak | 15%+ |
  | Moderate | 35%+ |
  | Strong | 55%+ |
  | Very strong | 75%+ |

  The rating is capped at Moderate if the rhythm repeated fewer than 3 times in the window, and at Weak if fewer than 2.
- **Where price is in the cycle right now**, plus the trend.
- **How the token relates to the market**: correlation and lead/lag. For Ecosystem pulse, this covers breadth and which tokens move first or follow.
- **How to use it**, with guidance matched to the rhythm strength.

The wording thresholds live in `summarize()` in `assets/analyzer.js`.

**Term explanations.** Every **?** button opens a plain-language definition. They are defined in `GLOSSARY` in the same file.

**`/learn`** walks through the idea, every number, every chart, six ways the information can sharpen a read of the market, and what SINE can't do.

## SINE Forge (`/forge`, `/coin`, `/explore`): the everything-launchpad

Forge pulls together the features of the other launchpads (pump.fun, letsbonk, Believe, Bags, Jupiter Studio, Heaven, Moonshot) in one place. It runs on **Meteora's Dynamic Bonding Curve (DBC)** and **DAMM v2**, the audited programs that power several of those launchpads. **Each coin gets its own on-chain config**, so every launch picks its own settings.

| Feature | How it works |
|---|---|
| **Pair with any token** | SOL, USDC or any SPL mint, such as STONK, OTC or your own coin. Buyers pay in that token, the curve is priced in it, and graduation pairs the coin with it. Mints with a freeze authority, or Token-2022 mints with extensions, are refused because they need a Meteora token badge. Add one-click suggestions in `config.js` → `forgePairs`. |
| **Anti-sniper launch tax** | A fee scheduler starts at up to 99% and decays to the normal fee, linear or exponential, over the time and number of steps you choose. Example: 99% → 1% over 60 s, dropping every second. Bots that buy in the first block pay the tax, and it goes to the fee claimers. The coin page shows a live countdown. |
| **Anti-bot volatility fee** | Optional dynamic fee that rises during violent price swings, both on the curve and after graduation. |
| **Fair dev buy** | The dev buy is in the same transaction as coin creation, so nobody can buy first. Optionally it pays only the minimum fee instead of the sniper tax. |
| **Modifiable fee schemes** | Trading fee 0.25–10%. Creator/platform split of the 80% that isn't Meteora's. Fees collected in the pair token or in both tokens. Separate fee after graduation (0.1–10%), paid out or **auto-compounded into liquidity**. Optional graduation fee (% of raised liquidity) with its own creator share. |
| **Curve** | Starting and graduation market cap, entered in USD or the pair token. Standard or two-segment shape, supply 1M–1T, 6–9 decimals, SPL or Token-2022. |
| **Locked liquidity** | At graduation the LP is split between creator and platform, each part permanently locked or unlocked. At least 10% must be locked. Locked LP keeps earning fees. |
| **Team vesting** | Optional team allocation locked on-chain: cliff after graduation, linear unlock, optional cliff unlock. |
| **Safety** | Metadata immutable by default with no mint authority. Every option is shown as a badge on the coin page, read from the chain. |
| **Vanity address** | Grind a coin address ending in up to 4 chosen characters, in browser Web Workers. |
| **Buyback & burn** | Coin page → Creator studio → fee router: claim fees → buy the coin → burn exactly what was bought. |
| **Add liquidity** | After graduation: the router buys half and adds both sides to the DAMM v2 pool, optionally **permanently locked**. Also available as a manual tool. |
| **Holder airdrops & fee sharing** | The router pays part of the fees pro-rata to the top 20 real holders (pool and locker accounts excluded) and/or to weighted fee-share wallets (Bags-style), batched 6 per transaction. |
| **Published fee plan** | The creator's planned split is stored in the coin's IPFS metadata (`extensions.sineForgeFeePlan`) and shown on the coin page. |
| **Auto router** | While the coin page is open, it checks every N minutes and runs the plan when unclaimed fees pass a threshold. The wallet approves each step. |
| **Trading** | Buy and sell on the curve, then on DAMM v2 after graduation, with quotes, slippage and balances. |
| **Graduation** | Meteora's migrator moves full curves automatically. Anyone can also push it from the coin page. |
| **Creator tools** | Claim creator fees, claim LP fees, withdraw surplus, withdraw graduation fee, transfer creator rights, burn. |
| **Platform revenue** | Optional, for the site owner: a share of trading fees, a launch fee and LP share. The platform wallet gets a "Claim platform fees" panel on each coin page. |
| **Explore** | New, about-to-graduate, graduated and top-market-cap lists, filtered by pair, with search and a progress bar on each coin. |
| **Presets** | Classic (pump.fun style), Sniper shield, Meme-pair, Stable-pair, Creator revenue, Fair & vested. |

**Non-custodial.** `/api/forge` only builds unsigned transactions. The coin's mint key and its config key are generated in the browser. The user's wallet signs and pays: one prompt for the two launch transactions. The server creates only throwaway LP-position NFT keys, which control nothing until the user's wallet signs.

**Fee flow (enforced by the program):** trading fee → 20% Meteora protocol, 80% split between creator and platform. With no platform wallet set, the creator is the fee claimer and receives the whole 80%.

**Setup (Vercel → Settings → Environment Variables, then redeploy):**
- `RPC_URL`: **required in practice.** Use a paid RPC such as Helius. Pool lookups by coin use `getProgramAccounts`, which public RPCs block.
- `PINATA_JWT`: image and metadata uploads, the same as for `/launch`.
- Upstash Redis (`KV_REST_API_*`): the Explore list and the ticker.
- Optional platform revenue:
  - `FORGE_PARTNER_WALLET`: your fee wallet
  - `FORGE_PLATFORM_FEE_SHARE`: % of the 80% the platform keeps (default 20)
  - `FORGE_POOL_CREATION_FEE_SOL`: launch fee, 0 or 0.001–100

**Test:**
- `npm test` runs an offline self-test:
  - every preset builds a config the Meteora SDK accepts, with and without a platform wallet
  - the launch transactions fit Solana's size limit
  - the sniper tax decays from 99% to 1%
  - bad inputs are rejected
  - the burn and payout builders work
- `node scripts/dev.mjs` serves the site and API locally. Add `--mock-chain` to click through the UI without a Solana connection.

**What it can't do (be upfront with users):**
- The fee router and auto router run from the creator's wallet while the page is open. The published plan is a public commitment, but the program doesn't enforce it. Holders can verify it from the on-chain history.
- Anti-bot protection is fee-based: launch tax and volatility fee. DBC has no max-wallet or per-transaction buy cap.
- Meteora's protocol fee (20% of trading fees) and its minimum fee (0.25%) apply.

**Before going public:**
- Do a small real launch on mainnet with your own wallet, then a trade, a claim, a buyback & burn, and a graduation.
- Read Meteora's terms.
- Get a legal review of running a launchpad and of how fees, buybacks and airdrops are described.

## Launchpad (`/launch`): pump.fun launches with Fourier-timed buyback & burn

People connect their own Solana wallet (Phantom, Solflare or Backpack) and can:

1. **Launch a coin on pump.fun.**
   - The image and details are stored on IPFS (Pinata).
   - PumpPortal's Local Transaction API builds the create transaction.
   - The browser signs it with a freshly generated coin key plus the user's wallet.
2. **Buy back and burn with creator fees**, on the Buyback & burn tab:
   - **Claim** the wallet's pump.fun creator fees into a per-coin buyback budget. pump.fun pays out fees for all of a creator's coins in one claim.
   - **Fourier timing** (`assets/buyback.js`) decides when to buy:
     - **BUY:** a real rhythm (Weak or better, p ≤ 0.3 against random walks), with price in the cycle's trough and turning up, and no high downward stress.
     - **FALLBACK:** buy anyway if no good trough comes within the max wait (24 h by default), so fees never sit idle.
     - **WAIT:** otherwise.
   - **Each round** buys with a tranche of the budget (50% by default), then burns exactly the tokens that arrived. It uses `BurnChecked`, and the token program (SPL or Token-2022) is detected from the coin itself.
   - **Auto mode** checks the timing every minute while the page is open and prompts the wallet to approve when it's time.
   - **"Burned so far"** is read from the chain: 1B starting supply minus current supply.

**Live chart.** Once a coin is loaded (after launching it, from the Buyback tab, from a ticker link, or via `/launch?mint=<address>`), the page shows a live chart:
- price, the Fourier rhythm fit, the "if the pattern holds" projection band, and buyback markers
- price, market cap and 24h change
- a one-line summary of the rhythm and the buyback signal
- refreshes every 30 seconds

**Launch ticker.** A scrolling strip of coins launched through SINE, with market cap and 24h change, pinned with your main token from `config.js`.
- **Recording:** each launch is recorded only after `/api/registry` verifies it on-chain. The transaction must have succeeded, been signed by both the new coin and the creator, and gone through the pump.fun program.
- **Storage:** needs Upstash Redis. In Vercel, go to Storage → Marketplace → Upstash Redis and connect it to the project; it adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. Redeploy afterwards.
- **Without storage,** the ticker shows only your main token.

**Security model: non-custodial.** The site never sees a private key.
- The coin's key is generated and used only in the browser.
- Every transaction is approved in the user's wallet.
- The server routes are narrow pass-throughs:
  - `/api/pump` builds `create`, `buy` and `collectCreatorFee` transactions via PumpPortal.
  - `/api/upload` pins to IPFS with your Pinata key.
  - `/api/rpc` relays an allowlist of Solana RPC methods through your RPC provider.
- Fully hands-off buybacks would need a server holding the creator's key, which this site deliberately does not do. Use SINE-BOT locally with your own wallet for that.

**Setup:** add these in Vercel → Settings → Environment Variables, then redeploy:
- `PINATA_JWT`: a free Pinata account → API Keys → JWT. pump.fun's own upload endpoint is retired, so launches need it.
- `RPC_URL`: a paid Solana RPC such as Helius or QuickNode. The URL can contain its key, since it stays server-side. The public RPC is heavily rate-limited.

**Before going public:**
- Read pump.fun's and PumpPortal's terms (pumpportal.fun/legal).
- Get a legal review of running a launchpad and of how buybacks are described.
- Do a small real launch and buyback yourself first.

Fees on each launch and trade are shown in the user's wallet before approval: pump.fun's creation fee, network fees, and PumpPortal's trading fee on buys.

## Statistical method (v2): random-walk-aware Fourier analysis

Informed by Öztürk (2025), *Exploring market efficiency in cryptocurrencies: Fourier analysis of non-linear dynamics and breaks*, Istanbul Business Research 54(3), 374–389 ([doi:10.26650/ibr.2025.54.1666799](https://doi.org/10.26650/ibr.2025.54.1666799)). The study tests 25 major coins against the random-walk (weak-form efficiency) null. It finds that tests allowing for **smooth structural breaks** and **non-linear mean reversion** reject the random walk for most coins, where linear tests don't.

**What changed in `assets/fourier.js`:**

1. **Real FFT for any window length.** Radix-2 plus Bluestein's algorithm replaces the direct DFT. It matches a direct DFT to within 1e-11 on every window length the site uses.
2. **Flexible Fourier trend** (Enders & Lee). log price = a + b·t + c·cos(2πk\*t/N) + s·sin(2πk\*t/N), with k\* searched over 0.1–1.5 by minimum SSR. This removes slow regime shifts before the spectrum, while staying below 1.5 cycles per window so it can't absorb a repeating rhythm.
3. **Fourier KSS test** (Kapetanios–Shin–Snell 2003; Christopoulos & León-Ledesma 2010). Δe = φ·e³₋₁ + Σ lags on the Fourier-trend residuals. It reports whether price pulls back toward its trend.
4. **Random-walk significance.** 200 simulated random walks of the same length run through the identical pipeline:
   - *Rhythm p-value:* peak prominence (power ÷ median power of nearby frequencies), compared with the **maximum** prominence in each simulation. This corrects for "look everywhere and something stands out."
   - *KSS and regime-shift p-values:* from the same simulations.
   - *Precomputed tables:* `assets/null-tables.js` covers the standard window lengths, so analysis takes about 3 ms. Other lengths are simulated on demand.
5. **Ranking.** Significant rhythms that repeat at least 3 times rank first, then significant 2-cycle swings (hard to tell from a slow shift), then the rest.

**Rating.** The strength rating is capped by the rhythm p-value:

| Rhythm p-value | Cap |
|---|---|
| ≤ 0.05 | none |
| ≤ 0.15 | Moderate |
| ≤ 0.30 | Weak |
| > 0.30 | No clear rhythm |

**Effect, measured on synthetic data (60 series each):**

| Case | Before | After |
|---|---|---|
| Pure random walks rated Moderate or better | 33% | 13% (≈ chance) |
| Pure random walks rated Strong or better | 10% | 2% |
| Real rhythms (with noise, random walk, regime shift or boom-bust) | found | found, 100% significant |
| Rhythm's share of movement under a boom-bust hump | 0.7% | 34.8% |

**Where it shows up.** The Detailed view's Measurement panel adds Rhythm vs. random walk, Mean reversion (Fourier KSS) and Slow regime shift. The summary adds a "Random or not?" paragraph, and `/learn` has a new section, "Is it just a random walk?"

## Stress check (v2.1): low-frequency surge in returns

Adapted from Jun, Ahn, Kim & Kim (2019), *Signal analysis of global financial crises using Fourier series*, Physica A 526, 121015 ([doi:10.1016/j.physa.2019.04.251](https://doi.org/10.1016/j.physa.2019.04.251)). The study turned stock-index returns in a short sliding window (12 monthly returns) into a Fourier series and tracked each mode's amplitude over time. It found that low-frequency components rise more sharply than high-frequency ones as global financial crises approach, across the US, UK and German markets.

**SINE's version** is `stressIndex()` in `assets/fourier.js`:

1. **Rolling spectrum.** Log returns go through a sliding window of L = 32 (16 for short series), step 1, and an FFT at each step.
2. **Statistic.** The share of return energy in the slowest L/8 modes. Normal random churn puts about 25% there.
3. **p-value.** A permutation test against the token's own returns in random order, 400 resamples. This keeps fat tails and volatility and removes only timing structure.
4. **History percentile.** Where the current value sits in its own history over the window.
5. **Level:**

| Level | Condition |
|---|---|
| High | p ≤ 0.05 and history percentile ≥ 80% |
| Elevated | p ≤ 0.10, or history percentile ≥ 90% |
| Calm | otherwise |

**Validation on synthetic data** (80 runs each, Calm / Elevated / High):

| Test series | Result |
|---|---|
| Random walk, normal returns | 73 / 6 / 1 |
| Random walk, fat-tailed returns | 75 / 5 / 0 |
| Volatility spike, random timing | 71 / 5 / 4 |
| Returns turning persistent | 0 / 0 / 80 |

**Where it shows up:**
- the "Stress check" panel, with a sparkline and the chance threshold
- a "Stress check" paragraph in the summary, including the direction of recent pressure
- a Measurement-panel row
- a `/learn` section

It flags pressure, not direction or timing. The article is paywalled, so this implements the method as described in its abstract, highlights and section summaries.

## Heatmap (spectrogram) view

The main chart toggles between **Waves**, which shows price against the rebuilt rhythm, and **Heatmap**, a spectrogram like an audio frequency analyzer. The choice is remembered per browser. It is built as follows:

- **Short-time Fourier transform.** The page repeats the analysis on a window sliding through the data, about 160 time slices. Each window is trend-removed and Hann-windowed.
- **Window length.** At least a quarter of the series, and long enough to hold about 2 cycles of the main rhythm where possible. It is capped at half the series and at 512 samples, so it stays fast on live refreshes.
- **Axes and colour.** The frequency axis is logarithmic. Colour uses the magma colour map on a 36 dB range.
- **Main-rhythm marker.** The dashed line marks f₁. "f₁ ↓" means the main rhythm is slower than the window can show.
- **Summary tie-in.** The summary reports persistence: the share of time slices where the main rhythm is at least half as strong as that slice's strongest rhythm. It also says whether the rhythm is strengthening or fading, comparing the latest third of the window with the earliest.

Code: `stft()` and `persistence()` in `assets/fourier.js`; `drawSpectrogram()` in `assets/analyzer.js`.

## Projections ("If the pattern holds")

Below the main chart, SINE projects the current pattern forward and shows how well that has worked on the same chart.

**The projection:**
1. Find the top three rhythms with the FFT.
2. Fit the trend plus those rhythms to log price by least squares.
3. Extend the fit forward, pinned to the last close.
4. The horizon is one main cycle, capped at a fifth of the window. The readout names the projected high and low, with timing and ranges.

**The track record (walk-forward test):**
1. At up to 12 earlier points in the chart, re-run the whole method using only the 60% of data before that point.
2. Project forward from there and compare with what actually happened.
3. Report:
   - **direction right %**, checked at ¼, ½, ¾ and the full horizon
   - **skill vs. "no change"**: 1 − (projection error ÷ error from assuming the price stays put)

**Band.** The 80th percentile of those past misses at each step ahead. With fewer than 6 tests, it falls back to typical past price moves over the same number of steps, and the page says the projection is untested.

**Verdict:**
| Verdict | Condition |
|---|---|
| "worked reasonably well" | skill ≥ 0.15 and direction ≥ 60% |
| "slight edge" | skill > 0 and direction ≥ 50% |
| "no better than no change" | otherwise; the line turns grey |

Checks on synthetic data:
| Test series | Direction right | Skill |
|---|---|---|
| Genuine rhythm | 88% | 0.94 |
| Rhythm plus heavy noise | 79% | 0.44 |
| Random walk | 42% | −0.60 |
| Rhythm that stopped halfway | 31% | strongly negative |

Code: `project()`, `forecastFrom()` and `harmonicFit()` in `assets/fourier.js`; `drawProjection()` in `assets/analyzer.js`. The projection is computed just after each chart update so the animation isn't delayed.

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
npm install
node scripts/dev.mjs                # pages + /api/* on http://localhost:3000 (reads .env)
node scripts/dev.mjs --mock-chain   # same, with Solana reads stubbed for UI work
npm test                            # Forge offline self-test
```

`vercel dev` also works.

Put your key in a `.env` file first if you have one. `.env` is gitignored.

## Notes

- Mint addresses in `basket.js` were correct as of writing. Verify them before deploying, and keep the basket to about 8 tokens.
- Everything on the site is measurement, not financial advice. Keep that line if you edit the copy.
