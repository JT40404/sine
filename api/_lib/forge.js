/**
 * SINE Forge — turns a launch form into Meteora Dynamic Bonding Curve (DBC) config parameters.
 *
 * Every launch gets its OWN DBC config, so each coin can choose its own quote asset, curve, fee
 * scheme, anti-sniper tax, graduation pool and liquidity locks. Pure functions only (no network),
 * so the whole translation is unit-testable offline: see scripts/forge-selftest.mjs.
 *
 * Fee flow on every trade (enforced on-chain by the DBC program):
 *   trading fee ─┬─ 20%  Meteora protocol (a referral account, if passed, takes 20% of that)
 *                └─ 80%  split creator / platform by creatorTradingFeePercentage
 */
import BN from 'bn.js';
import {
  buildCurveWithMarketCap, buildCurveWithTwoSegments, validateConfigParameters,
  BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption, MigratedCollectFeeMode,
  DammV2DynamicFeeMode, TokenType, TokenAuthorityOption, ActivationType, getBaseFeeHandler,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Platform policy, set by the site owner in Vercel env vars. */
export function platformPolicy(env = process.env) {
  const wallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.FORGE_PARTNER_WALLET || '') ? env.FORGE_PARTNER_WALLET : null;
  const share = wallet ? clampNum(env.FORGE_PLATFORM_FEE_SHARE, 0, 100, 20) : 0;     // % of the LP-side trading fee kept by the platform
  const creation = wallet ? clampNum(env.FORGE_POOL_CREATION_FEE_SOL, 0, 100, 0) : 0;
  return {
    partnerWallet: wallet,
    platformFeeSharePct: share,
    maxCreatorFeeSharePct: 100 - share,
    poolCreationFeeSol: creation > 0 && creation < 0.001 ? 0.001 : creation,          // DBC minimum is 0.001 SOL when set
  };
}

/** Starting points modelled on other launchpads. The UI loads one, the user edits anything. */
export const PRESETS = {
  pump: {
    label: 'Classic (pump.fun style)',
    blurb: 'SOL pair, ~$5k start, graduates near $70k, 1% fee, no launch tax, LP locked forever.',
    form: { curve: { initialMcap: 30, gradMcap: 400, shape: 'standard' }, fees: { tradeBps: 100, snipe: { enabled: false }, dynamic: false, collectIn: 'quote', creatorSharePct: 50 },
      grad: { feeBps: 25, feeMode: 'quote', dynamic: false, lp: { creatorLockedPct: 100, creatorPct: 0, partnerLockedPct: 0, partnerPct: 0 }, migrationFeePct: 0, migrationFeeCreatorPct: 0 } },
  },
  sniperShield: {
    label: 'Sniper shield',
    blurb: '99% tax at second zero, decaying exponentially to 1% over 60 seconds. Volatility fee on. Your dev buy skips the tax.',
    form: { fees: { tradeBps: 100, snipe: { enabled: true, startBps: 9900, durationSec: 60, mode: 'exponential', periods: 60 }, dynamic: true, collectIn: 'quote', creatorSharePct: 50 } },
  },
  stonkPair: {
    label: 'Meme-pair (pair with another token)',
    blurb: 'Paired with a token you choose (STONK, OTC, BONK… any SPL mint). Anti-snipe on, 2% fee, compounding LP after graduation.',
    form: { quoteMode: 'custom', fees: { tradeBps: 200, snipe: { enabled: true, startBps: 5000, durationSec: 120, mode: 'linear', periods: 24 }, dynamic: true, collectIn: 'quote', creatorSharePct: 50 },
      grad: { feeBps: 100, feeMode: 'compound', compoundPct: 50, dynamic: true, lp: { creatorLockedPct: 100, creatorPct: 0, partnerLockedPct: 0, partnerPct: 0 } } },
  },
  stable: {
    label: 'Stable-pair (USDC)',
    blurb: 'USDC pair so the curve is priced in dollars. $5k start, $69k graduation.',
    form: { quote: { mint: USDC_MINT }, curve: { initialMcap: 5000, gradMcap: 69000, shape: 'standard' } },
  },
  creatorRevenue: {
    label: 'Creator revenue',
    blurb: '2% fee with the maximum creator share, plus 1% of the graduation liquidity paid to the creator. Fees can fund buyback & burn.',
    form: { fees: { tradeBps: 200, snipe: { enabled: true, startBps: 2500, durationSec: 30, mode: 'linear', periods: 10 }, dynamic: false, collectIn: 'quote', creatorSharePct: 100 },
      grad: { feeBps: 200, feeMode: 'quote', migrationFeePct: 1, migrationFeeCreatorPct: 100 } },
  },
  fairLocked: {
    label: 'Fair & vested',
    blurb: '10% team allocation locked: 30-day cliff, then linear unlock over 6 months. LP 100% permanently locked.',
    form: { vesting: { enabled: true, pct: 10, cliffDays: 30, durationDays: 180, periods: 180, cliffUnlockPct: 0 } },
  },
};

export const DEFAULT_FORM = {
  token: { decimals: 6, tokenType: 'spl', supply: 1_000_000_000, authority: 'immutable' },
  quote: { mint: SOL_MINT },
  curve: { initialMcap: 30, gradMcap: 400, shape: 'standard', supplyOnMigrationPct: 20 },
  fees: { tradeBps: 100, snipe: { enabled: true, startBps: 9900, durationSec: 60, mode: 'exponential', periods: 60 }, dynamic: true, collectIn: 'quote', creatorSharePct: 50, devBuySkipsTax: true },
  grad: { feeBps: 100, feeMode: 'quote', compoundPct: 50, dynamic: true, lp: { creatorLockedPct: 100, creatorPct: 0, partnerLockedPct: 0, partnerPct: 0 }, migrationFeePct: 0, migrationFeeCreatorPct: 0 },
  vesting: { enabled: false, pct: 10, cliffDays: 30, durationDays: 180, periods: 180, cliffUnlockPct: 0 },
};

class FormError extends Error { constructor(msg) { super(msg); this.status = 400; } }
function clampNum(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function int(v, lo, hi, dflt) { return Math.round(clampNum(v, lo, hi, dflt)); }
function pick(v, allowed, dflt) { return allowed.includes(v) ? v : dflt; }
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  return out;
}

/**
 * Normalise and bound every user input. Anything out of range is clamped to what the
 * DBC program accepts; impossible combinations throw a FormError with a plain-English reason.
 */
export function normalizeForm(input, quoteInfo, policy) {
  const f = deepMerge(DEFAULT_FORM, input || {});
  const t = f.token, c = f.curve, fe = f.fees, g = f.grad, v = f.vesting;
  const token = {
    decimals: pick(Number(t.decimals), [6, 7, 8, 9], 6),
    tokenType: pick(t.tokenType, ['spl', 'token2022'], 'spl'),
    supply: int(t.supply, 1_000_000, 1_000_000_000_000, 1_000_000_000),
    authority: pick(t.authority, ['immutable', 'creator', 'creatorMint'], 'immutable'),
  };
  if (token.decimals === 9 && token.supply > 10_000_000_000) throw new FormError('With 9 decimals the supply must be 10 billion or less (the on-chain amount would overflow).');

  const curve = {
    initialMcap: clampNum(c.initialMcap, 1e-6, 1e15, 30),
    gradMcap: clampNum(c.gradMcap, 1e-6, 1e15, 400),
    shape: pick(c.shape, ['standard', 'twoSegment'], 'standard'),
    supplyOnMigrationPct: clampNum(c.supplyOnMigrationPct, 5, 50, 20),
  };
  if (!(curve.gradMcap >= curve.initialMcap * 1.5)) throw new FormError('The graduation market cap must be at least 1.5× the starting market cap.');

  const tradeBps = int(fe.tradeBps, 25, 1000, 100);
  const snipeOn = Boolean(fe.snipe && fe.snipe.enabled);
  const snipe = {
    enabled: snipeOn,
    startBps: snipeOn ? int(fe.snipe.startBps, tradeBps, 9900, 9900) : tradeBps,
    durationSec: snipeOn ? int(fe.snipe.durationSec, 5, 86_400, 60) : 0,
    mode: pick(fe.snipe && fe.snipe.mode, ['linear', 'exponential'], 'exponential'),
    periods: 0,
  };
  if (snipeOn) {
    snipe.periods = int(fe.snipe.periods, 1, Math.min(10_000, snipe.durationSec), Math.min(60, snipe.durationSec));
    snipe.durationSec = Math.max(snipe.periods, Math.round(snipe.durationSec / snipe.periods) * snipe.periods);   // whole seconds per period
    if (snipe.startBps === tradeBps) snipe.enabled = false;
  }
  const fees = {
    tradeBps, snipe,
    dynamic: Boolean(fe.dynamic),
    collectIn: pick(fe.collectIn, ['quote', 'both'], 'quote'),
    creatorSharePct: int(fe.creatorSharePct, 0, policy.maxCreatorFeeSharePct, Math.min(50, policy.maxCreatorFeeSharePct)),
    devBuySkipsTax: fe.devBuySkipsTax !== false,
  };

  const lp = {
    creatorLockedPct: int(g.lp && g.lp.creatorLockedPct, 0, 100, 100),
    creatorPct: int(g.lp && g.lp.creatorPct, 0, 100, 0),
    partnerLockedPct: int(g.lp && g.lp.partnerLockedPct, 0, 100, 0),
    partnerPct: int(g.lp && g.lp.partnerPct, 0, 100, 0),
  };
  if (!policy.partnerWallet) { lp.creatorLockedPct += lp.partnerLockedPct; lp.creatorPct += lp.partnerPct; lp.partnerLockedPct = 0; lp.partnerPct = 0; }
  if (lp.creatorLockedPct + lp.creatorPct + lp.partnerLockedPct + lp.partnerPct !== 100) throw new FormError('Graduation liquidity shares must add up to exactly 100%.');
  if (lp.creatorLockedPct + lp.partnerLockedPct < 10) throw new FormError('At least 10% of the graduation liquidity must be permanently locked (a Meteora rule).');
  const grad = {
    feeBps: int(g.feeBps, 10, 1000, 100),
    feeMode: pick(g.feeMode, ['quote', 'both', 'compound'], 'quote'),
    compoundPct: int(g.compoundPct, 1, 100, 50),
    dynamic: Boolean(g.dynamic),
    lp,
    migrationFeePct: int(g.migrationFeePct, 0, 50, 0),
    migrationFeeCreatorPct: int(g.migrationFeeCreatorPct, 0, 100, 0),
  };
  if (!policy.partnerWallet) grad.migrationFeeCreatorPct = 100;      // nobody else to pay
  if (grad.migrationFeePct === 0) grad.migrationFeeCreatorPct = 0;    // program rule: no fee, no split

  const vesting = {
    enabled: Boolean(v.enabled),
    pct: clampNum(v.pct, 0.1, 50, 10),
    cliffDays: clampNum(v.cliffDays, 0, 730, 30),
    durationDays: clampNum(v.durationDays, 0, 730, 180),
    periods: int(v.periods, 1, 3650, 180),
    cliffUnlockPct: clampNum(v.cliffUnlockPct, 0, 100, 0),
  };
  if (vesting.enabled && vesting.cliffDays + vesting.durationDays > 730) throw new FormError('Vesting (cliff + duration) can be at most 2 years.');

  return { token, curve, fees, grad, vesting, quote: { mint: quoteInfo.mint, decimals: quoteInfo.decimals } };
}

/** Normalised form → DBC ConfigParameters (validated by the SDK exactly as the program will). */
export function buildConfig(norm, policy) {
  const { token, curve, fees, grad, vesting, quote } = norm;
  const baseFeeParams = fees.snipe.enabled
    ? { baseFeeMode: fees.snipe.mode === 'linear' ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: { startingFeeBps: fees.snipe.startBps, endingFeeBps: fees.tradeBps, numberOfPeriod: fees.snipe.periods, totalDuration: fees.snipe.durationSec } }
    : { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: fees.tradeBps, endingFeeBps: fees.tradeBps, numberOfPeriod: 0, totalDuration: 0 } };

  const vestAmount = vesting.enabled ? token.supply * vesting.pct / 100 : 0;
  const lockedVesting = vesting.enabled
    ? { totalLockedVestingAmount: vestAmount, numberOfVestingPeriod: vesting.durationDays > 0 ? vesting.periods : 1,
        cliffUnlockAmount: vestAmount * vesting.cliffUnlockPct / 100, totalVestingDuration: Math.max(1, Math.round(vesting.durationDays * 86400)),
        cliffDurationFromMigrationTime: Math.round(vesting.cliffDays * 86400) }
    : { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 };
  if (vesting.enabled && vesting.cliffUnlockPct >= 100) { lockedVesting.numberOfVestingPeriod = 0; lockedVesting.totalVestingDuration = 0; }

  const params = {
    token: {
      tokenType: token.tokenType === 'token2022' ? TokenType.Token2022 : TokenType.SPLToken,
      tokenBaseDecimal: token.decimals, tokenQuoteDecimal: quote.decimals,
      tokenAuthorityOption: { immutable: TokenAuthorityOption.Immutable, creator: TokenAuthorityOption.CreatorUpdateAuthority, creatorMint: TokenAuthorityOption.CreatorUpdateAndMintAuthority }[token.authority],
      totalTokenSupply: token.supply, leftover: 0,
    },
    fee: {
      baseFeeParams, dynamicFeeEnabled: fees.dynamic,
      collectFeeMode: fees.collectIn === 'both' ? CollectFeeMode.OutputToken : CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: fees.creatorSharePct,
      poolCreationFee: policy.poolCreationFeeSol,
      enableFirstSwapWithMinFee: fees.devBuySkipsTax,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: grad.migrationFeePct, creatorFeePercentage: grad.migrationFeeCreatorPct },
      migratedPoolFee: {
        collectFeeMode: { quote: MigratedCollectFeeMode.QuoteToken, both: MigratedCollectFeeMode.OutputToken, compound: MigratedCollectFeeMode.Compounding }[grad.feeMode],
        dynamicFee: grad.dynamic ? DammV2DynamicFeeMode.Enabled : DammV2DynamicFeeMode.Disabled,
        poolFeeBps: grad.feeBps,
        ...(grad.feeMode === 'compound' ? { compoundingFeeBps: grad.compoundPct * 100 } : {}),
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: grad.lp.partnerLockedPct, partnerLiquidityPercentage: grad.lp.partnerPct,
      creatorPermanentLockedLiquidityPercentage: grad.lp.creatorLockedPct, creatorLiquidityPercentage: grad.lp.creatorPct,
    },
    lockedVesting,
    activationType: ActivationType.Timestamp,
    initialMarketCap: curve.initialMcap,
    migrationMarketCap: curve.gradMcap,
  };
  let config;
  try {
    config = curve.shape === 'twoSegment'
      ? buildCurveWithTwoSegments({ ...params, percentageSupplyOnMigration: curve.supplyOnMigrationPct })
      : buildCurveWithMarketCap(params);
    validateConfigParameters({ ...config, leftoverReceiver: SOL_MINT });
  } catch (e) {
    throw new FormError(`These settings can't make a valid curve: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  return config;
}

/** Human summary of what a config will do, shown before the user signs anything. */
export function summarize(norm, config, policy, quoteSymbol = 'quote') {
  const q = 10 ** norm.quote.decimals;
  const threshold = Number(config.migrationQuoteThreshold.toString()) / q;
  const pf = 20, lpSide = 100 - pf;
  // Self-hosted (no platform wallet): the creator is also the fee claimer, so both shares go to the creator.
  const creatorOfFee = policy.partnerWallet ? lpSide * norm.fees.creatorSharePct / 100 : lpSide, platformOfFee = lpSide - creatorOfFee;
  return {
    quoteSymbol,
    startMcap: norm.curve.initialMcap, gradMcap: norm.curve.gradMcap,
    graduatesAtQuoteRaised: threshold,
    supply: norm.token.supply,
    vestedPct: norm.vesting.enabled ? norm.vesting.pct : 0,
    tradeFeePct: norm.fees.tradeBps / 100,
    snipe: norm.fees.snipe.enabled ? { startPct: norm.fees.snipe.startBps / 100, endPct: norm.fees.tradeBps / 100, seconds: norm.fees.snipe.durationSec, mode: norm.fees.snipe.mode, curve: taxCurve(config.poolFees.baseFee) } : null,
    feeSplitPct: { creator: round2(creatorOfFee), platform: round2(platformOfFee), meteora: pf },
    graduation: { pool: 'Meteora DAMM v2', feePct: norm.grad.feeBps / 100, feeMode: norm.grad.feeMode, lockedLpPct: norm.grad.lp.creatorLockedPct + norm.grad.lp.partnerLockedPct, ...norm.grad.lp },
    authority: norm.token.authority,
    poolCreationFeeSol: policy.poolCreationFeeSol,
  };
}
const round2 = (x) => Math.round(x * 100) / 100;

/** Sampled anti-sniper tax: [[secondsSinceLaunch, feePct], ...] — what a buyer pays at each moment. */
export function taxCurve(baseFee) {
  const h = getBaseFeeHandler(new BN(baseFee.cliffFeeNumerator.toString()), Number(baseFee.firstFactor), new BN(baseFee.secondFactor.toString()), new BN(baseFee.thirdFactor.toString()), Number(baseFee.baseFeeMode));
  const periods = Number(baseFee.firstFactor), freq = Number(baseFee.secondFactor.toString());
  const total = periods * freq;
  if (!total) return [[0, Number(baseFee.cliffFeeNumerator.toString()) / 1e7]];
  const out = [], steps = Math.min(120, periods);
  for (let i = 0; i <= steps; i++) {
    const t = Math.round(total * i / steps);
    const num = h.getBaseFeeNumeratorFromIncludedFeeAmount(new BN(1_000_000 + t), new BN(1_000_000));
    out.push([t, Number(num.toString()) / 1e7]);
  }
  return out;
}
export { FormError };
