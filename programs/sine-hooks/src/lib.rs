//! sine-hooks: a Token-2022 transfer hook for SINE Forge coins.
//!
//! Solana calls this program on every transfer of a coin whose mint names it (buys and sells on
//! the Meteora bonding curve, and wallet-to-wallet sends). The rules picked at launch are
//! enforced here; a transfer that breaks one fails, and the whole transaction with it. Meteora's
//! DBC revokes the hook at graduation, so rules apply on the bonding curve only.
//!
//! Instructions
//!   Configure (tag "SINECFG1"): run ONCE per coin, BEFORE the coin is created, signed by the
//!     creator (payer) and by the coin's mint keypair. Proving control of the mint key means nobody
//!     else can configure rules for that address. Creates the config PDA and the
//!     ExtraAccountMetaList PDA. Rules can never be changed afterwards.
//!   Execute (transfer-hook interface): called by Token-2022 during transfers.
//!
//! Safety: launch-phase rules must end within 30 days (see `rules::validate`), so a hook can't be
//! turned into a permanent honeypot. The creator can't add a blacklist or pause trading.

pub mod rules;

use rules::{Rules, Transfer, LEN, MAX_ALLOW, MAX_EXEMPT};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022::{
    extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
    state::Account as TokenAccount,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

solana_program::declare_id!("SineHooks1111111111111111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"sine-hooks";
pub const EXTRA_SEED: &[u8] = b"extra-account-metas";
pub const CONFIGURE_TAG: &[u8; 8] = b"SINECFG1";

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() >= 8 && &data[..8] == CONFIGURE_TAG {
        return configure(program_id, accounts, &data[8..]);
    }
    match TransferHookInstruction::unpack(data)? {
        TransferHookInstruction::Execute { amount } => execute(program_id, accounts, amount),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

pub fn config_address(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED, mint.as_ref()], program_id)
}
pub fn extra_metas_address(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[EXTRA_SEED, mint.as_ref()], program_id)
}

/// Settings sent with Configure. Durations are seconds from now.
pub struct ConfigureArgs {
    pub supply: u64,
    pub launch_phase_secs: u32,
    pub max_wallet_bps: u16,
    pub max_tx_bps: u16,
    pub max_buys_per_slot: u8,
    pub no_p2p: bool,
    pub allowlist_secs: u32,
    pub creator_lock_secs: u32,
    pub creator_daily_bps: u16,
    pub exempt: Vec<Pubkey>,
    pub allowlist: Vec<Pubkey>,
}

impl ConfigureArgs {
    pub fn unpack(d: &[u8]) -> Result<Self, ProgramError> {
        let bad = || ProgramError::InvalidInstructionData;
        let mut o = 0usize;
        let mut take = |n: usize| -> Result<&[u8], ProgramError> { let s = d.get(o..o + n).ok_or_else(bad)?; o += n; Ok(s) };
        let u64_ = |s: &[u8]| u64::from_le_bytes(s.try_into().unwrap());
        let u32_ = |s: &[u8]| u32::from_le_bytes(s.try_into().unwrap());
        let u16_ = |s: &[u8]| u16::from_le_bytes(s.try_into().unwrap());
        let supply = u64_(take(8)?);
        let launch_phase_secs = u32_(take(4)?);
        let max_wallet_bps = u16_(take(2)?);
        let max_tx_bps = u16_(take(2)?);
        let max_buys_per_slot = take(1)?[0];
        let no_p2p = take(1)?[0] != 0;
        let allowlist_secs = u32_(take(4)?);
        let creator_lock_secs = u32_(take(4)?);
        let creator_daily_bps = u16_(take(2)?);
        let ne = take(1)?[0] as usize;
        if ne > MAX_EXEMPT { return Err(bad()); }
        let mut exempt = Vec::with_capacity(ne);
        for _ in 0..ne { exempt.push(Pubkey::new_from_array(take(32)?.try_into().unwrap())); }
        let na = take(1)?[0] as usize;
        if na > MAX_ALLOW { return Err(bad()); }
        let mut allowlist = Vec::with_capacity(na);
        for _ in 0..na { allowlist.push(Pubkey::new_from_array(take(32)?.try_into().unwrap())); }
        Ok(Self { supply, launch_phase_secs, max_wallet_bps, max_tx_bps, max_buys_per_slot, no_p2p, allowlist_secs, creator_lock_secs, creator_daily_bps, exempt, allowlist })
    }
}

fn create_pda<'a>(payer: &AccountInfo<'a>, pda: &AccountInfo<'a>, system: &AccountInfo<'a>, program_id: &Pubkey, space: usize, seeds: &[&[u8]]) -> ProgramResult {
    let lamports = Rent::get()?.minimum_balance(space);
    invoke_signed(&system_instruction::create_account(payer.key, pda.key, lamports, space as u64, program_id), &[payer.clone(), pda.clone(), system.clone()], &[seeds])
}

fn configure(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let extra = next_account_info(it)?;
    let config = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !payer.is_signer || !mint.is_signer {
        msg!("sine-hooks: configure must be signed by the creator and the coin's mint key");
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (cfg_key, cfg_bump) = config_address(mint.key, program_id);
    let (extra_key, extra_bump) = extra_metas_address(mint.key, program_id);
    if *config.key != cfg_key || *extra.key != extra_key { return Err(ProgramError::InvalidSeeds); }
    if config.lamports() > 0 || extra.lamports() > 0 {
        msg!("sine-hooks: rules for this coin are already set and can't be changed");
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let a = ConfigureArgs::unpack(data)?;
    let now = Clock::get()?.unix_timestamp;
    let opt = |secs: u32| if secs == 0 { 0 } else { now + secs as i64 };
    let r = Rules {
        version: 1, bump: cfg_bump, creator: *payer.key, supply: a.supply, created_ts: now,
        launch_phase_end_ts: now + a.launch_phase_secs as i64,
        max_wallet_bps: a.max_wallet_bps, max_tx_bps: a.max_tx_bps, max_buys_per_slot: a.max_buys_per_slot, no_p2p: a.no_p2p,
        allowlist_until_ts: opt(a.allowlist_secs), creator_lock_until_ts: opt(a.creator_lock_secs), creator_daily_bps: a.creator_daily_bps,
        creator_window_start: 0, creator_window_sent: 0, last_buy_slot: 0, buys_in_slot: 0, exempt: a.exempt, allowlist: a.allowlist,
    };
    if let Err(e) = r.validate() { msg!("sine-hooks: {}", e); return Err(ProgramError::InvalidArgument); }

    create_pda(payer, config, system, program_id, LEN, &[CONFIG_SEED, mint.key.as_ref(), &[cfg_bump]])?;
    r.pack(&mut config.try_borrow_mut_data()?);

    let metas = [ExtraAccountMeta::new_with_seeds(&[Seed::Literal { bytes: CONFIG_SEED.to_vec() }, Seed::AccountKey { index: 1 }], false, true)?];
    let size = ExtraAccountMetaList::size_of(metas.len())?;
    create_pda(payer, extra, system, program_id, size, &[EXTRA_SEED, mint.key.as_ref(), &[extra_bump]])?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut extra.try_borrow_mut_data()?, &metas)?;
    msg!("sine-hooks: rules set for {}", mint.key);
    Ok(())
}

/// Reads owner and balance from a Token-2022 account, and whether Token-2022 is mid-transfer on it.
fn token_view(acc: &AccountInfo, mint: &Pubkey) -> Result<(Pubkey, u64, bool), ProgramError> {
    if *acc.owner != spl_token_2022::id() { return Err(ProgramError::IncorrectProgramId); }
    let data = acc.try_borrow_data()?;
    let st = StateWithExtensions::<TokenAccount>::unpack(&data)?;
    if st.base.mint != *mint { return Err(ProgramError::InvalidAccountData); }
    let transferring = st.get_extension::<TransferHookAccount>().map(|e| bool::from(e.transferring)).unwrap_or(false);
    Ok((st.base.owner, st.base.amount, transferring))
}

fn execute(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let source = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let destination = next_account_info(it)?;
    let _authority = next_account_info(it)?;
    let extra = next_account_info(it)?;
    let config = next_account_info(it)?;
    if *extra.key != extra_metas_address(mint.key, program_id).0 || *config.key != config_address(mint.key, program_id).0 || config.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }
    let (src_owner, _, src_transferring) = token_view(source, mint.key)?;
    let (dst_owner, dst_balance_after, _) = token_view(destination, mint.key)?;
    // Only Token-2022 sets this flag, and only during a real transfer: direct calls can't touch the counters.
    if !src_transferring {
        msg!("sine-hooks: execute may only be called by Token-2022 during a transfer");
        return Err(ProgramError::InvalidAccountData);
    }
    let mut r = Rules::unpack(&config.try_borrow_data()?).ok_or(ProgramError::InvalidAccountData)?;
    let clock = Clock::get()?;
    let t = Transfer { src_owner, dst_owner, amount, dst_balance_after, now: clock.unix_timestamp, slot: clock.slot };
    match r.check(&t) {
        Ok(()) => { r.pack(&mut config.try_borrow_mut_data()?); Ok(()) }
        Err(rej) => { msg!(rej.message()); Err(ProgramError::Custom(6000 + rej as u32)) }
    }
}
