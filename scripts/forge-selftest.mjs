/**
 * Offline self-test for the Forge launchpad: every preset, plus edge cases, must produce a config
 * the Meteora DBC SDK accepts, and the launch transactions must build within Solana's size limit.
 * Run: npm test   (no network needed: the Solana connection is stubbed)
 */
import assert from 'node:assert/strict';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { normalizeForm, buildConfig, summarize, PRESETS, platformPolicy, SOL_MINT, USDC_MINT, taxCurve } from '../api/_lib/forge.js';
import { buildLaunchTxs } from '../api/forge.js';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const STONK = Keypair.generate().publicKey.toBase58();           // stands in for any SPL quote mint
const quotes = { [SOL_MINT]: 9, [USDC_MINT]: 6, [STONK]: 6 };
const conn = new Connection('http://127.0.0.1:1');
conn.getAccountInfo = async (pk) => (quotes[pk.toBase58()] ? { owner: TOKEN, data: Buffer.alloc(82), lamports: 1, executable: false } : null);
conn.getLatestBlockhash = async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 });

let n = 0;
const ok = (name) => { n++; console.log('  ✓', name); };
const policies = [platformPolicy({}), platformPolicy({ FORGE_PARTNER_WALLET: Keypair.generate().publicKey.toBase58(), FORGE_PLATFORM_FEE_SHARE: '20', FORGE_POOL_CREATION_FEE_SOL: '0.05' })];

for (const policy of policies) {
  console.log(policy.partnerWallet ? 'With platform wallet' : 'Self-hosted (no platform wallet)');
  for (const [key, p] of Object.entries(PRESETS)) {
    const mint = p.form.quoteMode === 'custom' ? STONK : (p.form.quote && p.form.quote.mint) || SOL_MINT;
    const form = { ...p.form, quote: { mint } };
    const norm = normalizeForm(form, { mint, decimals: quotes[mint] }, policy);
    const cfg = buildConfig(norm, policy);
    const sum = summarize(norm, cfg, policy, 'X');
    assert.ok(sum.graduatesAtQuoteRaised > 0);
    assert.ok(sum.feeSplitPct.creator + sum.feeSplitPct.platform + sum.feeSplitPct.meteora === 100);
    const creator = Keypair.generate().publicKey, config = Keypair.generate().publicKey, baseMint = Keypair.generate().publicKey;
    const txs = await buildLaunchTxs(conn, { cfg, policy, creator, config, baseMint, quoteMint: new PublicKey(mint), name: 'Test Coin', symbol: 'TEST', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', devBuy: new BN(10).pow(new BN(quotes[mint] - 1)), minOut: new BN(1), priorityMicroLamports: 50_000 });
    for (const t of [txs.configTx, txs.poolTx]) {
      const size = Buffer.from(t, 'base64').length;
      assert.ok(size <= 1232, `${key}: transaction too large (${size} bytes)`);
    }
    ok(`${p.label} → valid config, ${Buffer.from(txs.configTx, 'base64').length}+${Buffer.from(txs.poolTx, 'base64').length} bytes`);
  }
}

// Anti-sniper tax decays monotonically from start to the trading fee
{
  const policy = policies[0];
  for (const mode of ['linear', 'exponential']) {
    const norm = normalizeForm({ fees: { tradeBps: 100, snipe: { enabled: true, startBps: 9900, durationSec: 60, mode, periods: 60 } } }, { mint: SOL_MINT, decimals: 9 }, policy);
    const curve = taxCurve(buildConfig(norm, policy).poolFees.baseFee);
    assert.ok(Math.abs(curve[0][1] - 99) < 0.01, 'starts at 99%');
    assert.ok(Math.abs(curve[curve.length - 1][1] - 1) < 0.05, `${mode} ends at ~1% (got ${curve[curve.length - 1][1]})`);
    for (let i = 1; i < curve.length; i++) assert.ok(curve[i][1] <= curve[i - 1][1] + 1e-9, 'never increases');
    ok(`${mode} sniper tax: 99% → ${curve[curve.length - 1][1].toFixed(2)}% over ${curve[curve.length - 1][0]} s`);
  }
}

// Bad inputs are rejected with readable messages, out-of-range ones clamped
{
  const policy = policies[1];
  const q = { mint: SOL_MINT, decimals: 9 };
  assert.throws(() => normalizeForm({ curve: { initialMcap: 100, gradMcap: 120 } }, q, policy), /1\.5×/);
  assert.throws(() => normalizeForm({ grad: { lp: { creatorLockedPct: 5, creatorPct: 95 } } }, q, policy), /10%/);
  assert.throws(() => normalizeForm({ grad: { lp: { creatorLockedPct: 50, creatorPct: 10 } } }, q, policy), /100%/);
  const clamped = normalizeForm({ fees: { tradeBps: 5, creatorSharePct: 100, snipe: { enabled: true, startBps: 99999 } } }, q, policy);
  assert.equal(clamped.fees.tradeBps, 25);
  assert.equal(clamped.fees.creatorSharePct, 80);           // platform keeps its 20% share
  assert.equal(clamped.fees.snipe.startBps, 9900);
  ok('rejects impossible settings, clamps out-of-range ones, enforces the platform share');
}

// Helper transactions: burn (buyback & burn) and batched payouts (fee-share / holder airdrops)
{
  const { default: handler } = await import('../api/forge.js');
  const coin = Keypair.generate().publicKey.toBase58();
  quotes[coin] = 6;
  conn.getParsedAccountInfo = async (pk) => (quotes[pk.toBase58()] !== undefined
    ? { value: { owner: TOKEN, data: { parsed: { type: 'mint', info: { decimals: quotes[pk.toBase58()], freezeAuthority: null, extensions: [] } } } } } : { value: null });
  const { Connection: C } = await import('@solana/web3.js');
  Object.assign(C.prototype, { getParsedAccountInfo: conn.getParsedAccountInfo, getLatestBlockhash: conn.getLatestBlockhash });
  const call = async (body) => {
    let status = 0, out;
    const res = { setHeader() {}, status(c) { status = c; return res; }, json(o) { out = o; return res; } };
    await handler({ method: 'POST', body, query: {} }, res);
    return { status, out };
  };
  const owner = Keypair.generate();
  const burn = await call({ action: 'burn', mint: coin, owner: owner.publicKey.toBase58(), amount: '123456789' });
  assert.equal(burn.status, 200, JSON.stringify(burn.out));
  const btx = (await import('@solana/web3.js')).Transaction.from(Buffer.from(burn.out.tx, 'base64'));
  assert.equal(btx.instructions[1].data[0], 15, 'BurnChecked');
  const recipients = Array.from({ length: 13 }, () => ({ to: Keypair.generate().publicKey.toBase58(), amount: '1000' }));
  const tr = await call({ action: 'transfer', mint: STONK, owner: owner.publicKey.toBase58(), recipients });
  assert.equal(tr.status, 200, JSON.stringify(tr.out));
  assert.equal(tr.out.txs.length, 3, '13 recipients → 3 transactions of ≤6');
  for (const t of tr.out.txs) assert.ok(Buffer.from(t, 'base64').length <= 1232);
  const sol = await call({ action: 'transfer', mint: SOL_MINT, owner: owner.publicKey.toBase58(), recipients: recipients.slice(0, 2) });
  assert.equal(sol.out.txs.length, 1);
  const bad = await call({ action: 'burn', mint: coin, owner: owner.publicKey.toBase58(), amount: '-5' });
  assert.equal(bad.status, 400);
  const pv = await call({ action: 'preview', form: { quote: { mint: SOL_MINT } }, devBuy: '1000000000', quoteDecimals: 9 });
  assert.ok(pv.out.summary.devBuy.tokens > 0);
  ok(`burn, batched payouts (${tr.out.txs.length} txs for 13 wallets), SOL payouts, input validation, dev-buy preview (${Math.round(pv.out.summary.devBuy.tokens).toLocaleString()} tokens for 1 SOL)`);
}

console.log(`\n${n} checks passed.`);
