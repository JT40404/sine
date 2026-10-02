/*
 * SINE launchpad — non-custodial. Every transaction is signed by the user's own wallet.
 *   Launch:   IPFS upload (server, Pinata) → PumpPortal builds the create tx → sign with a fresh mint key + wallet → send
 *   Buyback:  claim creator fees → Fourier timing decides → buy (wallet) → burn exactly what was bought (wallet)
 */
(function () {
  "use strict";
  var W3 = window.solanaWeb3, F = window.SineFourier, B = window.SineBuyback;
  var $ = function (id) { return document.getElementById(id); };
  var PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  var TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", TOKEN_LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var PUMP_SUPPLY = 1e9;                     // pump.fun coins start with 1,000,000,000 tokens
  var MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var wallet = null, owner = null, busy = false, autoTimer = null, lastDecision = null, coin = null;

  /* ───────────── helpers ───────────── */
  function status(msg, info) { var el = $("status"); el.textContent = msg || ""; el.className = "notice" + (info ? " info" : ""); el.hidden = !msg; }
  function short(a) { return a ? a.slice(0, 4) + "…" + a.slice(-4) : ""; }
  function sol(l) { return (l / 1e9).toFixed(l >= 1e9 ? 3 : 4) + " SOL"; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem("sine-lp:" + k) || "null"); localStorage.setItem("sine-lp:" + k, JSON.stringify(v)); } catch (e) { return null; } }
  function b64(u8) { var s = "", i, CH = 0x8000; for (i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function unb64(s) { var bin = atob(s), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || "Request failed (" + r.status + ")."); return j; }); });
  }
  function rpc(method, params) { return post("/api/rpc", { method: method, params: params || [] }).then(function (j) { if (j.error) throw new Error(j.error.message || "RPC error"); return j.result; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function step(listId, name, state) {
    document.querySelectorAll("#" + listId + " li").forEach(function (li) { if (li.getAttribute("data-step") === name) li.setAttribute("data-state", state); });
  }
  function resetSteps(listId) { document.querySelectorAll("#" + listId + " li").forEach(function (li) { li.removeAttribute("data-state"); }); }

  /* ───────────── wallet ───────────── */
  function provider() {
    return (window.phantom && window.phantom.solana) || (window.solflare && window.solflare.isSolflare && window.solflare) ||
      (window.backpack && window.backpack.solana) || window.solana || null;
  }
  function setWallet(pk) {
    owner = pk; $("wallet-chip").textContent = pk ? "Connected · " + short(pk.toBase58()) : "Not connected";
    $("connect").textContent = pk ? "Disconnect" : "Connect wallet";
    refreshLaunchButton(); refreshBuybackButtons(); renderMyLaunches();
    if (pk && coin) loadCoin(coin.mint, true);
  }
  $("connect").addEventListener("click", function () {
    if (owner) { try { wallet && wallet.disconnect && wallet.disconnect(); } catch (e) {} wallet = null; setWallet(null); return; }
    var p = provider();
    if (!p) { status("No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page."); return; }
    p.connect().then(function (r) { wallet = p; setWallet(new W3.PublicKey(((r && r.publicKey) || p.publicKey).toString())); status(""); })
      .catch(function () { status("Wallet connection was cancelled."); });
  });

  /** Sign with the wallet, send through the site's RPC relay, and wait for confirmation. */
  function signSendConfirm(tx, label) {
    return wallet.signTransaction(tx).then(function (signed) {
      return rpc("sendTransaction", [b64(signed.serialize()), { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
    }).then(function (sig) { return confirm(sig, label); });
  }
  function confirm(sig, label) {
    var t0 = Date.now();
    return (function poll() {
      return rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]).then(function (r) {
        var st = r && r.value && r.value[0];
        if (st && st.err) throw new Error(label + " failed on-chain. Nothing further was done. (" + short(sig) + ")");
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
        if (Date.now() - t0 > 90000) throw new Error(label + " is taking too long to confirm. Check it on Solscan: " + sig);
        return sleep(1500).then(poll);
      });
    })();
  }

  /* ───────────── tabs ───────────── */
  function showTab(which) {
    ["launch", "buyback"].forEach(function (t) {
      var on = t === which; $("tab-" + t).setAttribute("aria-selected", on); $("tab-" + t).setAttribute("aria-pressed", on); $("panel-" + t).hidden = !on;
    });
  }
  $("tab-launch").addEventListener("click", function () { showTab("launch"); });
  $("tab-buyback").addEventListener("click", function () { showTab("buyback"); });

  /* ───────────── LAUNCH ───────────── */
  var imageData = null;
  function refreshLaunchButton() {
    var ok = owner && $("f-name").value.trim() && $("f-symbol").value.trim() && imageData && $("f-terms").checked && !busy;
    $("launch-btn").disabled = !ok;
    $("launch-btn").textContent = !owner ? "Connect a wallet to launch" : busy ? "Launching…" : "Launch on pump.fun";
  }
  ["f-name", "f-symbol", "f-desc", "f-terms"].forEach(function (id) { $(id).addEventListener("input", preview); $(id).addEventListener("change", preview); });
  function preview() {
    $("pv-name").textContent = $("f-name").value.trim() || "Your coin";
    $("pv-sym").textContent = "$" + ($("f-symbol").value.trim().toUpperCase() || "TICKER");
    $("pv-desc").textContent = $("f-desc").value.trim() || "Description appears here.";
    refreshLaunchButton();
  }
  $("f-image").addEventListener("change", function () {
    var f = this.files && this.files[0]; imageData = null;
    if (!f) return preview();
    if (f.size > 1000000) { status("That image is over 1 MB. Please choose a smaller one."); this.value = ""; return preview(); }
    var rd = new FileReader();
    rd.onload = function () { imageData = rd.result; $("pv-img").style.backgroundImage = "url(" + imageData + ")"; preview(); };
    rd.readAsDataURL(f);
  });

  $("launch-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if ($("launch-btn").disabled) return;
    var name = $("f-name").value.trim(), symbol = $("f-symbol").value.trim().toUpperCase();
    var devBuy = Math.max(0, Math.min(5, Number($("f-devbuy").value) || 0)), slip = Math.max(1, Math.min(50, Number($("f-slip").value) || 10));
    var mint = W3.Keypair.generate();               // the coin's address; its secret key never leaves this browser
    busy = true; refreshLaunchButton(); resetSteps("steps"); $("launch-result").hidden = true; status("");
    step("steps", "upload", "active");
    post("/api/upload", { image: imageData, name: name, symbol: symbol, description: $("f-desc").value, twitter: $("f-twitter").value.trim(), telegram: $("f-telegram").value.trim(), website: $("f-website").value.trim() })
      .then(function (up) {
        step("steps", "upload", "done"); step("steps", "build", "active");
        return post("/api/pump", { action: "create", publicKey: owner.toBase58(), mint: mint.publicKey.toBase58(), tokenMetadata: { name: name, symbol: symbol, uri: up.uri }, amount: devBuy, slippage: slip, priorityFee: 0.0005 });
      })
      .then(function (r) {
        step("steps", "build", "done"); step("steps", "sign", "active");
        var tx = W3.VersionedTransaction.deserialize(unb64(r.tx));
        tx.sign([mint]);                              // the new coin's key co-signs, as pump.fun requires
        return wallet.signTransaction(tx);
      })
      .then(function (signed) {
        step("steps", "sign", "done"); step("steps", "confirm", "active");
        return rpc("sendTransaction", [b64(signed.serialize()), { encoding: "base64", skipPreflight: false, maxRetries: 3 }]).then(function (sig) { return confirm(sig, "Launch"); });
      })
      .then(function (sig) {
        step("steps", "confirm", "done");
        var m = mint.publicKey.toBase58(), list = store("launches:" + owner.toBase58()) || [];
        list.unshift({ mint: m, name: name, symbol: symbol, sig: sig, at: Date.now() }); store("launches:" + owner.toBase58(), list.slice(0, 50));
        renderMyLaunches();
        var res = $("launch-result"); res.hidden = false; res.textContent = "";
        res.appendChild(el("h2", "$" + symbol + " is live"));
        res.appendChild(el("p", "Contract address: ", el("code", m)));
        var links = el("p"); links.appendChild(link("https://pump.fun/coin/" + m, "View on pump.fun")); links.appendChild(document.createTextNode(" · ")); links.appendChild(link("https://solscan.io/tx/" + sig, "Transaction on Solscan")); res.appendChild(links);
        var b = el("button", "Set up buyback & burn for $" + symbol); b.className = "btn"; b.type = "button";
        b.addEventListener("click", function () { $("bb-mint").value = m; showTab("buyback"); loadCoin(m); }); res.appendChild(b);
        $("launch-form").reset(); imageData = null; $("pv-img").style.backgroundImage = ""; preview();
      })
      .catch(function (err) {
        document.querySelectorAll("#steps li[data-state=active]").forEach(function (li) { li.setAttribute("data-state", "failed"); });
        status(/reject|cancel|denied/i.test(err.message) ? "You cancelled the approval in your wallet. Nothing was launched." : err.message);
      })
      .then(function () { busy = false; refreshLaunchButton(); });
  });

  function el(tag, text, child) { var e = document.createElement(tag); if (text) e.textContent = text; if (child) e.appendChild(child); return e; }
  function link(href, text) { var a = el("a", text); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; }
  function renderMyLaunches() {
    var ul = $("my-launches"); ul.textContent = "";
    var list = owner ? (store("launches:" + owner.toBase58()) || []) : [];
    if (!list.length) { ul.appendChild(el("li", owner ? "No launches from this wallet in this browser yet." : "Connect a wallet to see coins you launched here.")).className = "muted"; return; }
    list.forEach(function (c) {
      var li = el("li"); li.appendChild(el("strong", "$" + c.symbol)); li.appendChild(document.createTextNode(" " + c.name + " · "));
      li.appendChild(link("https://pump.fun/coin/" + c.mint, short(c.mint)));
      var b = el("button", "Buyback"); b.type = "button"; b.className = "linklike";
      b.addEventListener("click", function () { $("bb-mint").value = c.mint; showTab("buyback"); loadCoin(c.mint); });
      li.appendChild(document.createTextNode(" · ")); li.appendChild(b); ul.appendChild(li);
    });
  }

  /* ───────────── BUYBACK & BURN ───────────── */
  var SETTINGS = ["s-tranche", "s-wait", "s-maxp", "s-slip", "s-interval"];
  function key(k) { return k + ":" + (owner ? owner.toBase58() : "-") + ":" + (coin ? coin.mint : "-"); }
  function settings() { return { tranchePct: Number($("s-tranche").value), maxWaitHours: Number($("s-wait").value), maxP: Number($("s-maxp").value), slippage: Number($("s-slip").value), interval: $("s-interval").value }; }
  SETTINGS.forEach(function (id) { $(id).addEventListener("change", function () { if (coin) store(key("settings"), settings()); if (id === "s-interval") refreshSignal(); else recompute(); }); });

  function budget(v) { if (v === undefined) return Number(store(key("budget")) || 0); store(key("budget"), Math.max(0, Math.floor(v))); }
  function history(v) { if (v === undefined) return store(key("history")) || []; store(key("history"), v.slice(0, 100)); }

  $("bb-load").addEventListener("click", function () { loadCoin($("bb-mint").value.trim()); });
  function loadCoin(mint, quiet) {
    if (!MINT_RE.test(mint || "")) { status("That doesn’t look like a Solana contract address."); return; }
    coin = { mint: mint, tokenProgram: null, decimals: 6 };
    var s = store(key("settings")); if (s) { $("s-tranche").value = s.tranchePct; $("s-wait").value = s.maxWaitHours; $("s-maxp").value = s.maxP; $("s-slip").value = s.slippage; $("s-interval").value = s.interval; }
    $("bb-analyzer").href = "/analyzer?ca=" + encodeURIComponent(mint) + "&interval=" + $("s-interval").value;
    if (!quiet) status("");
    rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]).then(function (r) {
      var v = r && r.value;
      if (!v) throw new Error("No coin found at that address.");
      coin.tokenProgram = v.owner;
      coin.decimals = (v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.decimals) || 6;
      $("bb-coin").textContent = "Coin " + short(mint) + " · " + (v.owner === TOKEN_2022 ? "Token-2022" : "SPL token") + " · fees come from the connected wallet’s pump.fun creator rewards.";
    }).catch(function (e) { $("bb-coin").textContent = e.message; });
    refreshVault(); refreshBurned(); renderHistory(); recompute(); refreshSignal();
  }

  function vaultAddress() {
    return W3.PublicKey.findProgramAddressSync([new TextEncoder().encode("creator-vault"), owner.toBytes()], new W3.PublicKey(PUMP_PROGRAM))[0];
  }
  function vaultLamports() {
    return rpc("getBalance", [vaultAddress().toBase58()]).then(function (r) {
      var lam = (r && r.value) || 0;
      return Math.max(0, lam - 890880);          // keep the account's rent reserve out of the "claimable" figure
    });
  }
  function refreshVault() {
    if (!owner) { $("bb-vault").textContent = "connect the creator wallet"; return; }
    vaultLamports().then(function (l) { $("bb-vault").textContent = sol(l); }).catch(function () { $("bb-vault").textContent = "unavailable"; });
  }

  $("bb-claim").addEventListener("click", function () {
    if (busy || !owner || !coin) return;
    busy = true; refreshBuybackButtons(); status("Preparing the fee claim…", true);
    var before;
    vaultLamports().then(function (v) { before = v; return post("/api/pump", { action: "collectCreatorFee", publicKey: owner.toBase58(), priorityFee: 0.0001 }); })
      .then(function (r) { status("Approve the fee claim in your wallet…", true); return signSendConfirm(W3.VersionedTransaction.deserialize(unb64(r.tx)), "Fee claim"); })
      .then(function (sig) { return sleep(1500).then(function () { return vaultLamports(); }).then(function (after) { return { sig: sig, claimed: Math.max(0, before - after) }; }); })
      .then(function (r) {
        budget(budget() + r.claimed); refreshVault(); recompute();
        status(r.claimed > 0 ? "Claimed " + sol(r.claimed) + " into this coin’s buyback budget." : "Claim confirmed, but there were no fees to collect yet.", true);
      })
      .catch(function (e) { status(/reject|cancel|denied/i.test(e.message) ? "Claim cancelled in your wallet." : e.message); })
      .then(function () { busy = false; refreshBuybackButtons(); });
  });

  /* Fourier timing */
  var analysis = null, stress = null;
  function refreshSignal() {
    if (!coin) return;
    $("bb-signal").textContent = "Analysing…"; $("bb-signal").setAttribute("data-action", "wait");
    $("bb-analyzer").href = "/analyzer?ca=" + encodeURIComponent(coin.mint) + "&interval=" + $("s-interval").value;
    fetch("/api/market?address=" + encodeURIComponent(coin.mint) + "&interval=" + $("s-interval").value)
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "No market data"); return j; }); })
      .then(function (m) {
        analysis = F.analyze(m.closes, m.intervalHours); stress = F.stressIndex(m.closes);
        coin.symbol = m.token && m.token.symbol; recompute();
      })
      .catch(function () { analysis = null; stress = null; recompute(); });
  }
  function recompute() {
    if (!coin) return;
    var s = settings();
    var d = B.decide(analysis, stress, { lastBuyAt: store(key("lastBuyAt")), now: Date.now() }, { maxP: s.maxP, maxWaitHours: s.maxWaitHours, tranchePct: s.tranchePct });
    lastDecision = d;
    var label = { buy: "BUY BACK NOW", dca: "FALLBACK BUY DUE", wait: "WAIT" }[d.action];
    $("bb-signal").textContent = label; $("bb-signal").setAttribute("data-action", d.action);
    $("bb-signal-sub").textContent = d.action === "wait" && isFinite(d.waitLeftHours) ? "fallback buy in ~" + Math.ceil(d.waitLeftHours) + " h if no good trough" : "";
    var ul = $("bb-reasons"); ul.textContent = ""; d.reasons.forEach(function (r) { ul.appendChild(el("li", r)); });
    var read = $("bb-read"); read.textContent = "";
    var row = function (k, v) { var div = el("div"); div.appendChild(el("dt", k)); div.appendChild(el("dd", v)); read.appendChild(div); };
    if (analysis && analysis.peaks.length) {
      row("Rhythm", ["No clear rhythm", "Weak", "Moderate", "Strong", "Very strong"][d.level] + " · every " + fmtH(analysis.peaks[0].period));
      row("Chance vs. random walk", analysis.sig ? "p = " + analysis.sig.pTop.toFixed(2) : "—");
      row("Cycle position", (d.phase.frac * 100).toFixed(0) + "% · " + (d.phase.rising ? "rising" : "falling"));
      row("Stress", stress ? ["Calm", "Elevated", "High"][stress.level] : "—");
    } else row("Market data", "not enough history yet (timing falls back to the clock)");
    var b = budget(), spend = B.trancheLamports(b, s.tranchePct);
    $("bb-budget").textContent = sol(b) + (b ? " · next round spends " + sol(spend) : "");
    refreshBuybackButtons();
    if ($("bb-auto").checked && (d.action === "buy" || d.action === "dca") && b > 0 && !busy) runBuyback(false);
  }
  function fmtH(h) { return h < 1 ? Math.round(h * 60) + " min" : h < 48 ? h.toFixed(1) + " h" : (h / 24).toFixed(1) + " d"; }

  function refreshBuybackButtons() {
    var ready = owner && coin && !busy, b = coin && owner ? budget() : 0;
    $("bb-claim").disabled = !ready;
    var due = lastDecision && (lastDecision.action === "buy" || lastDecision.action === "dca");
    $("bb-run").disabled = !(ready && b > 0 && due);
    $("bb-run").textContent = !owner ? "Connect the creator wallet" : !coin ? "Load a coin first" : busy ? "Working…" : !(b > 0) ? "Claim fees first" : due ? "Buy back & burn " + sol(B.trancheLamports(b, settings().tranchePct)) : "Waiting for a good moment";
    $("bb-override").disabled = !(ready && b > 0);
  }
  $("bb-run").addEventListener("click", function () { runBuyback(false); });
  $("bb-override").addEventListener("click", function () {
    if (window.confirm("Buy back now, ignoring the Fourier timing?")) runBuyback(true);
  });
  $("bb-auto").addEventListener("change", function () {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (this.checked) { autoTimer = setInterval(refreshSignal, 60000); status("Auto mode on: keep this page open. Your wallet will ask for approval when it’s time to buy back.", true); refreshSignal(); }
  });

  /** One round: buy with a tranche of the budget, then burn exactly the tokens that arrived. */
  function runBuyback(override) {
    if (busy || !owner || !coin) return;
    var b = budget(), spend = B.trancheLamports(b, settings().tranchePct);
    if (!(spend > 0)) return;
    busy = true; refreshBuybackButtons(); resetSteps("bb-steps"); step("bb-steps", "buy", "active");
    status("Preparing the buyback of " + sol(spend) + (override ? " (timing overridden)" : "") + "…", true);
    var tokenBefore, buySig;
    tokenBalance().then(function (t) { tokenBefore = t; return post("/api/pump", { action: "buy", publicKey: owner.toBase58(), mint: coin.mint, amount: spend / 1e9, slippage: settings().slippage, priorityFee: 0.0001 }); })
      .then(function (r) { status("Approve the buy in your wallet…", true); return signSendConfirm(W3.VersionedTransaction.deserialize(unb64(r.tx)), "Buy"); })
      .then(function (sig) {
        buySig = sig; budget(budget() - spend); store(key("lastBuyAt"), Date.now());
        step("bb-steps", "buy", "done"); step("bb-steps", "burn", "active");
        return sleep(1500).then(tokenBalance);
      })
      .then(function (after) {
        var bought = after.amount - tokenBefore.amount;
        if (!(bought > 0n)) throw new Error("The buy confirmed, but no new tokens showed up to burn yet. Refresh in a moment; the bought tokens are in your wallet.");
        status("Approve the burn of the " + fmtTokens(bought) + " tokens just bought…", true);
        return burnTx(after.account, bought).then(function (tx) { return signSendConfirm(tx, "Burn"); }).then(function (burnSig) { return { burnSig: burnSig, bought: bought }; });
      })
      .then(function (r) {
        step("bb-steps", "burn", "done");
        var h = history(); h.unshift({ at: Date.now(), sol: spend, tokens: r.bought.toString(), buySig: buySig, burnSig: r.burnSig, mode: override ? "manual" : lastDecision ? lastDecision.action : "buy" }); history(h);
        status("Bought back " + sol(spend) + " and burned " + fmtTokens(r.bought) + " tokens.", true);
        renderHistory(); refreshBurned(); recompute();
      })
      .catch(function (e) {
        document.querySelectorAll("#bb-steps li[data-state=active]").forEach(function (li) { li.setAttribute("data-state", "failed"); });
        status(/reject|cancel|denied/i.test(e.message) ? "Cancelled in your wallet." + (buySig ? " The buy went through; burn the tokens later from your wallet, or run another round." : " Nothing was bought.") : e.message);
      })
      .then(function () { busy = false; recompute(); });
  }

  function tokenBalance() {
    return rpc("getTokenAccountsByOwner", [owner.toBase58(), { mint: coin.mint }, { encoding: "jsonParsed" }]).then(function (r) {
      var accts = (r && r.value) || [], best = null;
      accts.forEach(function (a) {
        var amt = BigInt(a.account.data.parsed.info.tokenAmount.amount);
        if (!best || amt > best.amount) best = { account: a.pubkey, amount: amt, program: a.account.owner };
      });
      if (best && best.program) coin.tokenProgram = best.program;
      return best || { account: null, amount: 0n };
    });
  }
  function fmtTokens(raw) { var n = Number(raw) / Math.pow(10, coin.decimals || 6); return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(2); }

  /** SPL / Token-2022 BurnChecked: burns `amount` raw units from `account`, signed by the owner. */
  function burnTx(account, amount) {
    var data = new Uint8Array(10); data[0] = 15;                 // instruction 15 = BurnChecked
    var v = amount; for (var i = 0; i < 8; i++) { data[1 + i] = Number(v & 0xffn); v >>= 8n; }
    data[9] = coin.decimals || 6;
    var ix = new W3.TransactionInstruction({
      programId: new W3.PublicKey(coin.tokenProgram || TOKEN_2022),
      keys: [
        { pubkey: new W3.PublicKey(account), isSigner: false, isWritable: true },
        { pubkey: new W3.PublicKey(coin.mint), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: data,
    });
    return rpc("getLatestBlockhash", [{ commitment: "confirmed" }]).then(function (r) {
      var tx = new W3.Transaction({ feePayer: owner, recentBlockhash: r.value.blockhash });
      tx.add(ix); return tx;
    });
  }

  function refreshBurned() {
    if (!coin) return;
    rpc("getTokenSupply", [coin.mint]).then(function (r) {
      var now = r && r.value ? Number(r.value.uiAmountString || r.value.uiAmount) : NaN;
      if (!isFinite(now)) throw 0;
      var burned = Math.max(0, PUMP_SUPPLY - now);
      $("bb-burned").textContent = burned >= 1e6 ? (burned / 1e6).toFixed(2) + "M tokens" : Math.round(burned).toLocaleString() + " tokens";
      $("bb-burned-sub").textContent = " · " + (burned / PUMP_SUPPLY * 100).toFixed(3) + "% of the original 1B supply (read from the chain)";
    }).catch(function () { $("bb-burned").textContent = "—"; $("bb-burned-sub").textContent = ""; });
  }
  function renderHistory() {
    var ul = $("bb-history"); ul.textContent = "";
    var h = coin && owner ? history() : [];
    if (!h.length) { ul.appendChild(el("li", "Buybacks from this browser appear here, with links to the on-chain transactions.")).className = "muted"; return; }
    h.forEach(function (x) {
      var li = el("li", new Date(x.at).toLocaleString() + " · " + sol(x.sol) + " → burned " + fmtTokens(BigInt(x.tokens)) + " (" + x.mode + ") · ");
      li.appendChild(link("https://solscan.io/tx/" + x.buySig, "buy")); li.appendChild(document.createTextNode(" · ")); li.appendChild(link("https://solscan.io/tx/" + x.burnSig, "burn"));
      ul.appendChild(li);
    });
  }

  /* ───────────── start ───────────── */
  var params = new URLSearchParams(location.search);
  var startMint = params.get("mint") || ((window.SINE_CONFIG || {}).tokenAddress || "");
  if (params.get("tab") === "buyback") showTab("buyback");
  if (MINT_RE.test(startMint)) { $("bb-mint").value = startMint; loadCoin(startMint, true); }
  preview(); renderMyLaunches(); refreshBuybackButtons();
  var p0 = provider();
  if (p0 && p0.isConnected && p0.publicKey) { wallet = p0; setWallet(new W3.PublicKey(p0.publicKey.toString())); }
})();
