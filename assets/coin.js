/*
 * SINE Forge — coin page: live curve state, anti-sniper tax meter, trading, creator studio
 * (claim → buyback & burn / add LP / holder airdrop / fee-share), platform claims, graduation.
 */
(function () {
  "use strict";
  var F = window.SineForge, W3 = F.W3, $ = F.$, el = F.el;
  var METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  var params = new URLSearchParams(location.search), MINT = (params.get("mint") || "").trim();
  var P = null, Q = null, meta = {}, fetchedAt = 0, side = "buy", busy = false, bal = { quote: null, coin: null }, iv = "1m";

  if (!F.MINT_RE.test(MINT)) {
    $("find").hidden = false;
    $("find").addEventListener("submit", function (e) { e.preventDefault(); var m = $("find-mint").value.trim(); if (F.MINT_RE.test(m)) location.href = "/coin?mint=" + encodeURIComponent(m); });
    F.initWallet(); return;
  }
  if (params.get("new")) F.status("Your coin is live. Share this page: anyone can trade it here, and it’s also tradable through Jupiter and other Solana aggregators once they index it.", true);

  /* ───────────── load ───────────── */
  function load(quiet) {
    return F.forge("pool", { mint: MINT }).then(function (p) {
      var first = !P; P = p; fetchedAt = Date.now();
      if (first) {
        $("coin").hidden = false;
        $("c-mint").textContent = MINT;
        return Promise.all([F.quoteInfo(p.quoteMint).then(function (q) { Q = q; }), loadMeta()]).then(render);
      }
      render();
    }).catch(function (e) { if (!quiet || !P) F.status(e.message); });
  }
  $("c-copy").addEventListener("click", function () { navigator.clipboard && navigator.clipboard.writeText(MINT).then(function () { $("c-copy").textContent = "Copied"; setTimeout(function () { $("c-copy").textContent = "Copy"; }, 1500); }); });

  /** Name/symbol/uri from Token-2022 metadata or the Metaplex metadata account, then the IPFS JSON. */
  function loadMeta() {
    return F.rpc("getAccountInfo", [MINT, { encoding: "jsonParsed" }]).then(function (r) {
      var v = r && r.value, ext = v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.extensions;
      var tm = (ext || []).filter(function (x) { return x.extension === "tokenMetadata"; })[0];
      if (tm) return { name: tm.state.name, symbol: tm.state.symbol, uri: tm.state.uri };
      var pda = W3.PublicKey.findProgramAddressSync([new TextEncoder().encode("metadata"), new W3.PublicKey(METAPLEX).toBytes(), new W3.PublicKey(MINT).toBytes()], new W3.PublicKey(METAPLEX))[0];
      return F.rpc("getAccountInfo", [pda.toBase58(), { encoding: "base64" }]).then(function (m) { return m && m.value ? parseMetaplex(F.unb64(m.value.data[0])) : {}; });
    }).then(function (m) {
      meta = m || {};
      if (!/^https:\/\//.test(meta.uri || "")) return;
      return fetch(meta.uri).then(function (r) { return r.json(); }).then(function (j) {
        meta.image = j.image; meta.description = j.description; meta.twitter = j.twitter; meta.telegram = j.telegram; meta.website = j.website;
        meta.plan = j.extensions && j.extensions.sineForgeFeePlan;
      }).catch(function () {});
    }).catch(function () {});
  }
  function parseMetaplex(b) {
    var o = 1 + 32 + 32, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), td = new TextDecoder();
    function str() { var n = dv.getUint32(o, true); o += 4; var s = td.decode(b.subarray(o, o + n)); o += n; return s.replace(/\0+$/, "").trim(); }
    try { return { name: str(), symbol: str(), uri: str() }; } catch (e) { return {}; }
  }

  /* ───────────── render ───────────── */
  function qsym() { return F.quoteSymbol(Q); }
  function qUi(raw) { return F.fromRaw(raw, P.quoteDecimals); }
  function cUi(raw) { return F.fromRaw(raw, P.baseDecimals); }
  function render() {
    var sym = (meta.symbol || "").toUpperCase() || F.short(MINT);
    document.title = "$" + sym + " — SINE Forge";
    $("c-sym").textContent = "$" + sym; $("c-name").textContent = meta.name || "";
    if (meta.image) $("c-img").style.backgroundImage = "url(" + meta.image + ")";
    $("c-desc").hidden = !meta.description; $("c-desc").textContent = meta.description || "";
    $("c-pair").textContent = "paired with " + qsym();
    document.querySelectorAll(".q-sym").forEach(function (s) { s.textContent = qsym(); });
    var links = $("c-links"); links.textContent = "";
    [[meta.website, "Website"], [meta.twitter, "X"], [meta.telegram, "Telegram"], ["https://solscan.io/token/" + MINT, "Solscan"], ["https://dexscreener.com/solana/" + MINT, "DexScreener"], ["https://www.geckoterminal.com/solana/tokens/" + MINT, "GeckoTerminal"]]
      .forEach(function (l) { if (/^https:\/\//.test(l[0] || "")) { if (links.childNodes.length) links.appendChild(document.createTextNode(" · ")); links.appendChild(F.link(l[0], l[1])); } });

    var usd = Q && Q.priceUsd;
    $("s-price").textContent = F.fmt(P.priceQuote) + " " + qsym() + (usd ? " · " + F.usd(P.priceQuote * usd) : "");
    $("s-mc").textContent = usd ? F.usd(P.mcapQuote * usd) : F.fmt(P.mcapQuote) + " " + qsym();
    $("s-state").textContent = P.migrated ? "Graduated" : P.curveComplete ? "Graduating…" : "On curve";

    var pct = Math.round(P.progress * 1000) / 10;
    $("p-fill").style.width = Math.min(100, pct) + "%"; $("p-bar").setAttribute("aria-valuenow", pct);
    $("p-text").textContent = P.migrated ? "100% · graduated" : pct + "%";
    $("p-sub").textContent = P.migrated ? "Graduated to Meteora DAMM v2. Trades now go through that pool." + (P.damm && P.damm.pool ? " Pool: " + F.short(P.damm.pool) : "") :
      F.fmt(P.quoteReserve) + " of " + F.fmt(P.graduationQuote) + " " + qsym() + " raised" + (usd ? " (" + F.usd(P.quoteReserve * usd) + " of " + F.usd(P.graduationQuote * usd) + ")" : "") + ". When the curve fills, liquidity moves to a Meteora DAMM v2 pool automatically.";
    $("migrate").hidden = !(P.curveComplete && !P.migrated);

    renderRules(); drawTaxCurve(); tick(); refreshTrade(); renderStudio();
  }

  function renderRules() {
    var r = P.rules, dl = $("r-dl"), bx = $("r-badges"); dl.textContent = ""; bx.textContent = "";
    var badge = function (t, good) { bx.appendChild(el("span", { class: "fg-badge " + (good ? "good" : "warn"), text: t })); };
    badge(r.lockedLpPct + "% of graduation LP locked forever", r.lockedLpPct >= 50);
    badge(r.authority === "immutable" ? "Immutable · no mint authority" : /mint/.test(r.authority) ? "Mint authority kept (" + r.authority + ")" : "Metadata editable by " + r.authority, r.authority === "immutable");
    if (P.taxCurve.length > 1) badge("Anti-sniper launch tax", true);
    if (P.dynamicFee) badge("Volatility fee", true);
    if (r.vested) badge("Team tokens vested", true);
    if (r.devBuySkipsTax) badge("Dev buy at minimum fee", true);
    var row = function (k, v) { dl.appendChild(el("div", null, [el("dt", { text: k }), el("dd", { text: v })])); };
    var lp = 80, H = P.hooks;
    if (H) {
      var now = chainNow(), live = H.active && now < H.launchPhaseEndTs, pctOf = function (bps) { return F.pct(bps / 100); };
      badge(H.active ? (live ? "On-chain rules active" : "Launch-phase rules ended") : "Transfer hook off (graduated)", true);
      var parts = [];
      if (H.maxWalletBps) parts.push("holder cap " + pctOf(H.maxWalletBps));
      if (H.maxTxBps) parts.push("max " + pctOf(H.maxTxBps) + " per transfer");
      if (H.maxBuysPerSlot) parts.push(H.maxBuysPerSlot + " buys per block");
      if (H.noP2p) parts.push("no wallet-to-wallet sends");
      if (H.allowlistUntilTs) parts.push("allowlist (" + H.allowlistCount + " wallets) until " + new Date(H.allowlistUntilTs * 1000).toLocaleTimeString());
      row("Transfer-hook rules", (parts.join(" · ") || "creator rules only") + (H.active ? (live ? " · until " + new Date(H.launchPhaseEndTs * 1000).toLocaleString() : " · ended") : ""));
      if (H.creatorLockUntilTs || H.creatorDailyBps) {
        var c = [];
        if (H.creatorLockUntilTs) c.push(now < H.creatorLockUntilTs ? "can’t sell or send until " + new Date(H.creatorLockUntilTs * 1000).toLocaleDateString() : "lock ended");
        if (H.creatorDailyBps) c.push("max " + pctOf(H.creatorDailyBps) + " of supply per day");
        row("Creator wallet", c.join(" · "));
        if (H.active) badge("Creator sells limited on-chain", true);
      }
      row("Hook program", F.short(H.program));
    }
    row("Fee split", P.partner === P.creator ? "creator 80% · Meteora 20%" : "creator " + F.pct(lp * r.creatorFeeSharePct / 100, 0) + " · platform " + F.pct(lp * (100 - r.creatorFeeSharePct) / 100, 0) + " · Meteora 20%");
    row("Fees collected in", r.collectFeeMode === "quote" ? qsym() + " only" : "both tokens");
    row("After graduation", F.pct(r.graduatedFeeBps / 100) + " fee · " + ({ quote: "paid in " + qsym(), both: "paid in both tokens", compound: "auto-compounding" }[r.graduatedFeeMode]));
    row("Creator’s share of graduation LP", r.creatorLpPct + "%");
    if (r.migrationFeePct) row("Graduation fee", r.migrationFeePct + "% of raised " + qsym());
    row("Creator", F.short(P.creator));
    var plan = meta.plan, box = $("r-plan"); box.textContent = "";
    if (plan) {
      box.appendChild(el("h3", { class: "cn-h3", text: "Published creator-fee plan" }));
      box.appendChild(el("p", { class: "how", text: "Buyback & burn " + plan.buybackBurnPct + "% · add liquidity " + plan.addLiquidityPct + "% · holder airdrops " + plan.holderAirdropPct + "% · fee-share " + plan.feeSharePct + "%" + ((plan.feeShareWallets || []).length ? " (" + plan.feeShareWallets.length + " wallets)" : "") + ". The creator runs it from this page, so check the history on Solscan." }));
    }
  }

  /* ───────────── anti-sniper tax meter ───────────── */
  function chainNow() { return P.now + (Date.now() - fetchedAt) / 1000; }
  function feeAt(e) { var c = P.taxCurve, v = c[0][1]; for (var i = 0; i < c.length; i++) { if (c[i][0] <= e) v = c[i][1]; else break; } return v; }
  function drawTaxCurve() {
    var c = P.taxCurve; $("tax-card").hidden = c.length < 2;
    if (c.length < 2) return;
    var T = c[c.length - 1][0] || 1, X = function (t) { return 4 + 592 * t / T; }, Y = function (p) { return 132 - 112 * p / Math.max(1, c[0][1]); };
    var d = "", prev;
    c.forEach(function (pt, i) { if (i) d += "L" + X(pt[0]).toFixed(1) + " " + Y(prev).toFixed(1); d += (i ? "L" : "M") + X(pt[0]).toFixed(1) + " " + Y(pt[1]).toFixed(1); prev = pt[1]; });
    $("tax-line").setAttribute("d", d); $("tax-area").setAttribute("d", d + "L596 132L4 132Z");
  }
  function tick() {
    if (!P) return;
    var e = chainNow() - P.activationTs, c = P.taxCurve, fee = c.length > 1 ? feeAt(Math.max(0, e)) : P.feePct;
    $("s-fee").textContent = F.pct(fee);
    $("s-fee").style.color = fee >= 10 ? "var(--amber)" : "";
    if (c.length > 1) {
      var T = c[c.length - 1][0];
      $("tax-now").textContent = F.pct(fee);
      $("tax-cursor").setAttribute("x1", 4 + 592 * Math.min(1, Math.max(0, e) / T)); $("tax-cursor").setAttribute("x2", 4 + 592 * Math.min(1, Math.max(0, e) / T));
      $("tax-sub").textContent = e < 0 ? "Trading opens in " + Math.ceil(-e) + " s." : e < T ? "Tax falls to " + F.pct(c[c.length - 1][1]) + " in " + Math.ceil(T - e) + " s. Snipers and bots buying now pay the high fee." : "Launch tax finished " + fmtAgo(e - T) + " ago. The normal fee is " + F.pct(c[c.length - 1][1]) + ".";
    }
  }
  function fmtAgo(s) { return s < 90 ? Math.round(s) + " s" : s < 5400 ? Math.round(s / 60) + " min" : s < 172800 ? Math.round(s / 3600) + " h" : Math.round(s / 86400) + " d"; }
  setInterval(tick, 250);

  /* ───────────── chart ───────────── */
  document.querySelectorAll("#iv-seg button").forEach(function (b) { b.addEventListener("click", function () { iv = b.getAttribute("data-iv"); document.querySelectorAll("#iv-seg button").forEach(function (x) { x.setAttribute("aria-pressed", x === b); }); chart(); }); });
  function chart() {
    fetch("/api/market?address=" + encodeURIComponent(MINT) + "&interval=" + iv).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      var closes = m && m.closes;
      $("ch-empty").hidden = Boolean(closes && closes.length > 2);
      $("ch-grid").textContent = ""; $("ch-line").setAttribute("d", ""); $("ch-area").setAttribute("d", "");
      if (!closes || closes.length < 3) return;
      var data = closes.slice(-360), lo = Math.min.apply(null, data), hi = Math.max.apply(null, data), pad = (hi - lo) * 0.08 || hi * 0.05 || 1e-12;
      lo -= pad; hi += pad;
      var X = function (i) { return 10 + 990 * i / (data.length - 1); }, Y = function (v) { return 12 + 284 * (1 - (v - lo) / (hi - lo)); };
      var d = data.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); }).join("");
      $("ch-line").setAttribute("d", d); $("ch-area").setAttribute("d", d + "L1000 300L10 300Z");
      for (var g = 0; g <= 4; g++) {
        var v = lo + (hi - lo) * g / 4, y = Y(v);
        var ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        ln.setAttribute("x1", 10); ln.setAttribute("x2", 1010); ln.setAttribute("y1", y); ln.setAttribute("y2", y); ln.setAttribute("stroke", "#1D2127");
        $("ch-grid").appendChild(ln);
        var t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", 1018); t.setAttribute("y", y + 7); t.setAttribute("fill", "#8A8F98"); t.setAttribute("font-size", "20"); t.setAttribute("font-family", "IBM Plex Mono, monospace");
        t.textContent = F.usd(v); $("ch-grid").appendChild(t);
      }
    }).catch(function () { $("ch-empty").hidden = false; });
  }

  /* ───────────── trade ───────────── */
  document.querySelectorAll("#side-seg button").forEach(function (b) { b.addEventListener("click", function () { side = b.getAttribute("data-side"); document.querySelectorAll("#side-seg button").forEach(function (x) { x.setAttribute("aria-pressed", x === b); }); $("t-amt").value = ""; refreshTrade(); }); });
  $("t-slip").addEventListener("input", function () { $("t-slip-v").textContent = $("t-slip").value + "%"; });
  function slipBps() { return Math.round(Math.min(50, Math.max(0.1, Number($("t-slip").value) || 5)) * 100); }
  function amountRaw() { return F.toRaw($("t-amt").value, side === "buy" ? P.quoteDecimals : P.baseDecimals); }

  function refreshTrade() {
    if (!P) return;
    var sym = (meta.symbol || "coin").toUpperCase();
    $("t-label").textContent = side === "buy" ? "You pay (" + qsym() + ")" : "You sell ($" + sym + ")";
    var q = $("t-quick"); q.textContent = "";
    if (side === "buy") {
      var unitUsd = Q && Q.priceUsd, steps = unitUsd ? [10, 50, 100, 500].map(function (u) { return +(u / unitUsd).toPrecision(2); }) : [0.1, 0.5, 1, 5];
      if (P.quoteMint === F.SOL_MINT) steps = [0.1, 0.5, 1, 5];
      steps.forEach(function (v) { q.appendChild(el("button", { type: "button", class: "chip fg-chipbtn", text: F.fmt(v, 4) + " " + qsym(), onclick: function () { $("t-amt").value = v; estimate(); } })); });
    } else [25, 50, 100].forEach(function (p) {
      q.appendChild(el("button", { type: "button", class: "chip fg-chipbtn", text: p + "%", onclick: function () { if (bal.coin) { var raw = BigInt(bal.coin) * BigInt(p) / 100n; $("t-amt").value = String(cUi(raw.toString())); estimate(); } } }));
    });
    var label = !F.owner ? "Connect a wallet to trade" : busy ? "Working…" : P.curveComplete && !P.migrated ? "Graduating, back in a moment" : side === "buy" ? "Buy $" + sym : "Sell $" + sym;
    $("t-go").textContent = label;
    $("t-go").disabled = !F.owner || busy || (P.curveComplete && !P.migrated) || !(amountRaw() && amountRaw() !== "0");
    $("t-bal").textContent = F.owner && bal.quote !== null ? "Balance: " + F.fmt(qUi(bal.quote), 4) + " " + qsym() + " · " + F.fmt(cUi(bal.coin || "0")) + " $" + sym : "";
  }
  var estTimer, estSeq = 0;
  function estimate() {
    refreshTrade();
    clearTimeout(estTimer);
    var raw = amountRaw();
    if (!raw || raw === "0") { $("t-est").textContent = ""; return; }
    estTimer = setTimeout(function () {
      var seq = ++estSeq;
      F.forge("swap", { mint: MINT, side: side, amount: raw, slippageBps: slipBps(), quoteOnly: true }).then(function (r) {
        if (seq !== estSeq) return;
        var outUi = side === "buy" ? cUi(r.quote.out) : qUi(r.quote.out), unitSym = side === "buy" ? (meta.symbol ? "$" + meta.symbol.toUpperCase() : "tokens") : qsym();
        var feeUi = r.quote.feeInQuote ? qUi(r.quote.fee) : null;
        $("t-est").textContent = "You get ≈ " + F.fmt(outUi) + " " + unitSym + " (at least " + F.fmt(side === "buy" ? cUi(r.quote.minOut) : qUi(r.quote.minOut)) + ")" + (feeUi !== null ? " · fee " + F.fmt(feeUi, 6) + " " + qsym() : "") + (r.venue === "damm" ? " · via DAMM v2" : "");
      }).catch(function (e) { if (seq === estSeq) $("t-est").textContent = e.message; });
    }, 300);
  }
  $("t-amt").addEventListener("input", estimate);
  $("t-go").addEventListener("click", function () {
    var raw = amountRaw(); if (!raw || busy) return;
    busy = true; refreshTrade(); F.status("Preparing your " + side + "…", true);
    F.forge("swap", { mint: MINT, owner: F.owner.toBase58(), side: side, amount: raw, slippageBps: slipBps(), priority: 100000 })
      .then(function (r) { F.status("Approve the " + side + " in your wallet…", true); return F.signSend(r.tx, side === "buy" ? "Buy" : "Sell"); })
      .then(function (sig) { F.status((side === "buy" ? "Bought" : "Sold") + ". ", true); $("status").appendChild(F.link("https://solscan.io/tx/" + sig, "View on Solscan")); $("t-amt").value = ""; $("t-est").textContent = ""; })
      .catch(function (e) { F.status(F.cancelled(e) ? "Cancelled in your wallet." : e.message); })
      .then(function () { busy = false; return Promise.all([load(true), balances()]); });
  });

  function balances() {
    if (!F.owner || !P) { bal = { quote: null, coin: null }; refreshTrade(); return Promise.resolve(); }
    var o = F.owner.toBase58();
    return Promise.all([F.tokenBalance(o, P.quoteMint), F.tokenBalance(o, MINT)]).then(function (r) { bal = { quote: r[0].raw, coin: r[1].raw }; refreshTrade(); }).catch(function () {});
  }

  /* ───────────── creator studio ───────────── */
  var planLoaded = false;
  function isCreator() { return F.owner && P && F.owner.toBase58() === P.creator; }
  function isPartner() { return F.owner && P && F.owner.toBase58() === P.partner && P.partner !== P.creator; }
  function renderStudio() {
    $("studio").hidden = !isCreator(); $("platform").hidden = !isPartner();
    if (!P) return;
    var sym = (meta.symbol || "").toUpperCase();
    $("cs-fees").textContent = F.fmt(qUi(P.fees.creatorQuote), 6) + " " + qsym() + (P.fees.creatorBase !== "0" ? " + " + F.fmt(cUi(P.fees.creatorBase)) + " $" + sym : "");
    $("cs-life").textContent = F.fmt(qUi(P.fees.totalTradingQuote), 4) + " " + qsym();
    $("pf-fees").textContent = F.fmt(qUi(P.fees.partnerQuote), 6) + " " + qsym() + (P.fees.partnerBase !== "0" ? " + " + F.fmt(cUi(P.fees.partnerBase)) + " $" + sym : "");
    $("tl-lp-box").hidden = !P.migrated; $("tl-lpfees").hidden = !P.migrated; $("tl-surplus").hidden = !P.migrated; $("tl-migfee").hidden = !P.migrated || !P.rules.migrationFeePct;
    if (isCreator() && !planLoaded) {
      planLoaded = true;
      var plan = F.store("plan:" + MINT) || meta.plan;
      if (plan) {
        $("rt-burn").value = plan.buybackBurnPct; $("rt-lp").value = plan.addLiquidityPct; $("rt-hold").value = plan.holderAirdropPct; $("rt-split").value = plan.feeSharePct;
        $("rt-wallets").value = (plan.feeShareWallets || []).map(function (w) { return w.to + ", " + w.weight; }).join("\n");
      }
      renderHistory();
    }
    $("rt-wallets-wrap").hidden = !(Number($("rt-split").value) > 0);
  }
  ["rt-split"].forEach(function (id) { $(id).addEventListener("input", renderStudio); });
  $("rt-src").addEventListener("change", function () { $("rt-amt-wrap").hidden = $("rt-src").value !== "amount"; });

  function history(v) { var k = "router:" + MINT; if (v === undefined) return F.store(k) || []; F.store(k, v.slice(0, 100)); }
  function logSig(label, sig) { var h = history(); h.unshift({ at: Date.now(), label: label, sig: sig }); history(h); renderHistory(); }
  function renderHistory() {
    var ul = $("cs-history"); ul.textContent = "";
    history().slice(0, 30).forEach(function (h) { ul.appendChild(el("li", null, [new Date(h.at).toLocaleString() + " · " + h.label + " · ", F.link("https://solscan.io/tx/" + h.sig, F.short(h.sig))])); });
  }

  /** Runs one wallet action with status text; resolves to the signature(s). */
  function act(label, buildPromise, many) {
    F.status(label + ": preparing…", true);
    return buildPromise.then(function (r) {
      F.status(label + ": approve in your wallet…", true);
      return many ? F.signSendAll(r.txs, r.txs.map(function () { return label; })) : F.signSend(r.tx, label);
    }).then(function (sig) { (Array.isArray(sig) ? sig : [sig]).forEach(function (s) { logSig(label, s); }); return sig; });
  }
  function wrap(p) { busy = true; return p.then(function () { F.status("Done.", true); }).catch(function (e) { F.status(F.cancelled(e) ? "Cancelled in your wallet." : e.message); }).then(function () { busy = false; return Promise.all([load(true), balances()]); }); }
  var me = function () { return F.owner.toBase58(); };

  $("cs-claim").addEventListener("click", function () { if (!busy) wrap(act("Claim creator fees", F.forge("claim", { mint: MINT, owner: me() }))); });
  $("pf-claim").addEventListener("click", function () { if (!busy) wrap(act("Claim platform fees", F.forge("partnerClaim", { mint: MINT, owner: me() }))); });
  $("tl-lpfees").addEventListener("click", function () { if (!busy) wrap(act("Claim LP fees", F.forge("claimLp", { mint: MINT, owner: me() }), true)); });
  $("tl-surplus").addEventListener("click", function () { if (!busy) wrap(act("Withdraw surplus", F.forge("surplus", { mint: MINT, owner: me() }))); });
  $("tl-migfee").addEventListener("click", function () { if (!busy) wrap(act("Withdraw graduation fee", F.forge("migrationFee", { mint: MINT, owner: me() }))); });
  $("migrate").addEventListener("click", function () { if (!busy && F.owner) wrap(act("Graduate to DAMM v2", F.forge("migrate", { mint: MINT, owner: me() }), true)); else if (!F.owner) F.connect().catch(function () {}); });
  $("tl-newc-go").addEventListener("click", function () {
    var to = $("tl-newc").value.trim();
    if (!F.MINT_RE.test(to)) { F.status("Enter a valid wallet address."); return; }
    if (!window.confirm("Give creator rights (fee claims, studio) for this coin to " + to + "? This can’t be undone by you.")) return;
    wrap(act("Transfer creator", F.forge("transferCreator", { mint: MINT, owner: me(), newCreator: to })));
  });
  $("tl-burn-go").addEventListener("click", function () {
    var raw = F.toRaw($("tl-burn").value, P.baseDecimals);
    if (!raw || raw === "0" || busy) return;
    if (!window.confirm("Burn " + $("tl-burn").value + " coins permanently?")) return;
    wrap(act("Burn", F.forge("burn", { mint: MINT, owner: me(), amount: raw })));
  });
  $("tl-lp-go").addEventListener("click", function () {
    var qRaw = F.toRaw($("tl-lp").value, P.quoteDecimals);
    if (!qRaw || qRaw === "0" || busy) return;
    var need = BigInt(Math.floor(qUi(qRaw) / P.priceQuote * 1.03 * Math.pow(10, P.baseDecimals)));
    var have = BigInt(bal.coin || "0"), baseRaw = need < have ? need : have;
    if (baseRaw === 0n) { F.status("You need some of the coin as well to add liquidity. Buy a little first."); return; }
    wrap(act("Add liquidity", F.forge("addLiquidity", { mint: MINT, owner: me(), quoteAmount: qRaw, baseAmount: baseRaw.toString(), lock: $("rt-lock").checked })));
  });

  /* fee router */
  function portion(total, pct) { return total * BigInt(Math.round((Number(pct) || 0) * 100)) / 10000n; }
  function parseWallets() {
    return $("rt-wallets").value.split(/\n+/).map(function (line) { var p = line.split(/[,\s]+/).filter(Boolean); return { to: p[0], weight: Number(p[1] || 1) }; })
      .filter(function (w) { return F.MINT_RE.test(w.to || "") && w.weight > 0; });
  }
  function rStep(id, text, state) {
    var li = document.querySelector('#rt-steps li[data-step="' + id + '"]');
    if (!li) { li = el("li", { "data-step": id }); $("rt-steps").appendChild(li); }
    li.textContent = text; if (state) li.setAttribute("data-state", state); else li.removeAttribute("data-state");
  }
  function coinBal() { return F.tokenBalance(me(), MINT).then(function (r) { return BigInt(r.raw); }); }
  function buyCoins(quoteRaw, label) {
    var before;
    return coinBal().then(function (b) { before = b; return act(label, F.forge("swap", { mint: MINT, owner: me(), side: "buy", amount: quoteRaw.toString(), slippageBps: 800, priority: 100000 })); })
      .then(function () { return F.sleep(1200).then(coinBal); }).then(function (after) { return after - before; });
  }

  function runRouter(auto) {
    if (busy || !isCreator()) return Promise.resolve();
    var pcts = { burn: Number($("rt-burn").value) || 0, lp: Number($("rt-lp").value) || 0, hold: Number($("rt-hold").value) || 0, split: Number($("rt-split").value) || 0 };
    if (pcts.burn + pcts.lp + pcts.hold + pcts.split > 100) { F.status("The router percentages add up to more than 100%."); return Promise.resolve(); }
    var wallets = parseWallets();
    if (pcts.split > 0 && !wallets.length) { F.status("Add at least one fee-share wallet, or set fee-share to 0%."); return Promise.resolve(); }
    F.store("plan:" + MINT, { buybackBurnPct: pcts.burn, addLiquidityPct: pcts.lp, holderAirdropPct: pcts.hold, feeSharePct: pcts.split, feeShareWallets: wallets });
    $("rt-steps").textContent = "";
    busy = true;
    var budget = 0n, baseFees = 0n;
    var start;
    if ($("rt-src").value === "claim" || auto) {
      budget = BigInt(P.fees.creatorQuote); baseFees = BigInt(P.fees.creatorBase);
      if (budget === 0n && baseFees === 0n) { busy = false; F.status("There are no creator fees to claim yet."); return Promise.resolve(); }
      rStep("claim", "Claim " + F.fmt(qUi(budget.toString()), 6) + " " + qsym() + " of fees", "active");
      start = act("Claim creator fees", F.forge("claim", { mint: MINT, owner: me() })).then(function () { rStep("claim", "Claimed " + F.fmt(qUi(budget.toString()), 6) + " " + qsym(), "done"); });
    } else {
      var raw = F.toRaw($("rt-amt").value, P.quoteDecimals);
      if (!raw || raw === "0") { busy = false; F.status("Enter an amount to route."); return Promise.resolve(); }
      budget = BigInt(raw); start = Promise.resolve();
    }
    var burnQ = portion(budget, pcts.burn), lpQ = P.migrated ? portion(budget, pcts.lp) : 0n, holdQ = portion(budget, pcts.hold), splitQ = portion(budget, pcts.split);
    var chain = start;
    if (burnQ > 0n || (baseFees > 0n && pcts.burn > 0)) chain = chain.then(function () {
      rStep("burn", "Buy back with " + F.fmt(qUi(burnQ.toString()), 6) + " " + qsym() + " and burn", "active");
      var got = burnQ > 0n ? buyCoins(burnQ, "Buyback") : Promise.resolve(0n);
      return got.then(function (bought) {
        var total = bought + (pcts.burn > 0 ? baseFees : 0n);
        if (total <= 0n) throw new Error("The buyback confirmed but no coins arrived to burn yet. Burn them later with “Burn coins”.");
        return act("Burn", F.forge("burn", { mint: MINT, owner: me(), amount: total.toString() })).then(function () { rStep("burn", "Bought back and burned " + F.fmt(cUi(total.toString())) + " coins", "done"); });
      });
    });
    if (pcts.lp > 0 && !P.migrated) rStep("lp", "Add liquidity: waits until graduation (that share stays in your wallet)", "done");
    if (lpQ > 0n) chain = chain.then(function () {
      rStep("lp", "Add " + F.fmt(qUi(lpQ.toString()), 6) + " " + qsym() + " of liquidity", "active");
      var half = lpQ / 2n;
      return buyCoins(half, "Buy coins for LP").then(function (coins) {
        if (coins <= 0n) throw new Error("No coins arrived for the liquidity step.");
        return act("Add liquidity", F.forge("addLiquidity", { mint: MINT, owner: me(), quoteAmount: (lpQ - half).toString(), baseAmount: coins.toString(), lock: $("rt-lock").checked }));
      }).then(function () { rStep("lp", "Added liquidity" + ($("rt-lock").checked ? " and locked it forever" : ""), "done"); });
    });
    if (holdQ > 0n) chain = chain.then(function () {
      rStep("hold", "Airdrop " + F.fmt(qUi(holdQ.toString()), 6) + " " + qsym() + " to top holders", "active");
      var exclude = [P.creator, P.partner, P.pool].concat(P.damm && P.damm.pool ? [P.damm.pool] : []);
      return F.forge("holders", { mint: MINT, exclude: exclude }).then(function (r) {
        var hs = r.holders.slice(0, 20), total = hs.reduce(function (s, h) { return s + BigInt(h.amount); }, 0n);
        if (!hs.length || total === 0n) { rStep("hold", "No eligible holders yet; airdrop skipped", "done"); return; }
        var recips = hs.map(function (h) { return { to: h.owner, amount: (holdQ * BigInt(h.amount) / total).toString() }; }).filter(function (x) { return x.amount !== "0"; });
        return act("Holder airdrop", F.forge("transfer", { mint: P.quoteMint, owner: me(), recipients: recips }), true).then(function () { rStep("hold", "Airdropped to " + recips.length + " holders", "done"); });
      });
    });
    if (splitQ > 0n) chain = chain.then(function () {
      rStep("split", "Pay " + F.fmt(qUi(splitQ.toString()), 6) + " " + qsym() + " to fee-share wallets", "active");
      var tw = wallets.reduce(function (s, w) { return s + w.weight; }, 0);
      var recips = wallets.map(function (w) { return { to: w.to, amount: (splitQ * BigInt(Math.round(w.weight * 1000)) / BigInt(Math.round(tw * 1000))).toString() }; }).filter(function (x) { return x.amount !== "0"; });
      return act("Fee share", F.forge("transfer", { mint: P.quoteMint, owner: me(), recipients: recips }), true).then(function () { rStep("split", "Paid " + recips.length + " fee-share wallets", "done"); });
    });
    return chain.then(function () { F.status("Fee router finished.", true); })
      .catch(function (e) { document.querySelectorAll("#rt-steps li[data-state=active]").forEach(function (li) { li.setAttribute("data-state", "failed"); }); F.status(F.cancelled(e) ? "Cancelled in your wallet. Steps already confirmed stay done." : e.message); })
      .then(function () { busy = false; return Promise.all([load(true), balances()]); });
  }
  $("rt-run").addEventListener("click", function () { runRouter(false); });
  var autoTimer = null;
  $("rt-auto").addEventListener("change", function () {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (!this.checked) return;
    var every = Math.max(5, Number($("rt-every").value) || 30) * 60000;
    F.status("Auto router on. Keep this page open; your wallet will ask for approval when it runs.", true);
    var check = function () { load(true).then(function () { var min = F.toRaw($("rt-min").value || "0", P.quoteDecimals) || "0"; if (BigInt(P.fees.creatorQuote) > 0n && BigInt(P.fees.creatorQuote) >= BigInt(min)) runRouter(true); }); };
    check(); autoTimer = setInterval(check, every);
  });

  /* ───────────── holders ───────────── */
  $("h-load").addEventListener("click", function () {
    var ol = $("h-list"); ol.textContent = ""; ol.appendChild(el("li", { class: "muted", text: "Loading…" }));
    F.forge("holders", { mint: MINT, exclude: [] }).then(function (r) {
      ol.textContent = "";
      var supply = P.supply * Math.pow(10, P.baseDecimals);
      r.holders.forEach(function (h) {
        var tag = h.owner === P.creator ? " (creator)" : "";
        ol.appendChild(el("li", null, [F.link("https://solscan.io/account/" + h.owner, F.short(h.owner)), tag + " · " + F.pct(Number(h.amount) / supply * 100)]));
      });
      if (!r.holders.length) ol.appendChild(el("li", { class: "muted", text: "No wallet holders yet." }));
    }).catch(function (e) { ol.textContent = ""; ol.appendChild(el("li", { class: "muted", text: e.message })); });
  });

  /* ───────────── start ───────────── */
  F.onWallet(function () { renderStudio(); balances(); });
  F.initWallet();
  load().then(function () { chart(); balances(); });
  setInterval(function () { if (document.visibilityState === "visible" && !busy) load(true); }, 10000);
  setInterval(function () { if (document.visibilityState === "visible") { chart(); balances(); } }, 30000);
})();
