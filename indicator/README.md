# SINE chart indicators

There are two indicators:

- **SINE Cycle Bands**: an overlay on the price chart, read like Bollinger Bands.
- **SINE Stress**: an oscillator in its own pane, the site's Stress check computed on every bar ([details below](#sine-stress)).

## SINE Cycle Bands

SINE Cycle Bands is a chart overlay you read like Bollinger Bands. It runs SINE's Fourier analysis on a window that slides along the chart:

- **Midline**: the trend plus the rhythms SINE finds, evaluated at each bar. It is green while the rhythm is rising and red while it is falling.
- **Upper and lower bands**: the midline × exp(± 2σ). σ is the typical size of the movement the rhythms *don't* explain. Tight bands mean the cycles describe the price well. Wide bands mean they don't.
- **Crest and trough markers**: bars where the fitted rhythm turned.
- **Projection** (last bar only): the fitted trend and rhythms extended forward, pinned to the last close. By default it covers one main cycle, capped at a fifth of the window.
- **Stats panel**: main cycle length in bars and time, rhythm strength (same grading as the website), whether the rhythm is rising or falling, bars to the next expected turn, and the trend.

Each bar uses only the bars up to and including itself, so **past values never repaint**. Only the projection moves as new bars arrive.

| File | For |
|---|---|
| `sine-cycle-bands.pine` | Cycle Bands for **TradingView** (Pine Script v6): any chart, including Solana DEX pairs |
| `sine-stress.pine` | Stress for **TradingView** (Pine Script v6) |
| `charting-library.js` | Both indicators for platforms built on the **TradingView Charting Library / Trading Platform**; must be added by the platform's developers |
| `sine-bands.js`, `sine-stress.js` | The shared math in plain JavaScript, with no dependencies: bots, backtests, other charting libraries, the SINE site |

## Where it can be used

**TradingView: works today.** Paste the Pine script into the Pine Editor. TradingView carries most Solana DEX pools (search the token's ticker or pair address).

**Axiom, Terminal (Padre) and similar trading terminals: not directly.** These terminals embed TradingView's *Charting Library*. That's a separate product from tradingview.com, and it can't import Pine scripts or user indicators. Only the built-in studies, plus any custom indicators the platform's own developers compile in through `custom_indicators_getter`, appear in their indicator menu. I couldn't find public documentation showing either platform accepts third-party indicators. The realistic routes are:

1. **Use TradingView side by side** for the bands, and trade on the terminal.
2. **Pitch it to the platform.** `charting-library.js` is exactly the file their developers would add. It's the standard Charting Library custom-indicator format, has no dependencies, and is a few KB.
3. **A browser extension overlay** that reads the terminal's candles and draws on top. This is possible but fragile (it breaks when their site changes) and may conflict with their terms. It isn't built here.

## Install on TradingView

1. Open a chart → **Pine Editor** (bottom panel) → **Open → New indicator**.
2. Replace everything with the contents of `sine-cycle-bands.pine` (or `sine-stress.pine`) → **Save** → **Add to chart**.
3. To share it, click **Publish script**. *Invite-only* keeps the source private. *Open-source* lets anyone add it from the Indicators menu by name.

Alerts: **Alert → Condition: SINE Cycle Bands**. You can alert on price above the upper band, price below the lower band, a rhythm crest, or a rhythm trough.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Window (bars) | 128 | Bars analyzed at each point. A rhythm must repeat at least twice to be found, so the longest detectable cycle is half the window. Longer windows give steadier readings but react more slowly. |
| Rhythms to fit | 3 | Same as the website's top three rhythms |
| Band width (× σ) | 2 | Like Bollinger's 2 standard deviations. With a real rhythm, about 93–95% of closes stay inside in tests. |
| Calculate over last N bars | 2000 | Pine only. Lower it if TradingView reports a calculation timeout on large windows. |
| Projection length | 0 = one main cycle | Up to 500 bars |

## How to read it

- **Check strength first.** "Weak" or "No clear rhythm" means the midline is mostly trend, and the crest and trough markers are noise. The bands still work as a volatility envelope.
- **With Moderate or better**, the midline's color flips around cycle turns, and closes outside the bands are unusually large moves relative to the rhythm.
- The **next-turn estimate assumes the rhythm holds**. Rhythms in crypto fade and shift, which is what the website's heatmap view shows.

This is measurement, not financial advice.

## SINE Stress

SINE Stress is the site's **Stress check** (`stressIndex()` in `assets/fourier.js`), computed on every bar so you can see its history and set alerts on it. It follows Jun, Ahn, Kim & Kim (2019), *Signal analysis of global financial crises using Fourier series*, Physica A 526, 121015 ([doi:10.1016/j.physa.2019.04.251](https://doi.org/10.1016/j.physa.2019.04.251)). They found that the low-frequency Fourier components of index returns surged ahead of global financial crises.

**On every bar**, using the last 32 log returns (16 and 64 are also available):

1. Remove the mean, then take the DFT.
2. **Stress** = the energy in the slowest 1/8 of the modes ÷ the energy in all modes except zero and Nyquist.
3. Independent returns (random churn) put about **27%** there, shown as the grey line. Higher values mean returns are persistent, with pressure building in one direction.
4. **p-value vs. random**: the chance independent returns reach this level. For independent normal returns the Fourier energies are independent exponentials, so Stress follows an exact Beta(4, 11) distribution (for a 32-return window). That makes an exact p-value cheap enough to compute on every bar. The red dotted line is the p = 0.05 level (about 47%).
5. **History percentile**: the share of the last 500 bars with a lower value.
6. **Level**: shading in the pane and in the stats panel.

| Level | Condition (same rules as the site) |
|---|---|
| High | p ≤ 0.05 and history percentile ≥ 80% |
| Elevated | p ≤ 0.10, or history percentile ≥ 90% |
| Calm | otherwise |

The line is **green when price rose over the window and red when it fell**, which shows the direction of the pressure. Alerts are available for High, Elevated, and back to Calm.

**How it differs from the site.** The site runs a 400-shuffle permutation test against the token's own returns once per refresh. That's too slow to repeat on every bar of a chart, so the indicator uses the exact Beta null instead, and leaves out the Nyquist mode so the Beta result is exact. On the site's own validation scenarios the two methods agree closely.

**Validation** (80 synthetic 720-bar series per row):

| Series | Bars with p ≤ 0.05 | Final level Calm / Elevated / High | Site's level | Same level as site |
|---|---|---|---|---|
| Random walk, normal returns | 4.0% | 70 / 9 / 1 | 73 / 5 / 2 | 76 / 80 |
| Random walk, fat-tailed returns (t₃) | 4.2% | 70 / 3 / 7 | 70 / 2 / 8 | 79 / 80 |
| Volatility spike, random timing | 4.2% | 66 / 9 / 5 | 67 / 7 / 6 | 72 / 80 |
| Returns turning persistent (last 80 bars) | 13.4% | 2 / 2 / 76 | 2 / 1 / 77 | 79 / 80 |

The false-alarm rate on random data stays at or below the nominal 5%, including with fat tails and volatility spikes. Persistent returns are caught.

**Read it as pressure, not a signal.** Stress says returns have stopped behaving like random churn. It doesn't say which way price goes next or when. Pair it with the line colour (direction so far) and with Cycle Bands.

## Tested (Cycle Bands)

`sine-bands.js` has been checked in Node on synthetic data (128-bar window):

| Series | Main cycle found | Strength | Closes inside the bands |
|---|---|---|---|
| 40- and 17-bar rhythms + light noise | 40.1 and 17.0 bars | 99% (Very strong) | 93% |
| 40-bar rhythm + heavy noise | 39.9 bars | 79% | 95% |
| Random walk (200 runs) | — | median 27%, 90th percentile 70% | 79% |

A random walk can still show a "rhythm" by chance. Treat single readings with care, and prefer rhythms that persist across many bars.

Both wrappers in `charting-library.js` (Cycle Bands and Stress) were run bar by bar against a mock of the library's runtime and match the JS exactly. The Pine scripts use the same algorithm step for step, but they have **not yet been compiled on TradingView**. Report any editor error and it will be fixed.

## Use the JS directly

```js
import "./sine-bands.js";                 // or <script src="sine-bands.js">
const out = SineBands.compute(closes, { length: 128, rhythms: 3, mult: 2 });
// out.mid / out.upper / out.lower / out.cycleSlope / out.strength / out.periodBars / out.crest / out.trough
const last = SineBands.analyzeWindow(closes.slice(-128));
SineBands.grade(last);        // "Strong"
SineBands.nextTurn(last);     // { bars: 6, kind: "crest" }
SineBands.project(last, 0);   // [{ h, mid, upper, lower }, …]

import "./sine-stress.js";
const st = SineStress.compute(closes, { length: 32, history: 500 });
// st.share / st.p / st.histPct / st.level (0 Calm, 1 Elevated, 2 High) / st.move / st.expected / st.q95
```
