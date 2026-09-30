/*
 * SINE Cycle Bands and SINE Stress for platforms built on the TradingView Charting Library / Trading Platform
 * (the embedded chart used by many trading terminals). Only the platform's own developers can add it,
 * via the widget's `custom_indicators_getter` option:
 *
 *   <script src="sine-bands.js"></script>
 *   <script src="sine-stress.js"></script>
 *   <script src="charting-library.js"></script>
 *   new TradingView.widget({
 *     ...,
 *     custom_indicators_getter: SineChartingLibrary.customIndicatorsGetter
 *   });
 *
 * Needs window.SineBands (sine-bands.js) and window.SineStress (sine-stress.js), the shared math.
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

  function sineStress(PineJS) {
    var SS = root.SineStress;
    return {
      name: "SINE Stress",
      metainfo: {
        _metainfoVersion: 53,
        id: "SINEStress@tv-basicstudies-1",
        name: "SINE Stress",
        description: "SINE Stress",
        shortDescription: "SINE Stress",
        is_hidden_study: false,
        is_price_study: false,
        isCustomIndicator: true,
        format: { type: "price", precision: 1 },
        plots: [
          { id: "plot_0", type: "line" },
          { id: "plot_1", type: "line" },
          { id: "plot_2", type: "line" },
          { id: "plot_3", type: "colorer", target: "plot_0", palette: "pressure" }
        ],
        palettes: {
          pressure: { colors: { 0: { name: "Pressure up" }, 1: { name: "Pressure down" } } }
        },
        styles: {
          plot_0: { title: "Stress %", histogramBase: 0 },
          plot_1: { title: "Random churn %", histogramBase: 0 },
          plot_2: { title: "Chance threshold % (p = 0.05)", histogramBase: 0 }
        },
        defaults: {
          styles: {
            plot_0: { linestyle: 0, linewidth: 2, plottype: 0, trackPrice: false, transparency: 0, visible: true, color: "#26a69a" },
            plot_1: { linestyle: 2, linewidth: 1, plottype: 0, trackPrice: false, transparency: 30, visible: true, color: "#9e9e9e" },
            plot_2: { linestyle: 1, linewidth: 1, plottype: 0, trackPrice: false, transparency: 30, visible: true, color: "#ef5350" }
          },
          palettes: {
            pressure: { colors: { 0: { color: "#26a69a", width: 2, style: 0 }, 1: { color: "#ef5350", width: 2, style: 0 } } }
          },
          inputs: { in_0: SS.DEFAULTS.length }
        },
        inputs: [
          { id: "in_0", name: "Window (returns)", defval: SS.DEFAULTS.length, type: "integer", min: 16, max: 64, step: 8 }
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
          var L = this._input(0);
          if (L % 8) L = 32;
          var closes = this._context.new_var(PineJS.Std.close(this._context));
          var r = [];
          for (var n = L; n >= 1; n--) {
            var a = closes.get(n), b = closes.get(n - 1);
            if (!(a > 0 && b > 0)) return [NaN, NaN, NaN, NaN];
            r.push(Math.log(b / a));
          }
          var share = SS.shareOf(r), expected = (L / 8) / (L / 2 - 1);
          return [share * 100, expected * 100, SS.threshold(L, 0.05) * 100, closes.get(0) >= closes.get(L) ? 0 : 1];
        };
      }
    };
  }

  var api = {
    sineCycleBands: sineCycleBands,
    sineStress: sineStress,
    // Only the indicators whose math file is loaded (sine-bands.js and/or sine-stress.js)
    customIndicatorsGetter: function (PineJS) {
      var list = [];
      if (root.SineBands) list.push(sineCycleBands(PineJS));
      if (root.SineStress) list.push(sineStress(PineJS));
      return Promise.resolve(list);
    }
  };
  root.SineChartingLibrary = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
