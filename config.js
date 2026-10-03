/*
 * SINE site configuration — edit this file, commit, and Vercel redeploys.
 *
 * tokenAddress: the official SINE mint address on Solana. Until you paste a real
 * address here, the site shows "Address announced at launch" instead of a placeholder.
 */
window.SINE_CONFIG = {
  tokenAddress: "",
  tokenSymbol: "$SINE",

  // SINE Forge: one-click pair suggestions shown under "Any token" on /forge.
  // Add the tokens your community pairs with, using their exact mint addresses, e.g.
  //   { symbol: "STONK", mint: "<STONK mint address>" },
  forgePairs: [],

  links: {
    docs: "",      // e.g. "https://docs.example.com" — leave "" to hide
    x: "https://x.com/SineWaveSOL",
    github: "https://github.com/JT40404/sinebot",   // SINE-BOT source code
    telegram: "",  // e.g. "https://t.me/yourgroup"
    terms: ""
  }
};
