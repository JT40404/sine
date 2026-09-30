# SINE Cycle Bands

SINE Cycle Bands is a chart overlay you read like Bollinger Bands. It runs SINE's Fourier analysis on a window that slides along the chart:

- **Midline**: the trend plus the rhythms SINE finds, evaluated at each bar. It is green while the rhythm is rising and red while it is falling.
- **Upper and lower bands**: the midline × exp(± 2σ). σ is the typical size of the movement the rhythms *don't* explain. Tight bands mean the cycles describe the price well. Wide bands mean they don't.
- **Crest and trough markers**: bars where the fitted rhythm turned.
- **Projection** (last bar only): the fitted trend and rhythms extended forward, pinned to the last close. By default it covers one main cycle, capped at a fifth of the window.
- **Stats panel**: main cycle length in bars and time, rhythm strength (same grading as the website), whether the rhythm is rising or falling, bars to the next expected turn, and the trend.

Each bar uses only the bars up to and including itself, so **past values never repaint**. Only the projection moves as new bars arrive.

| File | For |
|---|---|
| `sine-cycle-bands.pine` | **TradingView** (Pine Script v6): any chart, including Solana DEX pairs |
| `charting-library.js` | Platforms built on the **TradingView Charting Library / Trading Platform**; must be added by the platform's developers |
| `sine-bands.js` | The shared math in plain JavaScript, with no dependencies: bots, backtests, other charting libraries, the SINE site |

## Where it can be used

**TradingView: works today.** Paste the Pine script into the Pine Editor. TradingView carries most Solana DEX pools (search the token's ticker or pair address).

**Axiom, Terminal (Padre) and similar trading terminals: not directly.** These terminals embed TradingView's *Charting Library*. That's a separate product from tradingview.com, and it can't import Pine scripts or user indicators. Only the built-in studies, plus any custom indicators the platform's own developers compile in through `custom_indicators_getter`, appear in their indicator menu. I couldn't find public documentation showing either platform accepts third-party indicators. The realistic routes are:

1. **Use TradingView side by side** for the bands, and trade on the terminal.
2. **Pitch it to the platform.** `charting-library.js` is exactly the file their developers would add. It's the standard Charting Library custom-indicator format, has no dependencies, and is a few KB.
3. **A browser extension overlay** that reads the terminal's candles and draws on top. This is possible but fragile (it breaks when their site changes) and may conflict with their terms. It isn't built here.

## Install on TradingView

1. Open a chart → **Pine Editor** (bottom panel) → **Open → New indicator**.
2. Replace everything with the contents of `sine-cycle-bands.pine` → **Save** → **Add to chart**.
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

## Tested

`sine-bands.js` has been checked in Node on synthetic data (128-bar window):

| Series | Main cycle found | Strength | Closes inside the bands |
|---|---|---|---|
| 40- and 17-bar rhythms + light noise | 40.1 and 17.0 bars | 99% (Very strong) | 93% |
| 40-bar rhythm + heavy noise | 39.9 bars | 79% | 95% |
| Random walk (200 runs) | — | median 27%, 90th percentile 70% | 79% |

A random walk can still show a "rhythm" by chance. Treat single readings with care, and prefer rhythms that persist across many bars.

`charting-library.js` was run bar by bar against a mock of the library's runtime and matches `sine-bands.js` exactly. The Pine script uses the same algorithm step for step, but it has **not yet been compiled on TradingView**. Report any editor error and it will be fixed.

## Use the JS directly

```js
import "./sine-bands.js";                 // or <script src="sine-bands.js">
const out = SineBands.compute(closes, { length: 128, rhythms: 3, mult: 2 });
// out.mid / out.upper / out.lower / out.cycleSlope / out.strength / out.periodBars / out.crest / out.trough
const last = SineBands.analyzeWindow(closes.slice(-128));
SineBands.grade(last);        // "Strong"
SineBands.nextTurn(last);     // { bars: 6, kind: "crest" }
SineBands.project(last, 0);   // [{ h, mid, upper, lower }, …]
```
