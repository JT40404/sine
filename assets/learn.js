(function () {
  "use strict";
  var F = window.SineFourier;
  var res = F.analyze(F.testSignal(), 0.25, 3, { skipNull: true });
  var m = 0;
  res.d.forEach(function (v) { m = Math.max(m, Math.abs(v)); });
  var sc = 34 / (res.peaks[0] ? res.peaks[0].amp : 1);
  var set = function (id, d) { var el = document.getElementById(id); if (el) el.setAttribute("d", d); };
  set("hero-composite", F.linePath(res.d, 110, 466, 88, m ? 60 / m : 1));
  ["hero-c1", "hero-c2", "hero-c3"].forEach(function (id, i) {
    if (res.comps[i]) set(id, F.linePath(res.comps[i], 110, 466, [234, 314, 384][i], sc));
  });
})();
