/* SINE Forge vanity-address worker: tries random keys until the address ends with the requested suffix.
 * Runs entirely in the browser; the found secret key is posted only to the page that started it. */
/* global solanaWeb3 */
importScripts("/assets/vendor/solana-web3-1.99.0.min.js");
self.onmessage = function (e) {
  var suffix = String(e.data.suffix || ""), ci = Boolean(e.data.ignoreCase);
  var want = ci ? suffix.toLowerCase() : suffix, n = 0;
  for (;;) {
    var kp = solanaWeb3.Keypair.generate(), a = kp.publicKey.toBase58();
    var tail = a.slice(-want.length);
    if ((ci ? tail.toLowerCase() : tail) === want) { self.postMessage({ progress: n, secretKey: Array.from(kp.secretKey) }); return; }
    if (++n === 2000) { self.postMessage({ progress: n }); n = 0; }
  }
};
