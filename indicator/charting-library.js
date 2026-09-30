/*
 * SINE Cycle Bands for platforms built on the TradingView Charting Library / Trading Platform
 * (the embedded chart used by many trading terminals). Only the platform's own developers can add it,
 * via the widget's `custom_indicators_getter` option:
 *
 *   <script src="sine-bands.js"></script>
 *   <script src="charting-library.js"></script>
 *   new TradingView.widget({
 *     ...,
 *     custom_indicators_getter: SineChartingLibrary.customIndicatorsGetter
 *   });
 *
 * Needs window.SineBands from sine-bands.js (the shared math).
 */
(function (root) {
  "use strict";

  function sineCycleBands(PineJS) {
    var SB = root.SineBands;
    return {
      name: "SINE Cycle Bands",
      metainfo: {
        _metainfoVersion: 53,
        id: "SINECycleBands@tv-basicstudies-1",
        name: "SINE Cycle Bands",
        description: "SINE Cycle Bands",
        shortDescription: "SINE",
        is_hidden_study: false,
        is_price_study: true,
        isCustomIndicator: true,
        linkedToSeries: true,
        format: { type: "inherit" },
        plots: [
          { id: "plot_0", type: "line" },
          { id: "plot_1", type: "line" },
          { id: "plot_2", type: "line" },
          { id: "plot_3", type: "colorer", target: "plot_0", palette: "rhythm" }
        ],
        palettes: {
          rhythm: { colors: { 0: { name: "Rhythm rising" }, 1: { name: "Rhythm falling" } } }
        },
        filledAreas: [
          { id: "fill_0", objAId: "plot_1", objBId: "plot_2", type: "plot_plot", title: "Band fill" }
        ],
        styles: {
          plot_0: { title: "Midline", histogramBase: 0 },
          plot_1: { title: "Upper band", histogramBase: 0 },
          plot_2: { title: "Lower band", histogramBase: 0 }
        },
        defaults: {
          styles: {
            plot_0: { linestyle: 0, linewidth: 2, plottype: 0, trackPrice: false, transparency: 0, visible: true, color: "#26a69a" },
            plot_1: { linestyle: 0, linewidth: 1, plottype: 0, trackPrice: false, transparency: 30, visible: true, color: "#7e57c2" },
            plot_2: { linestyle: 0, linewidth: 1, plottype: 0, trackPrice: false, transparency: 30, visible: true, color: "#7e57c2" }
          },
          palettes: {
            rhythm: { colors: { 0: { color: "#26a69a", width: 2, style: 0 }, 1: { color: "#ef5350", width: 2, style: 0 } } }
          },
          filledAreasStyle: { fill_0: { color: "#7e57c2", transparency: 92, visible: true } },
          inputs: { in_0: SB.DEFAULTS.length, in_1: SB.DEFAULTS.rhythms, in_2: SB.DEFAULTS.mult }
        },
        inputs: [
          { id: "in_0", name: "Window (bars)", defval: SB.DEFAULTS.length, type: "integer", min: 32, max: 512 },
          { id: "in_1", name: "Rhythms to fit", defval: SB.DEFAULTS.rhythms, type: "integer", min: 1, max: 5 },
          { id: "in_2", name: "Band width (× σ)", defval: SB.DEFAULTS.mult, type: "float", min: 0.1, max: 10 }
        ]
      },
      constructor: function () {
        this.init = function (context, inputCallback) {
          this._context = context;
          this._input = inputCallback;
        };
        this.main = function (context, inputCallback) {
          this._context = context;
          this._input = inputCallback;
          var len = this._input(0), opts = { rhythms: this._input(1), mult: this._input(2) };
          var closes = this._context.new_var(PineJS.Std.close(this._context));
          var win = [];
          for (var n = len - 1; n >= 0; n--) {
            var v = closes.get(n);
            if (!(v > 0)) return [NaN, NaN, NaN, NaN];      // not enough history yet
            win.push(v);
          }
          var r = SB.analyzeWindow(win, opts);
          if (!r) return [NaN, NaN, NaN, NaN];
          return [r.mid, r.upper, r.lower, r.cycleSlope > 0 ? 0 : 1];
        };
      }
    };
  }

  var api = {
    sineCycleBands: sineCycleBands,
    customIndicatorsGetter: function (PineJS) { return Promise.resolve([sineCycleBands(PineJS)]); }
  };
  root.SineChartingLibrary = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
