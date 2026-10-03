# sine-hooks

The Token-2022 transfer hook behind SINE Forge's **on-chain rules**. When a coin is launched with rules, its mint names this program, and Solana runs the program on every transfer of the coin: buys and sells on the Meteora bonding curve, and wallet-to-wallet sends. A transfer that breaks a rule fails.

## Rules

| Rule | Enforced on | Ends |
|---|---|---|
| Holder cap: no wallet may hold more than X% of supply | every incoming transfer to an ordinary wallet | at the end of the launch phase |
| Transaction cap: no transfer above X% | buys, sells, sends | at the end of the launch phase |
| Anti-bundle: at most N buys from the pool per block | buys | at the end of the launch phase |
| No wallet-to-wallet sends | sends between two ordinary wallets | at the end of the launch phase |
| Allowlist phase: only listed wallets can buy, up to 20 | buys | at its own deadline, inside the launch phase |
| Creator lock: the creator wallet can't sell or send | outflows from the creator | at its own deadline (up to 2 years) |
| Creator daily limit: the creator may move at most X% of supply per rolling day | outflows from the creator | never, until graduation |

The bonding-curve vault authority and the DAMM v2 pool authority are exempt, so the pool itself is never capped.

## Protections for buyers

These are built into the program, not left to policy:

- **Rules are set once, before the coin exists.** Configure must be signed by the coin's mint keypair and can never run again. Nobody can add or change rules later.
- **Launch-phase rules can last at most 30 days.** Meteora's bonding curve also revokes the hook at graduation. A hook can't become a permanent honeypot.
- **No blacklist, no pause, no sell ban.** Selling back to the curve is always allowed, subject only to the transaction cap.
- **The hook only acts during real transfers.** `Execute` requires Token-2022's "transferring" flag, so outsiders can't call it directly to manipulate the counters.

## Build, test, deploy

```bash
cargo test                       # rule unit tests + end-to-end test with the real Token-2022 program
cargo build-sbf                  # needs the Solana CLI (https://release.anza.xyz) → target/deploy/sine_hooks.so
solana-keygen new -o target/deploy/sine_hooks-keypair.json   # (cargo build-sbf creates one if missing)
solana address -k target/deploy/sine_hooks-keypair.json      # your program id
```

1. Put your program id in `declare_id!` in `src/lib.rs`, rebuild, and run `solana program deploy target/deploy/sine_hooks.so --program-id target/deploy/sine_hooks-keypair.json`. Deployment costs roughly 1.5–2.5 SOL of rent, refundable if you close the program.
2. Set `FORGE_HOOK_PROGRAM=<program id>` in Vercel and redeploy. The "On-chain rules" section and the Hooked presets then switch on in `/forge`.
3. Consider making the program immutable (`solana program set-upgrade-authority --final`) after a test launch, so holders know the rules code can't change. Or keep the upgrade authority in a multisig.

Get an independent audit before marketing it widely. Compute cost is about 12k CU per transfer.

The `sine-hooks` GitHub Action builds the `.so` and runs the tests on every change here.
