/*
 * SINE Forge — create wizard.
 *   form → /api/forge preview (live summary, same maths as the program)
 *   launch: coin key (optionally vanity) + config key made here → IPFS upload → /api/forge create →
 *           partial-sign with both keys → ONE wallet prompt for both transactions → send config, then pool + dev buy
 */
(function () {
  "use strict";
  var F = window.SineForge, W3 = F.W3, $ = F.$, el = F.el;
  var USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  var setup = null, quote = null, quoteMode = "sol", unit = "usd", imageData = null, busy = false;
  var vanityKey = null, pending = null;          // pending = a launch whose config landed but whose pool tx didn't

  /* ───────────── setup & presets ───────────── */
  F.get("/api/forge?action=setup").then(function (s) {
    setup = s;
    var max = s.policy.maxCreatorFeeSharePct;
    $("fe-share").max = max; if (Number($("fe-share").value) > max) $("fe-share").value = max;
    $("fe-share-max").textContent = s.policy.platformFeeSharePct ? "(up to " + max + "%; the platform keeps " + s.policy.platformFeeSharePct + "%)" : "(of the 80% that isn’t Meteora’s)";
    $("lp-partner").hidden = !s.policy.partnerWallet;
    $("hk-off").hidden = Boolean(s.policy.hookProgram); $("hk-on").disabled = !s.policy.hookProgram; $("hk-max").textContent = s.policy.maxHookAllowlist || 20;
    if (!s.policy.partnerWallet) $("fe-share").closest(".lp-field").hidden = true;   // self-hosted: the creator gets every non-Meteora fee
    if (!s.policy.partnerWallet) { $("g-mfee-c-wrap").hidden = true; }
    var box = $("presets");
    Object.keys(s.presets).forEach(function (k) {
      var p = s.presets[k];
      box.appendChild(el("button", { type: "button", class: "fg-preset", "data-k": k, title: p.blurb, onclick: function () { applyPreset(k); } }, [el("strong", { text: p.label }), el("span", { text: p.blurb })]));
    });
    syncShare(); refresh();
  }).catch(function (e) { F.status("The launchpad API isn’t reachable: " + e.message); });

  function applyPreset(k) {
    var f = setup.presets[k].form, d = setup.defaults;
    document.querySelectorAll(".fg-preset").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-k") === k); });
    var m = merge(d, f);
    if (f.quoteMode === "custom") setQuoteMode("custom");
    else if (f.quote && f.quote.mint === USDC) setQuoteMode("usdc");
    else setQuoteMode("sol");
    if (f.curve) { setUnit("quote"); $("c-start").value = m.curve.initialMcap; $("c-grad").value = m.curve.gradMcap; $("c-shape").value = m.curve.shape; }
    $("fe-trade").value = m.fees.tradeBps / 100; $("fe-share").value = Math.min(m.fees.creatorSharePct, Number($("fe-share").max));
    $("sn-on").checked = m.fees.snipe.enabled; $("sn-start").value = (m.fees.snipe.startBps || 9900) / 100; $("sn-dur").value = m.fees.snipe.durationSec || 60;
    $("sn-mode").value = m.fees.snipe.mode || "exponential"; $("sn-steps").value = m.fees.snipe.periods || 60;
    $("fe-dyn").checked = m.fees.dynamic; $("fe-collect").value = m.fees.collectIn;
    $("g-fee").value = m.grad.feeBps / 100; $("g-mode").value = m.grad.feeMode; $("g-comp").value = m.grad.compoundPct || 50; $("g-dyn").checked = m.grad.dynamic;
    $("lp-cl").value = m.grad.lp.creatorLockedPct; $("lp-cu").value = m.grad.lp.creatorPct; $("lp-pl").value = m.grad.lp.partnerLockedPct; $("lp-pu").value = m.grad.lp.partnerPct;
    $("g-mfee").value = m.grad.migrationFeePct || 0; $("g-mfee-c").value = m.grad.migrationFeeCreatorPct === undefined ? 100 : m.grad.migrationFeeCreatorPct;
    $("v-on").checked = m.vesting.enabled; $("v-pct").value = m.vesting.pct; $("v-cliff").value = m.vesting.cliffDays; $("v-dur").value = m.vesting.durationDays; $("v-cliffpct").value = m.vesting.cliffUnlockPct;
    var h = m.hooks || {};
    $("hk-on").checked = Boolean(h.enabled) && !$("hk-on").disabled;
    if (h.enabled) {
      $("hk-phase").value = h.launchPhaseMin || 60; $("hk-wallet").value = h.maxWalletPct || 0; $("hk-tx").value = h.maxTxPct || 0; $("hk-slot").value = h.maxBuysPerSlot || 0;
      $("hk-lock").value = h.creatorLockDays || 0; $("hk-daily").value = h.creatorDailyPct || 0; $("hk-p2p").checked = Boolean(h.noP2p);
      if ($("hk-on").disabled) F.status("This preset needs on-chain rules, which aren’t switched on for this site yet. The other settings were loaded.", true);
    }
    syncShare(); toggles(); refresh();
    if (h.enabled && $("hk-on").disabled) return;
    F.status("Loaded “" + setup.presets[k].label + "”. Every setting below can still be changed.", true);
  }
  function merge(a, b) { var o = JSON.parse(JSON.stringify(a)); Object.keys(b || {}).forEach(function (k) { o[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && o[k] ? merge(o[k], b[k]) : b[k]; }); return o; }

  /* ───────────── pair (quote asset) ───────────── */
  function setQuoteMode(m) {
    quoteMode = m;
    document.querySelectorAll("#q-seg button").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-q") === m); });
    $("q-custom").hidden = m !== "custom";
    loadQuote(m === "sol" ? F.SOL_MINT : m === "usdc" ? USDC : $("q-mint").value.trim());
  }
  document.querySelectorAll("#q-seg button").forEach(function (b) { b.addEventListener("click", function () { setQuoteMode(b.getAttribute("data-q")); }); });
  var qTimer;
  $("q-mint").addEventListener("input", function () { clearTimeout(qTimer); qTimer = setTimeout(function () { loadQuote($("q-mint").value.trim()); }, 400); });
  (((window.SINE_CONFIG || {}).forgePairs) || []).filter(function (p) { return F.MINT_RE.test(p.mint || ""); }).forEach(function (p) {
    $("q-suggest").appendChild(el("button", { type: "button", class: "chip fg-chipbtn", text: p.symbol, onclick: function () { $("q-mint").value = p.mint; loadQuote(p.mint); } }));
  });

  var qReq = null;
  function loadQuote(mint) {
    var info = $("q-info");
    qReq = mint;
    if (!F.MINT_RE.test(mint || "")) { quote = null; info.textContent = quoteMode === "custom" ? "Paste a token mint address." : ""; refresh(); return; }
    info.textContent = "Checking the token…";
    F.quoteInfo(mint).then(function (q) {
      if (qReq !== mint) return;                                   // a newer choice replaced this one
      var prev = quote;
      if (prev && prev.mint !== q.mint && prev.priceUsd && q.priceUsd) {
        (unit === "quote" ? ["c-start", "c-grad", "db-amt"] : ["db-amt"]).forEach(function (id) { var v = Number($(id).value) || 0; if (v) $(id).value = +(v * prev.priceUsd / q.priceUsd).toPrecision(4); });
      }
      quote = q;
      var sym = F.quoteSymbol(q);
      info.textContent = "";
      if (q.image) info.appendChild(el("img", { src: q.image, alt: "", width: 28, height: 28 }));
      info.appendChild(el("strong", { text: sym }));
      info.appendChild(el("span", { class: "muted", text: (q.name && q.mint !== F.SOL_MINT ? q.name + " · " : "") + (q.priceUsd ? "$" + F.fmt(q.priceUsd, 6) : "no USD price yet") + " · " + q.decimals + " decimals · " + (q.token2022 ? "Token-2022" : "SPL") }));
      if (!q.usable) info.appendChild(el("span", { class: "fg-bad", text: "Can’t be used as a pair: " + q.problems.join("; ") }));
      $("unit-quote").textContent = "in " + sym; $("db-unit").textContent = sym; $("pv-pair").textContent = "paired with " + sym;
      if (!q.priceUsd && unit === "usd") {
        unit = "quote";
        document.querySelectorAll("#unit-seg button").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-u") === "quote"); });
        if (q.mint === F.SOL_MINT) { $("c-start").value = 30; $("c-grad").value = 400; }
        F.status("No USD price is available for " + sym + " right now, so enter the market caps in " + sym + ".", true);
      }
      refresh();
    }).catch(function (e) { if (qReq !== mint) return; quote = null; info.textContent = e.message; refresh(); });
  }

  /* ───────────── units ───────────── */
  function setUnit(u) {
    if (u === "usd" && !(quote && quote.priceUsd)) { u = "quote"; }
    if (u !== unit && quote && quote.priceUsd) {
      ["c-start", "c-grad"].forEach(function (id) {
        var v = Number($(id).value) || 0;
        $(id).value = +(u === "usd" ? v * quote.priceUsd : v / quote.priceUsd).toPrecision(4);
      });
    }
    unit = u;
    document.querySelectorAll("#unit-seg button").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-u") === u); });
    refresh();
  }
  document.querySelectorAll("#unit-seg button").forEach(function (b) { b.addEventListener("click", function () { setUnit(b.getAttribute("data-u")); }); });
  function toQuote(v) { v = Number(v) || 0; return unit === "usd" && quote && quote.priceUsd ? v / quote.priceUsd : v; }

  /* ───────────── form ───────────── */
  function num(id) { return Number($(id).value); }
  function gather() {
    return {
      token: { decimals: num("t-decimals"), tokenType: $("t-type").value, supply: num("t-supply"), authority: $("t-auth").value },
      quote: { mint: quote ? quote.mint : F.SOL_MINT },
      curve: { initialMcap: toQuote($("c-start").value), gradMcap: toQuote($("c-grad").value), shape: $("c-shape").value, supplyOnMigrationPct: num("c-mig") },
      fees: {
        tradeBps: Math.round(num("fe-trade") * 100), creatorSharePct: num("fe-share"), dynamic: $("fe-dyn").checked, collectIn: $("fe-collect").value, devBuySkipsTax: $("fe-devmin").checked,
        snipe: { enabled: $("sn-on").checked, startBps: Math.round(num("sn-start") * 100), durationSec: num("sn-dur"), mode: $("sn-mode").value, periods: num("sn-steps") },
      },
      grad: {
        feeBps: Math.round(num("g-fee") * 100), feeMode: $("g-mode").value, compoundPct: num("g-comp"), dynamic: $("g-dyn").checked,
        lp: { creatorLockedPct: num("lp-cl"), creatorPct: num("lp-cu"), partnerLockedPct: num("lp-pl"), partnerPct: num("lp-pu") },
        migrationFeePct: num("g-mfee"), migrationFeeCreatorPct: num("g-mfee-c"),
      },
      hooks: { enabled: $("hk-on").checked, launchPhaseMin: num("hk-phase"), maxWalletPct: num("hk-wallet"), maxTxPct: num("hk-tx"), maxBuysPerSlot: num("hk-slot"),
        noP2p: $("hk-p2p").checked, creatorLockDays: num("hk-lock"), creatorDailyPct: num("hk-daily"), allowlistMin: num("hk-allowmin"),
        allowlist: $("hk-allow").value.split(/[\s,]+/).filter(function (a) { return F.MINT_RE.test(a); }) },
      vesting: { enabled: $("v-on").checked, pct: num("v-pct"), cliffDays: num("v-cliff"), durationDays: num("v-dur"), periods: Math.max(1, Math.round(num("v-dur"))), cliffUnlockPct: num("v-cliffpct") },
    };
  }
  function devBuyRaw() { return quote ? F.toRaw($("db-amt").value || "0", quote.decimals) || "0" : "0"; }

  function toggles() {
    $("sn-box").hidden = !$("sn-on").checked;
    $("g-comp-wrap").hidden = $("g-mode").value !== "compound";
    $("c-mig-wrap").hidden = $("c-shape").value !== "twoSegment";
    $("v-box").hidden = !$("v-on").checked;
    $("hk-box").hidden = !$("hk-on").checked;
    $("t-type").disabled = $("hk-on").checked; if ($("hk-on").checked) $("t-type").value = "token2022";
    $("g-mfee-c-wrap").hidden = !(setup && setup.policy.partnerWallet) || !(num("g-mfee") > 0);
    var lp = ["lp-cl", "lp-cu", "lp-pl", "lp-pu"].reduce(function (s, id) { return s + (num(id) || 0); }, 0);
    $("lp-sum").textContent = lp + "%" + (lp !== 100 ? " (must total 100%)" : "");
    $("lp-sum").style.color = lp === 100 ? "" : "#F07A6A";
  }
  function syncShare() { $("fe-share-out").textContent = $("fe-share").value + "%"; }
  $("fe-share").addEventListener("input", syncShare);

  var pvTimer, pvSeq = 0;
  function refresh() {
    toggles(); routerText(); preview(); refreshButton();
    clearTimeout(pvTimer); pvTimer = setTimeout(runPreview, 350);
    if (quote && quote.priceUsd) {
      var s = toQuote($("c-start").value), g = toQuote($("c-grad").value), sym = F.quoteSymbol(quote);
      $("c-conv").textContent = unit === "usd" ? "= " + F.fmt(s) + " → " + F.fmt(g) + " " + sym + " at today’s price. The curve itself is priced in " + sym + "." : "≈ " + F.usd(s * quote.priceUsd) + " → " + F.usd(g * quote.priceUsd) + " at today’s price.";
    } else $("c-conv").textContent = "";
  }
  document.querySelectorAll("#forge-form input, #forge-form select, #forge-form textarea").forEach(function (i) {
    if (i.id === "f-image" || i.id === "q-mint") return;
    i.addEventListener("input", refresh); i.addEventListener("change", refresh);
  });

  function runPreview() {
    if (!quote || !quote.usable) { renderSummary(null, quote ? "This pair can’t be used." : "Choose a pair token."); return; }
    var seq = ++pvSeq;
    F.forge("preview", { form: gather(), devBuy: devBuyRaw(), quoteDecimals: quote.decimals })
      .then(function (r) { if (seq === pvSeq) renderSummary(r.summary); })
      .catch(function (e) { if (seq === pvSeq) renderSummary(null, e.message); });
  }

  var lastSummary = null;
  function renderSummary(s, err) {
    lastSummary = s;
    var dl = $("sum-dl"), badges = $("sum-badges"), split = $("sum-split");
    dl.textContent = ""; badges.textContent = ""; split.textContent = "";
    $("db-out").textContent = "";
    if (!s) { $("sum-note").textContent = err || ""; $("sum-note").className = "how fg-bad"; refreshButton(); return; }
    $("sum-note").className = "how"; $("sum-note").textContent = "Live preview, calculated with the same code the on-chain program uses.";
    var sym = F.quoteSymbol(quote), px = quote.priceUsd;
    var row = function (k, v) { dl.appendChild(el("div", null, [el("dt", { text: k }), el("dd", { text: v })])); };
    var both = function (q) { return F.fmt(q) + " " + sym + (px ? " · " + F.usd(q * px) : ""); };
    row("Starts at", both(s.startMcap));
    row("Graduates at", both(s.gradMcap));
    row("Raise to graduate", both(s.graduatesAtQuoteRaised));
    row("Supply", F.fmt(s.supply, 0) + (s.vestedPct ? " (" + s.vestedPct + "% vested)" : ""));
    row("Trading fee", s.snipe ? F.pct(s.snipe.startPct) + " → " + F.pct(s.tradeFeePct) + " over " + s.snipe.seconds + " s" : F.pct(s.tradeFeePct));
    row("After graduation", "Meteora DAMM v2 · " + F.pct(s.graduation.feePct) + " fee" + (s.graduation.feeMode === "compound" ? " · auto-compounding" : ""));
    if (s.poolCreationFeeSol) row("Platform launch fee", s.poolCreationFeeSol + " SOL");
    if (s.hooks) {
      var hr = [];
      if (s.hooks.maxWalletPct) hr.push("holder cap " + F.pct(s.hooks.maxWalletPct));
      if (s.hooks.maxTxPct) hr.push("max tx " + F.pct(s.hooks.maxTxPct));
      if (s.hooks.maxBuysPerSlot) hr.push(s.hooks.maxBuysPerSlot + " buys/block");
      if (s.hooks.noP2p) hr.push("no P2P sends");
      if (s.hooks.allowlistMin) hr.push("allowlist " + s.hooks.allowlistMin + " min");
      row("On-chain rules (" + s.hooks.launchPhaseMin + " min)", hr.join(", ") || "creator rules only");
      if (s.hooks.creatorLockDays || s.hooks.creatorDailyPct) row("Creator", (s.hooks.creatorLockDays ? "locked " + s.hooks.creatorLockDays + " d" : "") + (s.hooks.creatorLockDays && s.hooks.creatorDailyPct ? ", then " : "") + (s.hooks.creatorDailyPct ? "≤ " + F.pct(s.hooks.creatorDailyPct) + "/day" : ""));
    }
    if (s.devBuy) { row("Your dev buy gets", F.fmt(s.devBuy.tokens) + " tokens (" + F.pct(s.devBuy.pctOfSupply) + ")"); $("db-out").textContent = "≈ " + F.fmt(s.devBuy.tokens) + " tokens, " + F.pct(s.devBuy.pctOfSupply) + " of supply" + ($("fe-devmin").checked ? ", at the minimum fee." : "."); }
    var badge = function (t, good) { badges.appendChild(el("span", { class: "fg-badge" + (good ? " good" : " warn"), text: t })); };
    badge(s.graduation.lockedLpPct + "% LP locked forever", s.graduation.lockedLpPct >= 50);
    badge(s.authority === "immutable" ? "Immutable metadata, no mint authority" : s.authority === "creatorMint" ? "Creator can mint more" : "Creator can edit metadata", s.authority === "immutable");
    if (s.snipe) badge("Anti-sniper tax " + F.pct(s.snipe.startPct), true);
    if (s.vestedPct) badge("Team tokens vested", true);
    if (s.hooks) badge("Transfer-hook rules", true);
    if (s.hooks && (s.hooks.creatorLockDays || s.hooks.creatorDailyPct)) badge("Creator sells limited on-chain", true);
    badge("Pair: " + sym, true);
    var seg = function (label, pct, cls) { if (pct > 0) split.appendChild(el("span", { class: "fg-seg-" + cls, style: "flex:" + pct, title: label + " " + pct + "%" }, [el("em", { text: label + " " + F.pct(pct, 0) })])); };
    seg("You", s.feeSplitPct.creator, "you"); seg("Platform", s.feeSplitPct.platform, "plat"); seg("Meteora", s.feeSplitPct.meteora, "met");
    drawTax(s.snipe);
    refreshButton();
  }

  function drawTax(sn) {
    if (!sn || !sn.curve || sn.curve.length < 2) { $("sn-line").setAttribute("d", ""); $("sn-area").setAttribute("d", ""); $("sn-t0").textContent = ""; $("sn-t1").textContent = ""; return; }
    var c = sn.curve, T = c[c.length - 1][0] || 1, X = function (t) { return 4 + 592 * t / T; }, Y = function (p) { return 132 - 112 * p / Math.max(1, c[0][1]); };
    var d = "", prev = null;
    c.forEach(function (pt, i) { if (i) d += "L" + X(pt[0]).toFixed(1) + " " + Y(prev).toFixed(1); d += (i ? "L" : "M") + X(pt[0]).toFixed(1) + " " + Y(pt[1]).toFixed(1); prev = pt[1]; });
    $("sn-line").setAttribute("d", d); $("sn-area").setAttribute("d", d + "L596 132L4 132Z");
    $("sn-t0").textContent = F.pct(c[0][1]) + " at launch";
    $("sn-t1").textContent = F.pct(c[c.length - 1][1]) + " after " + T + " s";
  }

  /* ───────────── creator-fee plan ───────────── */
  var shareWallets = [];
  function routerText() {
    var used = ["rt-burn", "rt-lp", "rt-hold", "rt-split"].reduce(function (s, id) { return s + (num(id) || 0); }, 0);
    $("rt-keep").textContent = used > 100 ? "The plan adds up to " + used + "%. Keep it at 100% or less." : "You keep " + (100 - used) + "%." + (num("rt-lp") > 0 ? " Liquidity is added once the coin has graduated; until then that share waits in your wallet." : "");
    $("rt-keep").className = "how" + (used > 100 ? " fg-bad" : "");
    $("rt-wallets").hidden = !(num("rt-split") > 0);
    $("rt-add").hidden = !(num("rt-split") > 0);
  }
  function renderWallets() {
    var box = $("rt-wallets"); box.textContent = "";
    shareWallets.forEach(function (w, i) {
      box.appendChild(el("div", { class: "fg-wrow" }, [
        el("input", { class: "field", placeholder: "Wallet address", value: w.to, spellcheck: "false", oninput: function (e) { w.to = e.target.value.trim(); } }),
        el("input", { class: "field fg-wpct", type: "number", min: "1", max: "100", value: w.weight, title: "Relative weight", oninput: function (e) { w.weight = Number(e.target.value) || 0; } }),
        el("button", { type: "button", class: "linklike", text: "Remove", onclick: function () { shareWallets.splice(i, 1); renderWallets(); } }),
      ]));
    });
    if (shareWallets.length) box.appendChild(el("p", { class: "how", text: "Weights are relative: two wallets weighted 1 and 3 get 25% and 75% of the fee-share slice." }));
  }
  $("rt-add").addEventListener("click", function () { if (shareWallets.length < 10) { shareWallets.push({ to: "", weight: 1 }); renderWallets(); } });
  function feePlan() {
    return { buybackBurnPct: num("rt-burn") || 0, addLiquidityPct: num("rt-lp") || 0, holderAirdropPct: num("rt-hold") || 0, feeSharePct: num("rt-split") || 0,
      feeShareWallets: shareWallets.filter(function (w) { return F.MINT_RE.test(w.to) && w.weight > 0; }).map(function (w) { return { to: w.to, weight: w.weight }; }) };
  }

  /* ───────────── preview card ───────────── */
  function preview() {
    $("pv-name").textContent = $("f-name").value.trim() || "Your coin";
    $("pv-sym").textContent = "$" + ($("f-symbol").value.trim().toUpperCase() || "TICKER");
  }
  $("f-image").addEventListener("change", function () {
    var f = this.files && this.files[0]; imageData = null;
    if (f && f.size > 1000000) { F.status("That image is over 1 MB. Please choose a smaller one."); this.value = ""; }
    else if (f) { var rd = new FileReader(); rd.onload = function () { imageData = rd.result; $("pv-img").style.backgroundImage = "url(" + imageData + ")"; refreshButton(); }; rd.readAsDataURL(f); }
    $("pv-img").style.backgroundImage = ""; refreshButton();
  });

  function refreshButton() {
    var plan = ["rt-burn", "rt-lp", "rt-hold", "rt-split"].reduce(function (s, id) { return s + (num(id) || 0); }, 0);
    var missing = !F.owner ? "Connect a wallet to launch" : busy ? "Launching…" : pending ? "Retry creating the coin" :
      !$("f-name").value.trim() || !$("f-symbol").value.trim() ? "Add a name and ticker" : !imageData ? "Add an image" :
      !quote || !quote.usable ? "Choose a usable pair token" : !lastSummary ? "Fix the settings above" : plan > 100 ? "Fee plan is over 100%" :
      !$("f-terms").checked ? "Tick the box above to launch" : null;
    $("launch-btn").disabled = Boolean(missing) && !(pending && F.owner && !busy);
    $("launch-btn").textContent = missing || "Forge $" + $("f-symbol").value.trim().toUpperCase();
  }
  F.onWallet(function () { refreshButton(); });

  /* ───────────── vanity address (Web Workers) ───────────── */
  function grind(suffix, ignoreCase) {
    return new Promise(function (resolve, reject) {
      var n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)), workers = [], tried = 0, t0 = Date.now();
      var stop = function () { workers.forEach(function (w) { w.terminate(); }); };
      for (var i = 0; i < n; i++) {
        var w = new Worker("/assets/forge-vanity.js");
        w.onmessage = function (e) {
          if (e.data.progress) { tried += e.data.progress; $("v-status").textContent = "Searching for an address ending in “" + suffix + "”… " + tried.toLocaleString() + " keys tried (" + Math.round(tried / ((Date.now() - t0) / 1000)).toLocaleString() + "/s)"; }
          if (e.data.secretKey) { stop(); resolve(W3.Keypair.fromSecretKey(new Uint8Array(e.data.secretKey))); }
        };
        w.onerror = function (err) { stop(); reject(new Error("The vanity search failed in this browser: " + (err.message || "worker error"))); };
        w.postMessage({ suffix: suffix, ignoreCase: ignoreCase });
        workers.push(w);
      }
    });
  }

  /* ───────────── launch ───────────── */
  function step(name, state) { document.querySelectorAll("#steps li").forEach(function (li) { if (li.getAttribute("data-step") === name) li.setAttribute("data-state", state); }); }
  function failActive() { document.querySelectorAll("#steps li[data-state=active]").forEach(function (li) { li.setAttribute("data-state", "failed"); }); }

  $("forge-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy || !F.owner) return;
    if (pending) return retryPool();
    var name = $("f-name").value.trim(), symbol = $("f-symbol").value.trim().toUpperCase(), form = gather();
    var suffix = $("v-suffix").value.trim(), configKp = W3.Keypair.generate(), mintKp, uploaded;
    if (suffix && !/^[1-9A-HJ-NP-Za-km-z]{1,4}$/.test(suffix)) { F.status("A vanity ending can only use base58 characters (no 0, O, I or l)."); return; }
    busy = true; refreshButton(); F.status("");
    document.querySelectorAll("#steps li").forEach(function (li) { li.removeAttribute("data-state"); });
    step("key", "active");
    var keyP = suffix ? (vanityKey && vanityKey.suffix === suffix + "|" + $("v-case").checked ? Promise.resolve(vanityKey.kp) : grind(suffix, $("v-case").checked)) : Promise.resolve(W3.Keypair.generate());
    keyP.then(function (kp) {
      mintKp = kp; if (suffix) vanityKey = { suffix: suffix + "|" + $("v-case").checked, kp: kp };
      $("v-status").textContent = "Coin address: " + kp.publicKey.toBase58();
      step("key", "done"); step("upload", "active");
      return F.post("/api/upload", { image: imageData, name: name, symbol: symbol, description: $("f-desc").value, twitter: $("f-twitter").value.trim(), telegram: $("f-telegram").value.trim(), website: $("f-website").value.trim(), forge: feePlan() });
    }).then(function (up) {
      uploaded = up; step("upload", "done"); step("build", "active");
      return F.forge("create", { form: form, creator: F.owner.toBase58(), config: configKp.publicKey.toBase58(), baseMint: mintKp.publicKey.toBase58(), name: name, symbol: symbol, uri: up.uri, devBuy: devBuyRaw(), priority: 100000 });
    }).then(function (r) {
      step("build", "done"); step("sign", "active");
      var txs = [F.decode(r.configTx), F.decode(r.poolTx)];
      txs[0].partialSign(configKp); txs[1].partialSign(mintKp);
      if (r.hookTx) { var ht = F.decode(r.hookTx); ht.partialSign(mintKp); txs.push(ht); $("step-hook").hidden = false; }
      var meta = { name: name, symbol: symbol, uri: uploaded.uri, image: uploaded.image, pool: r.pool, mint: mintKp.publicKey.toBase58(), quoteMint: form.quote.mint, devBuy: devBuyRaw(), config: configKp.publicKey.toBase58() };
      return (F.wallet.signAllTransactions ? F.wallet.signAllTransactions(txs) : Promise.all(txs.map(function (t) { return F.wallet.signTransaction(t); }))).then(function (signed) { return { signed: signed, meta: meta }; });
    }).then(function (x) {
      step("sign", "done");
      var hookFirst = x.signed[2] ? (step("hook", "active"), F.send(x.signed[2]).then(function (sig) { return F.confirm(sig, "Transfer rules"); }).then(function () { step("hook", "done"); })) : Promise.resolve();
      return hookFirst.then(function () { step("config", "active"); return F.send(x.signed[0]); }).then(function (sig) { return F.confirm(sig, "Config"); }).then(function () {
        step("config", "done"); step("pool", "active");
        pending = { meta: x.meta, mintKp: mintKp };                   // if the next step fails, the pool can be retried
        return F.send(x.signed[1]).then(function (sig) { return F.confirm(sig, "Coin creation"); });
      }).then(function (sig) { return done(sig, x.meta); });
    }).catch(function (err) {
      failActive();
      F.status(F.cancelled(err) ? "You cancelled in your wallet." + (pending ? " The config exists; press the button to finish creating the coin." : " Nothing was launched.") :
        err.message + (pending ? " The coin’s config was created; press “Retry creating the coin” to finish." : ""));
    }).then(function () { busy = false; refreshButton(); });
  });

  function retryPool() {
    busy = true; refreshButton(); step("pool", "active");
    var m = pending.meta;
    F.forge("createPool", { creator: F.owner.toBase58(), config: m.config, baseMint: m.mint, name: m.name, symbol: m.symbol, uri: m.uri, devBuy: m.devBuy, priority: 150000 })
      .then(function (r) { var tx = F.decode(r.tx); tx.partialSign(pending.mintKp); return F.wallet.signTransaction(tx); })
      .then(function (signed) { return F.send(signed).then(function (sig) { return F.confirm(sig, "Coin creation"); }); })
      .then(function (sig) { return done(sig, m); })
      .catch(function (err) { failActive(); F.status(F.cancelled(err) ? "Cancelled in your wallet." : err.message); })
      .then(function () { busy = false; refreshButton(); });
  }

  function done(sig, m) {
    step("pool", "done"); pending = null;
    var list = F.store("launches:" + F.owner.toBase58()) || [];
    list.unshift({ mint: m.mint, pool: m.pool, name: m.name, symbol: m.symbol, sig: sig, at: Date.now(), plan: feePlan() });
    F.store("launches:" + F.owner.toBase58(), list.slice(0, 50));
    F.store("plan:" + m.mint, feePlan());
    F.status("$" + m.symbol + " is live. Opening its page…", true);
    return F.post("/api/registry", { sig: sig, mint: m.mint, creator: F.owner.toBase58(), name: m.name, symbol: m.symbol, image: m.image, pool: m.pool, quoteMint: m.quoteMint, engine: "forge" })
      .catch(function () {}).then(function () { location.href = "/coin?mint=" + encodeURIComponent(m.mint) + "&new=1"; });
  }

  F.initWallet();
  setQuoteMode("sol");
  renderWallets(); refresh();
})();
