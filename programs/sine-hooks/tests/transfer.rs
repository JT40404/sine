//! End-to-end: real Token-2022 (the BPF build bundled with solana-program-test) calls sine-hooks
//! during transfer_checked. Run: cargo test --test transfer
use sine_hooks::{config_address, extra_metas_address, process_instruction, CONFIGURE_TAG};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    instruction::{AccountMeta, Instruction}, pubkey::Pubkey, signature::Keypair, signer::Signer,
    system_instruction, system_program, transaction::Transaction,
};
use spl_token_2022::{extension::ExtensionType, instruction as ti, state::{Account, Mint}};

const DEC: u8 = 6;
const SUPPLY: u64 = 1_000_000 * 1_000_000; // 1M tokens
const PCT: u64 = SUPPLY / 100;

fn configure_ix(payer: &Pubkey, mint: &Pubkey, pool_owner: &Pubkey) -> Instruction {
    let mut d = CONFIGURE_TAG.to_vec();
    d.extend_from_slice(&SUPPLY.to_le_bytes());
    d.extend_from_slice(&3600u32.to_le_bytes()); // launch phase
    d.extend_from_slice(&100u16.to_le_bytes());  // holder cap 1%
    d.extend_from_slice(&0u16.to_le_bytes());    // tx cap off
    d.push(0);                                   // anti-bundle off
    d.push(1);                                   // no wallet-to-wallet
    d.extend_from_slice(&0u32.to_le_bytes());    // allowlist off
    d.extend_from_slice(&0u32.to_le_bytes());    // creator lock off
    d.extend_from_slice(&0u16.to_le_bytes());    // creator daily off
    d.push(1); d.extend_from_slice(pool_owner.as_ref());
    d.push(0);
    Instruction { program_id: sine_hooks::id(), data: d, accounts: vec![
        AccountMeta::new(*payer, true), AccountMeta::new_readonly(*mint, true),
        AccountMeta::new(extra_metas_address(mint, &sine_hooks::id()).0, false), AccountMeta::new(config_address(mint, &sine_hooks::id()).0, false),
        AccountMeta::new_readonly(system_program::id(), false)] }
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&ctx.payer]; all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&ctx.payer.pubkey()), &all, bh);
    ctx.banks_client.process_transaction(tx).await.map_err(|e| format!("{e:?}"))
}

fn transfer_ix(src: &Pubkey, mint: &Pubkey, dst: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
    let mut ix = ti::transfer_checked(&spl_token_2022::id(), src, mint, dst, owner, &[], amount, DEC).unwrap();
    ix.accounts.push(AccountMeta::new(config_address(mint, &sine_hooks::id()).0, false));
    ix.accounts.push(AccountMeta::new_readonly(sine_hooks::id(), false));
    ix.accounts.push(AccountMeta::new_readonly(extra_metas_address(mint, &sine_hooks::id()).0, false));
    ix
}

#[tokio::test]
async fn rules_are_enforced_inside_real_transfers() {
    let mut pt = ProgramTest::new("sine_hooks", sine_hooks::id(), processor!(process_instruction));
    pt.prefer_bpf(false);
    let mut ctx = pt.start_with_context().await;
    let payer = ctx.payer.pubkey();
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let mint = Keypair::new();
    let (pool_owner, alice, bob) = (Keypair::new(), Keypair::new(), Keypair::new());

    // 1. rules first (mint key signs), then the mint with the transfer-hook extension
    send(&mut ctx, &[configure_ix(&payer, &mint.pubkey(), &pool_owner.pubkey())], &[&mint]).await.expect("configure");
    let mlen = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    send(&mut ctx, &[
        system_instruction::create_account(&payer, &mint.pubkey(), rent.minimum_balance(mlen), mlen as u64, &spl_token_2022::id()),
        spl_token_2022::extension::transfer_hook::instruction::initialize(&spl_token_2022::id(), &mint.pubkey(), None, Some(sine_hooks::id())).unwrap(),
        ti::initialize_mint2(&spl_token_2022::id(), &mint.pubkey(), &payer, None, DEC).unwrap(),
    ], &[&mint]).await.expect("mint");

    // 2. token accounts
    let alen = ExtensionType::try_calculate_account_len::<Account>(&[ExtensionType::TransferHookAccount]).unwrap();
    let mut accts = vec![];
    for owner in [&pool_owner, &alice, &bob] {
        let a = Keypair::new();
        send(&mut ctx, &[
            system_instruction::create_account(&payer, &a.pubkey(), rent.minimum_balance(alen), alen as u64, &spl_token_2022::id()),
            ti::initialize_account3(&spl_token_2022::id(), &a.pubkey(), &mint.pubkey(), &owner.pubkey()).unwrap(),
        ], &[&a]).await.expect("account");
        accts.push(a.pubkey());
    }
    let (pool, al, bo) = (accts[0], accts[1], accts[2]);
    send(&mut ctx, &[ti::mint_to(&spl_token_2022::id(), &mint.pubkey(), &pool, &payer, &[], SUPPLY).unwrap()], &[]).await.expect("mint_to");

    // 3. rules
    send(&mut ctx, &[transfer_ix(&pool, &mint.pubkey(), &al, &pool_owner.pubkey(), PCT / 2)], &[&pool_owner]).await.expect("buy 0.5% is fine");
    let e = send(&mut ctx, &[transfer_ix(&pool, &mint.pubkey(), &al, &pool_owner.pubkey(), PCT * 6 / 10)], &[&pool_owner]).await.unwrap_err();
    assert!(e.contains("Custom(6001)"), "holder cap: {e}");
    let e = send(&mut ctx, &[transfer_ix(&al, &mint.pubkey(), &bo, &alice.pubkey(), 1)], &[&alice]).await.unwrap_err();
    assert!(e.contains("Custom(6004)"), "no wallet-to-wallet: {e}");
    send(&mut ctx, &[transfer_ix(&al, &mint.pubkey(), &pool, &alice.pubkey(), PCT / 4)], &[&alice]).await.expect("selling back to the pool is fine");

    // 4. direct Execute by an outsider (to mess with counters) is refused
    let mut d = spl_transfer_hook_interface::instruction::TransferHookInstruction::Execute { amount: 1 }.pack();
    d.truncate(16);
    let direct = Instruction { program_id: sine_hooks::id(), data: d, accounts: vec![
        AccountMeta::new_readonly(al, false), AccountMeta::new_readonly(mint.pubkey(), false), AccountMeta::new_readonly(bo, false),
        AccountMeta::new_readonly(alice.pubkey(), false), AccountMeta::new_readonly(extra_metas_address(&mint.pubkey(), &sine_hooks::id()).0, false),
        AccountMeta::new(config_address(&mint.pubkey(), &sine_hooks::id()).0, false)] };
    assert!(send(&mut ctx, &[direct], &[]).await.is_err(), "direct execute must fail");

    // 5. rules can't be replaced
    assert!(send(&mut ctx, &[configure_ix(&payer, &mint.pubkey(), &bob.pubkey())], &[&mint]).await.is_err(), "configure twice must fail");
}
