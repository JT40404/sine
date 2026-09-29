/**
 * Top-N market basket (Ecosystem Pulse → "Top 20").
 * Membership is recomputed live from CoinGecko's Solana-ecosystem ranking by market cap,
 * using ONE API call. Non-market tokens are filtered from that same response:
 *  - stablecoins: USD/EUR/GBP in the symbol, or pinned near $1 all week
 *  - SOL derivatives (liquid-staking tokens etc.): hourly returns track SOL almost exactly
 *  - wrapped/bridged BTC & ETH and tokenized gold: by symbol
 */
export const TOP = {
  size: 20,
  candidates: 60,                // ranked coins scanned to find `size` eligible ones
  category: 'solana-ecosystem',
  capLimit: 0.2,                 // max weight of any one token in the market-cap index
  solTrackingCorr: 0.95,         // hourly-return correlation with SOL above which a coin counts as a SOL derivative
  alwaysExclude: [],             // CoinGecko ids to skip by hand, e.g. ['some-coin-id']
  alwaysInclude: [],             // CoinGecko ids to keep even if a filter would drop them
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
