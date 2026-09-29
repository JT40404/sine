/**
 * Top-N market basket (Ecosystem Pulse → "Top 50").
 * Membership is recomputed live from CoinGecko's Solana-ecosystem ranking by market cap.
 * Coins in excludeCategories are skipped so the index tracks tradable Solana assets rather
 * than dollar pegs or SOL derivatives. Unknown category ids are ignored.
 */
export const TOP = {
  size: 50,
  candidates: 150,               // how many ranked coins to scan to find `size` eligible ones
  category: 'solana-ecosystem',
  excludeCategories: ['stablecoins', 'liquid-staking-tokens', 'wrapped-tokens', 'bridged-tokens', 'tokenized-gold'],
  alwaysExclude: [],             // CoinGecko ids to skip by hand, e.g. ['some-coin-id']
  capLimit: 0.2,                 // max weight of any one token in the market-cap index
};

/**
 * "Core" on-chain basket (Ecosystem Pulse → "Core 6").
 * Liquid, established Solana tokens. Edit freely — verify every mint before deploying.
 * Keep it to ~8 tokens: each one costs an upstream API call when the cache is cold.
 */
export default [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY' },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO' },
];
