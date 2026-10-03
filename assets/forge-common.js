/*
 * SINE Forge — shared browser helpers: wallet, API, signing, formatting.
 * Non-custodial: transactions are built by /api/forge, partially signed here with keys that never
 * leave the browser (coin mint, config), then signed and paid for by the user's own wallet.
 */
(function () {
  "use strict";
  var W3 = window.solanaWeb3;
  var MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var SOL_MINT = "So11111111111111111111111111111111111111112";
  var listeners = [];
  var F = {
    W3: W3, MINT_RE: MINT_RE, SOL_MINT: SOL_MINT,
    wallet: null, owner: null,
    $: function (id) { return document.getElementById(id); },
  };

  F.el = function (tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k]; else if (k === "class") e.className = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  };
  F.link = function (href, text) { return F.el("a", { href: href, target: "_blank", rel: "noopener", text: text }); };
  F.short = function (a) { return a ? a.slice(0, 4) + "…" + a.slice(-4) : ""; };
  F.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  F.store = function (k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem("sine-forge:" + k) || "null"); localStorage.setItem("sine-forge:" + k, JSON.stringify(v)); } catch (e) { return null; } };
  F.status = function (msg, info) { var el = F.$("status"); if (!el) return; el.textContent = msg || ""; el.className = "notice" + (info ? " info" : ""); el.hidden = !msg; };
  F.cancelled = function (e) { return /reject|cancel|denied|declined/i.test((e && e.message) || ""); };

  /* numbers */
  F.fmt = function (n, d) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    var a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "T"; if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (a >= 1e4) return (n / 1e3).toFixed(1) + "k";
    if (a >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 2 : d });
    if (a === 0) return "0";
    return n.toPrecision(3);
  };
  F.usd = function (n) { return n === null || n === undefined || !isFinite(n) ? "—" : "$" + F.fmt(n); };
  F.pct = function (n, d) { return n === null || n === undefined || !isFinite(n) ? "—" : n.toFixed(d === undefined ? (n < 10 ? 2 : 1) : d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%"; };
  /** "1.5" with 6 decimals → "1500000" (string, exact; no floating point). */
  F.toRaw = function (ui, decimals) {
    var s = String(ui || "").trim().replace(/,/g, "");
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
    var parts = s.split("."), whole = parts[0] || "0", frac = (parts[1] || "").slice(0, decimals);
    while (frac.length < decimals) frac += "0";
    var raw = (whole + frac).replace(/^0+(?=\d)/, "");
    return raw === "" ? "0" : raw;
  };
  F.fromRaw = function (raw, decimals) { return Number(BigInt(raw || 0)) / Math.pow(10, decimals); };
  F.b64 = function (u8) { var s = "", i, CH = 0x8000; for (i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); };
  F.unb64 = function (s) { var bin = atob(s), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };

  /* api */
  F.post = function (url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || "Request failed (" + r.status + ")."); return j; }); });
  };
  F.get = function (url) { return fetch(url).then(function (r) { return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || "Request failed (" + r.status + ")."); return j; }); }); };
  F.forge = function (action, body) { var b = body || {}; b.action = action; return F.post("/api/forge", b); };
  F.rpc = function (method, params) { return F.post("/api/rpc", { method: method, params: params || [] }).then(function (j) { if (j.error) throw new Error(j.error.message || "RPC error"); return j.result; }); };

  /* wallet */
  function provider() {
    return (window.phantom && window.phantom.solana) || (window.solflare && window.solflare.isSolflare && window.solflare) ||
      (window.backpack && window.backpack.solana) || window.solana || null;
  }
  F.onWallet = function (fn) { listeners.push(fn); };
  function setOwner(pk) {
    F.owner = pk;
    var chip = F.$("wallet-chip"), btn = F.$("connect");
    if (chip) chip.textContent = pk ? "Connected · " + F.short(pk.toBase58()) : "Not connected";
    if (btn) btn.textContent = pk ? "Disconnect" : "Connect wallet";
    listeners.forEach(function (fn) { try { fn(pk); } catch (e) { console.error(e); } });
  }
  F.connect = function () {
    var p = provider();
    if (!p) { F.status("No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page."); return Promise.reject(new Error("no wallet")); }
    return p.connect().then(function (r) { F.wallet = p; setOwner(new W3.PublicKey(((r && r.publicKey) || p.publicKey).toString())); F.status(""); return F.owner; })
      .catch(function (e) { F.status("Wallet connection was cancelled."); throw e; });
  };
  F.initWallet = function () {
    var btn = F.$("connect");
    if (btn) btn.addEventListener("click", function () {
      if (F.owner) { try { F.wallet && F.wallet.disconnect && F.wallet.disconnect(); } catch (e) {} F.wallet = null; setOwner(null); return; }
      F.connect().catch(function () {});
    });
    var p0 = provider();
    if (p0 && p0.isConnected && p0.publicKey) { F.wallet = p0; setOwner(new W3.PublicKey(p0.publicKey.toString())); }
    else setOwner(null);
  };

  /* transactions */
  F.decode = function (b64tx) { return W3.Transaction.from(F.unb64(b64tx)); };
  F.send = function (signed) {
    return F.rpc("sendTransaction", [F.b64(signed.serialize()), { encoding: "base64", skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" }]);
  };
  F.confirm = function (sig, label) {
    var t0 = Date.now();
    return (function poll() {
      return F.rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]).then(function (r) {
        var st = r && r.value && r.value[0];
        if (st && st.err) throw new Error((label || "Transaction") + " failed on-chain (" + F.short(sig) + "). " + explainErr(st.err));
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
        if (Date.now() - t0 > 90000) throw new Error((label || "Transaction") + " is taking too long to confirm. Check it on Solscan: " + sig);
        return F.sleep(1500).then(poll);
      });
    })();
  };
  function explainErr(err) {
    var s = JSON.stringify(err);
    if (/Custom":1\b|insufficient/i.test(s)) return "Not enough balance.";
    if (/ExceededSlippage|6004|6002/.test(s)) return "Price moved past your slippage limit.";
    return "";
  }
  /** Signs every transaction in one wallet prompt, then sends them in order, each confirmed before the next. */
  F.signSendAll = function (b64txs, labels, extraSigners) {
    var txs = b64txs.map(function (t, i) { var tx = F.decode(t); (extraSigners && extraSigners[i] || []).forEach(function (k) { tx.partialSign(k); }); return tx; });
    var signAll = F.wallet.signAllTransactions ? F.wallet.signAllTransactions(txs) : txs.reduce(function (p, tx) { return p.then(function (arr) { return F.wallet.signTransaction(tx).then(function (s) { arr.push(s); return arr; }); }); }, Promise.resolve([]));
    return signAll.then(function (signed) {
      var sigs = [];
      return signed.reduce(function (p, tx, i) {
        return p.then(function () { return F.send(tx); }).then(function (sig) { return F.confirm(sig, labels && labels[i]); }).then(function (sig) { sigs.push(sig); });
      }, Promise.resolve()).then(function () { return sigs; });
    });
  };
  F.signSend = function (b64tx, label) { return F.signSendAll([b64tx], [label]).then(function (s) { return s[0]; }); };

  /* balances */
  F.tokenBalance = function (owner, mint) {
    if (mint === SOL_MINT) return F.rpc("getBalance", [owner]).then(function (r) { return { raw: String((r && r.value) || 0), native: true }; });
    return F.rpc("getTokenAccountsByOwner", [owner, { mint: mint }, { encoding: "jsonParsed" }]).then(function (r) {
      var best = 0n;
      ((r && r.value) || []).forEach(function (a) { var amt = BigInt(a.account.data.parsed.info.tokenAmount.amount); if (amt > best) best = amt; });
      return { raw: best.toString() };
    });
  };

  /* quote-asset metadata, cached per page */
  var qcache = {};
  F.quoteInfo = function (mint) {
    if (!qcache[mint]) qcache[mint] = F.get("/api/forge?action=quote&mint=" + encodeURIComponent(mint)).catch(function (e) { delete qcache[mint]; throw e; });
    return qcache[mint];
  };
  F.quoteSymbol = function (q) { return q && q.mint === SOL_MINT ? "SOL" : (q && q.symbol) || "pair"; };

  window.SineForge = F;
})();
