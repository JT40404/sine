import BN from 'bn.js';
import {
  Connection, PublicKey, Keypair, Transaction, SystemProgram, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, createBurnCheckedInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDammV2PoolAddress, getPriceFromSqrtPrice,
  DAMM_V2_MIGRATION_FEE_ADDRESS, DYNAMIC_BONDING_CURVE_PROGRAM_ID, getCurrentPoint, getBaseFeeHandler,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, derivePositionAddress, derivePositionNftAccount, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import { json, readJson, isAddress } from './_lib/http.js';
import { gecko } from './_lib/gecko.js';
import { normalizeForm, buildConfig, summarize, taxCurve, platformPolicy, PRESETS, DEFAULT_FORM, SOL_MINT, FormError,
  hookConfigureIx, hookSwapAccounts, hookConfigAddress, decodeHookRules, MAX_HOOK_ALLOWLIST } from './_lib/forge.js';

/**
 * /api/forge — SINE Forge, the everything-launchpad (Meteora Dynamic Bonding Curve + DAMM v2).
 *
 * Non-custodial like the rest of the launchpad: this route only BUILDS unsigned transactions.
 * The browser generates the coin's mint key and the per-coin config key, partially signs with
 * them, and the user's wallet signs and pays. The only keys created here are throwaway LP-position
 * NFT mints (they control nothing until the user's wallet signs the transaction that uses them).
 *
 *   GET  ?action=setup                         presets, defaults, platform policy
 *   GET  ?action=quote&mint=<mint>             inspect a quote asset (decimals, token program, price)
 *   POST { action: 'preview', form, devBuy }   what a launch will do, before signing
 *   POST { action: 'create', … }               config tx + pool-with-dev-buy tx
 *   POST { action: 'pool', mint | pool }       live state: progress, price, live tax, fees owed
 *   POST { action: 'swap', … }                 buy / sell on the curve, or on DAMM v2 after graduation
 *   POST { action: 'claim' | 'partnerClaim' | 'claimLp' | 'surplus' | 'migrationFee', … }
 *   POST { action: 'migrate', … }              push a full curve to DAMM v2 (anyone may call)
 *   POST { action: 'burn' | 'transfer', … }    buyback-burn and fee-sharing helpers
 *   POST { action: 'addLiquidity', … }         add (and optionally permanently lock) DAMM v2 liquidity
 *   POST { action: 'transferCreator', … }      hand the coin's creator rights to another wallet
 *   POST { action: 'holders', mint }           top holders (for holder airdrops)
 */

const U64_MAX = new BN('18446744073709551615');
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();

let _conn;
function connection() {
  if (!_conn) _conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  return _conn;
}
const pk = (s) => new PublicKey(s);
const bn = (v, name) => {
  const s = String(v ?? '');
  if (!/^\d{1,20}$/.test(s)) throw new FormError(`Invalid ${name || 'amount'}.`);
  const b = new BN(s);
  if (b.gt(U64_MAX)) throw new FormError(`${name || 'Amount'} is too large.`);
  return b;
};
const need = (cond, msg) => { if (!cond) throw new FormError(msg); };

/** Priority fee, fee payer, blockhash, server-side partial signatures → base64 wire format. */
async function finalize(conn, tx, payer, { signers = [], priorityMicroLamports = 50_000, blockhash } = {}) {
  const hasPrice = tx.instructions.some((ix) => ix.programId.toBase58() === COMPUTE_BUDGET && ix.data[0] === 3);
  if (!hasPrice && priorityMicroLamports > 0) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash || (await conn.getLatestBlockhash('confirmed')).blockhash;
  if (signers.length) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
const priority = (v) => Math.round(Math.min(2_000_000, Math.max(0, Number(v) || 50_000)));

/** Reads a mint: decimals, owning token program, Token-2022 extensions. */
async function mintInfo(conn, mint) {
  const acc = await conn.getParsedAccountInfo(pk(mint), 'confirmed');
  const v = acc && acc.value;
  need(v, 'No token exists at that address.');
  const program = v.owner.toBase58();
  need(program === TOKEN_PROGRAM_ID.toBase58() || program === TOKEN_2022_PROGRAM_ID.toBase58(), 'That address is not a token mint.');
  const info = v.data && v.data.parsed && v.data.parsed.info;
  need(info && v.data.parsed.type === 'mint', 'That address is not a token mint.');
  const extensions = (info.extensions || []).map((e) => e.extension);
  return { mint, decimals: Number(info.decimals), program, token2022: program === TOKEN_2022_PROGRAM_ID.toBase58(), extensions,
    freezeAuthority: info.freezeAuthority || null, mintAuthority: info.mintAuthority || null };
}
async function marketInfo(mint) {
  try {
    const j = await gecko(`/networks/solana/tokens/${mint}`, 60_000);
    const a = (j && j.data && j.data.attributes) || {};
    return { symbol: a.symbol || null, name: a.name || null, image: a.image_url && a.image_url !== 'missing.png' ? a.image_url : null, priceUsd: a.price_usd ? Number(a.price_usd) : null };
  } catch { return { symbol: null, name: null, image: null, priceUsd: null }; }
}

/** Builds the launch transactions (plus the hook-rules transaction for hooked coins). Exported for the offline self-test. */
export async function buildLaunchTxs(conn, { cfg, norm, policy, creator, config, baseMint, quoteMint, name, symbol, uri, devBuy, minOut, priorityMicroLamports }) {
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  const partner = policy.partnerWallet ? pk(policy.partnerWallet) : creator;
  const hooked = Boolean(norm && norm.hooks && norm.hooks.enabled);
  const firstBuy = devBuy && devBuy.gtn(0)
    ? { buyer: creator, receiver: creator, buyAmount: devBuy, minimumAmountOut: minOut || new BN(1), referralTokenAccount: null, ...(hooked ? hookSwapAccounts(baseMint, policy.hookProgram) : {}) }
    : undefined;
  const base = { ...cfg, config, feeClaimer: partner, leftoverReceiver: creator, quoteMint, payer: creator,
    preCreatePoolParam: { name, symbol, uri, poolCreator: creator, baseMint }, firstBuyParam: firstBuy };
  const { createConfigTx, createPoolWithFirstBuyTx } = hooked
    ? await client.partner.createConfigAndPoolWithFirstBuyWithTransferHook({ ...base, transferHookProgram: pk(policy.hookProgram) })
    : await client.partner.createConfigAndPoolWithFirstBuy(base);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const out = {
    configTx: await finalize(conn, createConfigTx, creator, { priorityMicroLamports, blockhash }),
    poolTx: await finalize(conn, createPoolWithFirstBuyTx, creator, { priorityMicroLamports, blockhash }),
    pool: deriveDbcPoolAddress(quoteMint, baseMint, config).toBase58(),
  };
  // Rules go on-chain FIRST (signed by the mint key), so the coin can never trade without them.
  if (hooked) out.hookTx = await finalize(conn, new Transaction().add(hookConfigureIx(norm, creator, baseMint, policy.hookProgram)), creator, { priorityMicroLamports, blockhash });
  return out;
}

/** The transfer-hook program named by a Token-2022 mint (null when none or revoked at graduation). */
async function mintHook(conn, mint) {
  const acc = await conn.getParsedAccountInfo(pk(mint), 'confirmed');
  const ext = acc && acc.value && acc.value.data && acc.value.data.parsed && acc.value.data.parsed.info && acc.value.data.parsed.info.extensions;
  const th = (ext || []).find((e) => e.extension === 'transferHook');
  const prog = th && th.state && th.state.programId;
  return prog && prog !== PublicKey.default.toBase58() ? prog : null;
}

/** Finds the DBC pool (by pool address or by coin mint) with its config. */
async function loadPool(client, b) {
  let address, vp;
  if (isAddress(b.pool)) { address = pk(b.pool); vp = await client.state.getPool(address); }
  else if (isAddress(b.mint)) {
    const found = await client.state.getPoolByBaseMint(pk(b.mint));
    if (found) { address = found.publicKey; vp = found.account; }
  }
  need(vp, 'No Forge (Meteora bonding curve) pool found for that coin.');
  const config = await client.state.getPoolConfig(vp.config);
  return { address, vp, config };
}

/** The graduated DAMM v2 pool: derived from the migration config, with a scan as fallback. */
async function loadDamm(conn, vp, config) {
  const cp = new CpAmm(conn);
  const derived = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption], vp.baseMint, config.quoteMint);
  try { const st = await cp.fetchPoolState(derived); if (st) return { cp, address: derived, state: st }; } catch { /* fall through */ }
  const all = await cp.fetchPoolStatesByTokenAMint(vp.baseMint);
  const match = all.filter((p) => p.account.tokenBMint.equals(config.quoteMint)).sort((a, b) => b.account.liquidity.cmp(a.account.liquidity))[0];
  need(match, 'This coin has graduated, but its DAMM v2 pool could not be found yet. Try again in a minute.');
  return { cp, address: match.publicKey, state: match.account };
}

const num = (x) => Number(x.toString());

async function poolView(conn, client, address, vp, config) {
  const now = Math.floor(Date.now() / 1000);
  const quoteMint = config.quoteMint.toBase58();
  const qDec = await quoteDecimals(conn, quoteMint);
  const bDec = config.tokenDecimal;
  const price = Number(getPriceFromSqrtPrice(vp.sqrtPrice, bDec, qDec).toString());
  const supply = num(config.postMigrationTokenSupply.gtn(0) ? config.postMigrationTokenSupply : config.preMigrationTokenSupply) / 10 ** bDec;
  const bf = config.poolFees.baseFee;
  const activation = num(vp.activationPoint);
  let feePct = num(bf.cliffFeeNumerator) / 1e7;
  try {
    const h = getBaseFeeHandler(bf.cliffFeeNumerator, bf.firstFactor, bf.secondFactor, bf.thirdFactor, bf.baseFeeMode);
    feePct = num(h.getBaseFeeNumeratorFromIncludedFeeAmount(new BN(Math.max(now, activation)), vp.activationPoint)) / 1e7;
  } catch { /* keep cliff */ }
  const out = {
    pool: address.toBase58(), mint: vp.baseMint.toBase58(), config: vp.config.toBase58(), creator: vp.creator.toBase58(),
    partner: config.feeClaimer.toBase58(), quoteMint, quoteDecimals: qDec, baseDecimals: bDec,
    tokenProgram: vp.poolType === 1 ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58(),
    migrated: vp.isMigrated === 1, curveComplete: vp.quoteReserve.gte(config.migrationQuoteThreshold),
    progress: Math.min(1, num(vp.quoteReserve) / Math.max(1, num(config.migrationQuoteThreshold))),
    quoteReserve: num(vp.quoteReserve) / 10 ** qDec, graduationQuote: num(config.migrationQuoteThreshold) / 10 ** qDec,
    priceQuote: price, supply, mcapQuote: price * supply,
    activationTs: activation, now, feePct, taxCurve: taxCurve(bf), dynamicFee: config.poolFees.dynamicFee.initialized === 1,
    fees: {
      creatorBase: vp.creatorBaseFee.toString(), creatorQuote: vp.creatorQuoteFee.toString(),
      partnerBase: vp.partnerBaseFee.toString(), partnerQuote: vp.partnerQuoteFee.toString(),
      totalTradingQuote: vp.metrics.totalTradingQuoteFee.toString(),
    },
    rules: {
      creatorFeeSharePct: config.creatorTradingFeePercentage, collectFeeMode: config.collectFeeMode === 0 ? 'quote' : 'both',
      lockedLpPct: config.creatorPermanentLockedLiquidityPercentage + config.partnerPermanentLockedLiquidityPercentage,
      creatorLpPct: config.creatorLiquidityPercentage + config.creatorPermanentLockedLiquidityPercentage,
      graduatedFeeBps: config.migratedPoolFeeBps, graduatedFeeMode: ['quote', 'both', 'compound'][config.migratedCollectFeeMode] || 'quote',
      migrationFeePct: config.migrationFeePercentage, authority: ['creator', 'immutable', 'partner', 'creator+mint', 'partner+mint'][config.tokenUpdateAuthority] || 'unknown',
      vested: !config.lockedVestingConfig.amountPerPeriod.isZero() || !config.lockedVestingConfig.cliffUnlockAmount.isZero(),
      devBuySkipsTax: config.enableFirstSwapWithMinFee === 1,
    },
  };
  try {
    const hook = await mintHook(conn, vp.baseMint);
    const policy = platformPolicy();
    const program = hook || policy.hookProgram;
    if (program && vp.poolType === 1) {
      const acc = await conn.getAccountInfo(hookConfigAddress(vp.baseMint, program), 'confirmed');
      const rules = acc ? decodeHookRules(acc.data) : null;
      if (rules) out.hooks = { program, active: Boolean(hook), ...rules };
    }
  } catch { /* rules are display-only */ }
  if (out.migrated) {
    try {
      const d = await loadDamm(conn, vp, config);
      const aIsBase = d.state.tokenAMint.equals(vp.baseMint);
      const p = Number(getPriceFromSqrtPrice(d.state.sqrtPrice, aIsBase ? bDec : qDec, aIsBase ? qDec : bDec).toString());
      out.damm = { pool: d.address.toBase58(), liquidity: d.state.liquidity.toString(), permanentLocked: d.state.permanentLockLiquidity.toString() };
      out.priceQuote = aIsBase ? p : 1 / p; out.mcapQuote = out.priceQuote * supply;
    } catch (e) { out.damm = { error: e.message }; }
  }
  return out;
}
const decCache = new Map([[SOL_MINT, 9]]);
async function quoteDecimals(conn, mint) {
  if (!decCache.has(mint)) decCache.set(mint, (await mintInfo(conn, mint)).decimals);
  return decCache.get(mint);
}

/* ─────────────────────────── handlers ─────────────────────────── */

async function actionCreate(conn, b, policy) {
  need(isAddress(b.creator) && isAddress(b.config) && isAddress(b.baseMint), 'Missing wallet, config or coin address.');
  const name = String(b.name || '').trim().slice(0, 32), symbol = String(b.symbol || '').trim().toUpperCase().slice(0, 10);
  need(name && symbol, 'Name and ticker are required.');
  need(/^https:\/\/[^\s"<>]{3,200}$/.test(b.uri || ''), 'Upload the coin image and details first (missing metadata URI).');
  const form = b.form || {};
  const qMint = isAddress(form.quote && form.quote.mint) ? form.quote.mint : SOL_MINT;
  const qi = await mintInfo(conn, qMint);
  if (qi.token2022 && qi.extensions.some((e) => !['metadataPointer', 'tokenMetadata'].includes(e)))
    throw new FormError(`That quote token is a Token-2022 mint with extensions (${qi.extensions.join(', ')}). Meteora only allows it with a token badge; pick a different pair.`);
  if (qi.freezeAuthority) throw new FormError('That quote token has a freeze authority, so its issuer could freeze the pool. Pick a different pair.');
  const norm = normalizeForm(form, qi, policy);
  const cfg = buildConfig(norm, policy);
  const devBuy = b.devBuy ? bn(b.devBuy, 'dev buy') : new BN(0);
  const txs = await buildLaunchTxs(conn, {
    cfg, norm, policy, creator: pk(b.creator), config: pk(b.config), baseMint: pk(b.baseMint), quoteMint: pk(qMint),
    name, symbol, uri: b.uri, devBuy, minOut: new BN(1), priorityMicroLamports: priority(b.priority),
  });
  return { ...txs, summary: summarize(norm, cfg, policy) };
}

/** Retry path: the config already exists on-chain, only the pool (+ dev buy) transaction is rebuilt. */
async function actionCreatePool(conn, client, b) {
  need(isAddress(b.creator) && isAddress(b.config) && isAddress(b.baseMint), 'Missing wallet, config or coin address.');
  const name = String(b.name || '').trim().slice(0, 32), symbol = String(b.symbol || '').trim().toUpperCase().slice(0, 10);
  need(name && symbol && /^https:\/\/[^\s"<>]{3,200}$/.test(b.uri || ''), 'Missing coin details.');
  const creator = pk(b.creator), config = pk(b.config), baseMint = pk(b.baseMint);
  const cfg = await client.state.getPoolConfig(config);
  need(cfg, 'That config does not exist on-chain yet.');
  const devBuy = b.devBuy ? bn(b.devBuy, 'dev buy') : new BN(0);
  const hookCfg = await client.pool.program.account.configWithTransferHook.fetchNullable(config).catch(() => null);
  const hookProgram = hookCfg && hookCfg.transferHookProgram ? hookCfg.transferHookProgram.toBase58() : null;
  const createPoolParam = { name, symbol, uri: b.uri, payer: creator, poolCreator: creator, config, baseMint };
  const firstBuyParam = devBuy.gtn(0) ? { buyer: creator, receiver: creator, buyAmount: devBuy, minimumAmountOut: new BN(1), referralTokenAccount: null, ...(hookProgram ? hookSwapAccounts(baseMint, hookProgram) : {}) } : undefined;
  const tx = hookProgram
    ? await client.creator.createPoolWithFirstBuyWithTransferHook({ createPoolParam: { ...createPoolParam, transferHookProgram: pk(hookProgram) }, firstBuyParam })
    : await client.creator.createPoolWithFirstBuy({ createPoolParam, firstBuyParam });
  return { tx: await finalize(conn, tx, creator, { priorityMicroLamports: priority(b.priority) }), pool: deriveDbcPoolAddress(cfg.quoteMint, baseMint, config).toBase58() };
}

function actionPreview(b, policy, qi) {
  const norm = normalizeForm(b.form || {}, qi, policy);
  const cfg = buildConfig(norm, policy);
  const s = summarize(norm, cfg, policy);
  if (b.devBuy && /^\d{1,20}$/.test(String(b.devBuy)) && b.devBuy !== '0') {
    const client = new DynamicBondingCurveClient(connection(), 'confirmed');
    const q = client.pool.getQuoteFromInputAmount({ config: cfg, swapBaseForQuote: false, amountIn: new BN(String(b.devBuy)), eligibleForFirstSwapWithMinFee: norm.fees.devBuySkipsTax });
    const tokens = num(q.outputAmount) / 10 ** norm.token.decimals;
    s.devBuy = { tokens, pctOfSupply: tokens / norm.token.supply * 100 };
  }
  return s;
}

async function actionSwap(conn, client, b) {
  const quoteOnly = b.quoteOnly === true;
  need(quoteOnly || isAddress(b.owner), 'Connect a wallet first.');
  const side = b.side === 'sell' ? 'sell' : 'buy';
  const amountIn = bn(b.amount);
  need(amountIn.gtn(0), 'Enter an amount above zero.');
  const slip = Math.round(Math.min(5000, Math.max(10, Number(b.slippageBps) || 500)));
  const { address, vp, config } = await loadPool(client, b);
  const owner = quoteOnly ? null : pk(b.owner);
  if (vp.isMigrated !== 1) {
    need(vp.quoteReserve.lt(config.migrationQuoteThreshold), 'The curve is full and this coin is graduating to its DAMM v2 pool. Trading resumes there in a moment.');
    const currentPoint = quoteOnly ? new BN(Math.floor(Date.now() / 1000)) : await getCurrentPoint(conn, config.activationType);
    const quote = client.pool.swapQuote({ virtualPool: vp, config, swapBaseForQuote: side === 'sell', amountIn, slippageBps: slip, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint });
    const q = { out: quote.outputAmount.toString(), minOut: quote.minimumAmountOut.toString(), fee: quote.tradingFee.toString(),
      feeInQuote: config.collectFeeMode === 0 || side === 'sell' };
    if (quoteOnly) return { venue: 'curve', quote: q };
    const hook = await mintHook(conn, vp.baseMint);
    const tx = hook
      ? await client.pool.swap2WithTransferHook({ owner, pool: address, amountIn, minimumAmountOut: quote.minimumAmountOut, swapBaseForQuote: side === 'sell', swapMode: 0, referralTokenAccount: null, payer: owner })
      : await client.pool.swap({ owner, pool: address, amountIn, minimumAmountOut: quote.minimumAmountOut, swapBaseForQuote: side === 'sell', referralTokenAccount: null, payer: owner });
    return { venue: 'curve', tx: await finalize(conn, tx, owner, { priorityMicroLamports: priority(b.priority) }), quote: q };
  }
  const d = await loadDamm(conn, vp, config);
  const st = d.state, quoteMint = config.quoteMint;
  const input = side === 'buy' ? quoteMint : vp.baseMint, output = side === 'buy' ? vp.baseMint : quoteMint;
  const qDec = await quoteDecimals(conn, quoteMint.toBase58());
  const aIsBase = st.tokenAMint.equals(vp.baseMint);
  const slot = await conn.getSlot();
  const q = d.cp.getQuote({ inAmount: amountIn, inputTokenMint: input, slippage: slip, poolState: st, currentTime: Math.floor(Date.now() / 1000), currentSlot: slot,
    tokenADecimal: aIsBase ? config.tokenDecimal : qDec, tokenBDecimal: aIsBase ? qDec : config.tokenDecimal });
  const quote = { out: q.swapOutAmount.toString(), minOut: q.minSwapOutAmount.toString(), fee: q.totalFee.toString(), feeInQuote: false };
  if (quoteOnly) return { venue: 'damm', quote };
  const tx = await d.cp.swap({ payer: owner, pool: d.address, inputTokenMint: input, outputTokenMint: output, amountIn, minimumAmountOut: q.minSwapOutAmount,
    tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
    tokenAProgram: getTokenProgram(st.tokenAFlag), tokenBProgram: getTokenProgram(st.tokenBFlag), referralTokenAccount: null, poolState: st });
  return { venue: 'damm', tx: await finalize(conn, tx, owner, { priorityMicroLamports: priority(b.priority) }), quote };
}

async function actionFees(conn, client, b) {
  need(isAddress(b.owner), 'Connect a wallet first.');
  const owner = pk(b.owner);
  const { address, vp, config } = await loadPool(client, b);
  const p = priority(b.priority);
  let tx;
  switch (b.action) {
    case 'claim':
      need(vp.creator.equals(owner), 'Only the coin’s creator wallet can claim creator fees.');
      tx = vp.creatorBaseFee.gtn(0) && await mintHook(conn, vp.baseMint)
        ? await client.creator.claimCreatorTradingFee2({ creator: owner, payer: owner, pool: address, maxBaseAmount: vp.creatorBaseFee, maxQuoteAmount: vp.creatorQuoteFee, receiver: owner })
        : await client.creator.claimCreatorTradingFee({ creator: owner, payer: owner, pool: address, maxBaseAmount: vp.creatorBaseFee, maxQuoteAmount: vp.creatorQuoteFee });
      break;
    case 'partnerClaim':
      need(config.feeClaimer.equals(owner), 'Only the platform fee wallet can claim platform fees.');
      tx = vp.partnerBaseFee.gtn(0) && await mintHook(conn, vp.baseMint)
        ? await client.partner.claimPartnerTradingFee2({ feeClaimer: owner, payer: owner, pool: address, maxBaseAmount: vp.partnerBaseFee, maxQuoteAmount: vp.partnerQuoteFee, receiver: owner })
        : await client.partner.claimPartnerTradingFee({ feeClaimer: owner, payer: owner, pool: address, maxBaseAmount: vp.partnerBaseFee, maxQuoteAmount: vp.partnerQuoteFee });
      break;
    case 'surplus':
      need(vp.isMigrated === 1, 'Surplus can be withdrawn only after graduation.');
      if (vp.creator.equals(owner)) tx = await client.creator.creatorWithdrawSurplus({ creator: owner, pool: address });
      else { need(config.feeClaimer.equals(owner), 'Only the creator or the platform can withdraw surplus.'); tx = await client.partner.partnerWithdrawSurplus({ feeClaimer: owner, pool: address }); }
      break;
    case 'migrationFee':
      need(vp.isMigrated === 1, 'The graduation fee is paid when the coin graduates.');
      if (vp.creator.equals(owner)) tx = await client.creator.creatorWithdrawMigrationFee({ pool: address, sender: owner });
      else { need(config.feeClaimer.equals(owner), 'Only the creator or the platform can withdraw the graduation fee.'); tx = await client.partner.partnerWithdrawMigrationFee({ pool: address, sender: owner }); }
      break;
    case 'transferCreator':
      need(vp.creator.equals(owner), 'Only the current creator can transfer creator rights.');
      need(isAddress(b.newCreator), 'Enter the wallet that should become the creator.');
      tx = await client.creator.transferPoolCreator({ pool: address, creator: owner, newCreator: pk(b.newCreator) });
      break;
    default: throw new FormError('Unknown fee action.');
  }
  return { tx: await finalize(conn, tx, owner, { priorityMicroLamports: p }) };
}

/** Claims trading fees earned by the wallet's DAMM v2 LP positions (locked ones included). */
async function actionClaimLp(conn, client, b) {
  need(isAddress(b.owner), 'Connect a wallet first.');
  const owner = pk(b.owner);
  const { vp, config } = await loadPool(client, b);
  need(vp.isMigrated === 1, 'LP fees start after graduation.');
  const d = await loadDamm(conn, vp, config);
  const positions = await d.cp.getUserPositionByPool(d.address, owner);
  need(positions.length, 'This wallet has no liquidity positions in the graduated pool.');
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const st = d.state, txs = [];
  for (const pos of positions.slice(0, 5)) {
    const tx = await d.cp.claimPositionFee({ owner, position: pos.position, pool: d.address, positionNftAccount: pos.positionNftAccount,
      tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
      tokenAProgram: getTokenProgram(st.tokenAFlag), tokenBProgram: getTokenProgram(st.tokenBFlag) });
    txs.push(await finalize(conn, tx, owner, { priorityMicroLamports: priority(b.priority), blockhash }));
  }
  return { txs };
}

async function actionMigrate(conn, client, b) {
  need(isAddress(b.owner), 'Connect a wallet first.');
  const owner = pk(b.owner);
  const { address, vp, config } = await loadPool(client, b);
  need(vp.isMigrated !== 1, 'Already graduated.');
  need(vp.quoteReserve.gte(config.migrationQuoteThreshold), 'The curve is not full yet.');
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const txs = [];
  const vested = !config.lockedVestingConfig.amountPerPeriod.isZero() || !config.lockedVestingConfig.cliffUnlockAmount.isZero();
  if (vested) txs.push(await finalize(conn, await client.migration.createLocker({ payer: owner, pool: address }), owner, { blockhash }));
  const m = await client.migration.migrateToDammV2({ payer: owner, pool: address, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption] });
  m.transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  txs.push(await finalize(conn, m.transaction, owner, { blockhash, signers: [m.firstPositionNftKeypair, m.secondPositionNftKeypair] }));
  return { txs };
}

async function tokenAccountFor(conn, owner, mint) {
  const mi = await mintInfo(conn, mint);
  const program = pk(mi.program);
  return { mi, program, ata: getAssociatedTokenAddressSync(pk(mint), owner, true, program) };
}

async function actionBurn(conn, b) {
  need(isAddress(b.owner) && isAddress(b.mint), 'Missing wallet or coin.');
  const owner = pk(b.owner), amount = bn(b.amount);
  need(amount.gtn(0), 'Nothing to burn.');
  const { mi, program, ata } = await tokenAccountFor(conn, owner, b.mint);
  const tx = new Transaction().add(createBurnCheckedInstruction(ata, pk(b.mint), owner, BigInt(amount.toString()), mi.decimals, [], program));
  return { tx: await finalize(conn, tx, owner, { priorityMicroLamports: priority(b.priority) }) };
}

/** Fee sharing / holder airdrops: pays out `mint` (or SOL) to up to 40 recipients, 6 per transaction. */
async function actionTransfer(conn, b) {
  need(isAddress(b.owner) && isAddress(b.mint), 'Missing wallet or token.');
  const owner = pk(b.owner);
  const list = (Array.isArray(b.recipients) ? b.recipients : []).slice(0, 40).map((r) => ({ to: r && r.to, amount: bn(r && r.amount, 'payout') }))
    .filter((r) => isAddress(r.to) && r.amount.gtn(0));
  need(list.length, 'Add at least one recipient with an amount.');
  const native = b.mint === SOL_MINT && b.native !== false;
  const info = native ? null : await tokenAccountFor(conn, owner, b.mint);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const txs = [];
  for (let i = 0; i < list.length; i += 6) {
    const tx = new Transaction();
    for (const r of list.slice(i, i + 6)) {
      const to = pk(r.to);
      if (native) { tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports: BigInt(r.amount.toString()) })); continue; }
      const dest = getAssociatedTokenAddressSync(pk(b.mint), to, true, info.program);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, dest, to, pk(b.mint), info.program));
      tx.add(createTransferCheckedInstruction(info.ata, pk(b.mint), dest, owner, BigInt(r.amount.toString()), info.mi.decimals, [], info.program));
    }
    txs.push(await finalize(conn, tx, owner, { priorityMicroLamports: priority(b.priority), blockhash }));
  }
  return { txs };
}

/** Adds liquidity to the graduated DAMM v2 pool; optionally locks it permanently (fees stay claimable). */
async function actionAddLiquidity(conn, client, b) {
  need(isAddress(b.owner), 'Connect a wallet first.');
  const owner = pk(b.owner);
  const { vp, config } = await loadPool(client, b);
  need(vp.isMigrated === 1, 'Liquidity can be added after the coin graduates to DAMM v2. Before that, the bonding curve holds all liquidity.');
  const d = await loadDamm(conn, vp, config), st = d.state;
  const aIsBase = st.tokenAMint.equals(vp.baseMint);
  const base = bn(b.baseAmount, 'coin amount'), quote = bn(b.quoteAmount, 'pair amount');
  need(base.gtn(0) && quote.gtn(0), 'Enter both amounts.');
  const maxA = aIsBase ? base : quote, maxB = aIsBase ? quote : base;
  const slip = Math.round(Math.min(3000, Math.max(10, Number(b.slippageBps) || 300)));
  const shrink = (x) => x.muln(10_000 - slip).divn(10_000);
  const liquidityDelta = d.cp.getLiquidityDelta({ maxAmountTokenA: shrink(maxA), maxAmountTokenB: shrink(maxB), sqrtPrice: st.sqrtPrice, sqrtMinPrice: st.sqrtMinPrice, sqrtMaxPrice: st.sqrtMaxPrice });
  need(liquidityDelta.gtn(0), 'Those amounts are too small to add liquidity.');
  const nft = Keypair.generate();
  const tx = await d.cp.createPositionAndAddLiquidity({ owner, pool: d.address, positionNft: nft.publicKey, liquidityDelta,
    maxAmountTokenA: maxA, maxAmountTokenB: maxB, tokenAAmountThreshold: maxA, tokenBAmountThreshold: maxB,
    tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAProgram: getTokenProgram(st.tokenAFlag), tokenBProgram: getTokenProgram(st.tokenBFlag) });
  if (b.lock) {
    const lock = await d.cp.permanentLockPosition({ owner, position: derivePositionAddress(nft.publicKey), positionNftAccount: derivePositionNftAccount(nft.publicKey), pool: d.address, unlockedLiquidity: liquidityDelta });
    tx.add(...lock.instructions);
  }
  return { tx: await finalize(conn, tx, owner, { priorityMicroLamports: priority(b.priority), signers: [nft] }), position: derivePositionAddress(nft.publicKey).toBase58() };
}

/** Top holders that are real wallets (pool vaults, lockers and other program accounts excluded). */
async function actionHolders(conn, b) {
  need(isAddress(b.mint), 'Missing coin.');
  const largest = await conn.getTokenLargestAccounts(pk(b.mint), 'confirmed');
  const accts = largest.value.slice(0, 20);
  const infos = await conn.getMultipleParsedAccounts(accts.map((a) => a.address), { commitment: 'confirmed' });
  const exclude = new Set((Array.isArray(b.exclude) ? b.exclude : []).filter(isAddress));
  const out = [];
  infos.value.forEach((v, i) => {
    const owner = v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.owner;
    if (!owner || exclude.has(owner) || !PublicKey.isOnCurve(pk(owner).toBytes())) return;
    out.push({ owner, amount: accts[i].amount });
  });
  return { holders: out };
}

export default async function handler(req, res) {
  const policy = platformPolicy();
  try {
    if (req.method === 'GET') {
      const action = String(req.query.action || 'setup');
      if (action === 'setup') {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        return res.status(200).json({ presets: PRESETS, defaults: DEFAULT_FORM, policy: { platformFeeSharePct: policy.platformFeeSharePct, maxCreatorFeeSharePct: policy.maxCreatorFeeSharePct, poolCreationFeeSol: policy.poolCreationFeeSol, partnerWallet: policy.partnerWallet, hookProgram: policy.hookProgram, maxHookAllowlist: MAX_HOOK_ALLOWLIST }, program: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58() });
      }
      if (action === 'quote') {
        const mint = String(req.query.mint || '');
        if (!isAddress(mint)) return json(res, 400, { error: 'Enter a valid token mint address.' });
        const [mi, mk] = await Promise.all([mintInfo(connection(), mint), marketInfo(mint)]);
        const problems = [];
        if (mi.token2022 && mi.extensions.some((e) => !['metadataPointer', 'tokenMetadata'].includes(e))) problems.push(`Token-2022 extensions (${mi.extensions.join(', ')}) need a Meteora token badge`);
        if (mi.freezeAuthority) problems.push('has a freeze authority');
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return res.status(200).json({ ...mi, ...mk, usable: problems.length === 0, problems });
      }
      return json(res, 400, { error: 'Unknown action.' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    const b = await readJson(req);
    if (!b || typeof b.action !== 'string') return json(res, 400, { error: 'Invalid request.' });
    const conn = connection();
    const client = new DynamicBondingCurveClient(conn, 'confirmed');
    let out;
    switch (b.action) {
      case 'preview': {
        const qMint = isAddress(b.form && b.form.quote && b.form.quote.mint) ? b.form.quote.mint : SOL_MINT;
        const qi = { mint: qMint, decimals: Number.isInteger(b.quoteDecimals) && b.quoteDecimals >= 0 && b.quoteDecimals <= 12 ? b.quoteDecimals : await quoteDecimals(conn, qMint) };
        out = { summary: actionPreview(b, policy, qi) }; break;
      }
      case 'create': out = await actionCreate(conn, b, policy); break;
      case 'createPool': out = await actionCreatePool(conn, client, b); break;
      case 'pool': { const { address, vp, config } = await loadPool(client, b); out = await poolView(conn, client, address, vp, config); break; }
      case 'swap': out = await actionSwap(conn, client, b); break;
      case 'claim': case 'partnerClaim': case 'surplus': case 'migrationFee': case 'transferCreator': out = await actionFees(conn, client, b); break;
      case 'claimLp': out = await actionClaimLp(conn, client, b); break;
      case 'migrate': out = await actionMigrate(conn, client, b); break;
      case 'burn': out = await actionBurn(conn, b); break;
      case 'transfer': out = await actionTransfer(conn, b); break;
      case 'addLiquidity': out = await actionAddLiquidity(conn, client, b); break;
      case 'holders': out = await actionHolders(conn, b); break;
      default: return json(res, 400, { error: 'Unknown action.' });
    }
    return json(res, 200, out);
  } catch (e) {
    if (e instanceof FormError || e.status === 400) return json(res, 400, { error: e.message });
    console.error('forge', req.body && req.body.action, e);
    const msg = String((e && e.message) || e);
    return json(res, 502, { error: /429|rate/i.test(msg) ? 'The Solana RPC is rate-limiting. Try again in a moment (the site owner should set RPC_URL to a paid provider).' : `Could not build that transaction: ${msg.slice(0, 200)}` });
  }
}
