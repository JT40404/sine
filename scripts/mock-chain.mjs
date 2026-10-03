/**
 * Dev-only: stubs the Solana reads the Forge API makes, so the full launch flow can be exercised
 * in a browser without network access (node scripts/dev.mjs --mock-chain). Never used in production.
 */
import { Connection, PublicKey } from '@solana/web3.js';
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MINTS = { So11111111111111111111111111111111111111112: 9, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6 };
export const isMockMint = (m) => m in MINTS;
const P = Connection.prototype;
P.getAccountInfo = async function (pk) { const d = MINTS[pk.toBase58()]; return d === undefined ? null : { owner: TOKEN, data: Buffer.alloc(82), lamports: 1, executable: false }; };
P.getParsedAccountInfo = async function (pk) {
  const d = MINTS[pk.toBase58()];
  return { value: d === undefined ? null : { owner: TOKEN, lamports: 1, executable: false, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: d, freezeAuthority: null, mintAuthority: null, extensions: [] } } } } };
};
P.getLatestBlockhash = async function () { return { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1 }; };
console.log('mock chain: Solana reads are stubbed');
