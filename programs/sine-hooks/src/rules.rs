//! Rule configuration and the pure decision function. No Solana runtime calls here, so every
//! rule is unit-tested on the host (`cargo test`).

use solana_program::pubkey::Pubkey;

pub const MAX_EXEMPT: usize = 4;
pub const MAX_ALLOW: usize = 64;
/// Launch-phase rules (everything that restricts ordinary holders) must end within 30 days.
/// This keeps a hook from being used as a permanent honeypot. Meteora also turns the hook off
/// for good at graduation.
pub const MAX_LAUNCH_PHASE_SECS: i64 = 30 * 86_400;
/// Creator-only locks may run longer: they restrict the creator, not buyers.
pub const MAX_CREATOR_LOCK_SECS: i64 = 2 * 365 * 86_400;
pub const DAY: i64 = 86_400;

/// Stored in the per-mint config PDA. Fixed layout, little-endian.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    pub version: u8,
    pub bump: u8,
    pub creator: Pubkey,
    /// Total supply in raw units; caps are basis points of this.
    pub supply: u64,
    pub created_ts: i64,
    /// Launch-phase rules apply while `now < launch_phase_end_ts`.
    pub launch_phase_end_ts: i64,
    /// Holder cap: no ordinary wallet may end a transfer holding more than this share (0 = off).
    pub max_wallet_bps: u16,
    /// Transaction cap: no single transfer above this share (0 = off).
    pub max_tx_bps: u16,
    /// Anti-bundle: at most this many buys from the pool per slot (0 = off).
    pub max_buys_per_slot: u8,
    /// No wallet-to-wallet sends: tokens move only to or from the pool / exempt accounts.
    pub no_p2p: bool,
    /// Only allowlisted wallets may buy until this time (0 = off).
    pub allowlist_until_ts: i64,
    /// The creator wallet cannot move tokens out until this time (0 = off).
    pub creator_lock_until_ts: i64,
    /// The creator may sell or send at most this share of supply per rolling day (0 = off).
    pub creator_daily_bps: u16,
    // mutable state
    pub creator_window_start: i64,
    pub creator_window_sent: u64,
    pub last_buy_slot: u64,
    pub buys_in_slot: u8,
    /// Owners that are never restricted: Meteora pool authorities, lockers.
    pub exempt: Vec<Pubkey>,
    pub allowlist: Vec<Pubkey>,
}

pub const LEN: usize = 1 + 1 + 32 + 8 + 8 + 8 + 2 + 2 + 1 + 1 + 8 + 8 + 2 + 8 + 8 + 8 + 1 + 1 + 32 * MAX_EXEMPT + 1 + 32 * MAX_ALLOW;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Reject {
    HolderCap = 1,
    TxCap = 2,
    BundleLimit = 3,
    NoP2p = 4,
    NotAllowlisted = 5,
    CreatorLocked = 6,
    CreatorDailyLimit = 7,
}

impl Reject {
    pub fn message(self) -> &'static str {
        match self {
            Reject::HolderCap => "sine-hooks: holder cap - this wallet would hold more than the launch maximum",
            Reject::TxCap => "sine-hooks: transaction cap - transfer is larger than the launch maximum",
            Reject::BundleLimit => "sine-hooks: anti-bundle - too many buys in this slot, try again next block",
            Reject::NoP2p => "sine-hooks: wallet-to-wallet sends are disabled during the launch phase",
            Reject::NotAllowlisted => "sine-hooks: allowlist phase - this wallet is not on the allowlist yet",
            Reject::CreatorLocked => "sine-hooks: creator tokens are locked",
            Reject::CreatorDailyLimit => "sine-hooks: creator daily sell limit reached",
        }
    }
}

/// One token transfer as the hook sees it, after balances were updated.
pub struct Transfer {
    pub src_owner: Pubkey,
    pub dst_owner: Pubkey,
    pub amount: u64,
    pub dst_balance_after: u64,
    pub now: i64,
    pub slot: u64,
}

fn share(supply: u64, bps: u16) -> u64 {
    ((supply as u128) * (bps as u128) / 10_000) as u64
}

impl Rules {
    pub fn is_exempt(&self, o: &Pubkey) -> bool {
        self.exempt.iter().any(|e| e == o)
    }

    /// Validates a fresh configuration supplied at launch.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.supply == 0 { return Err("supply must be above zero"); }
        if self.max_wallet_bps > 10_000 || self.max_tx_bps > 10_000 || self.creator_daily_bps > 10_000 { return Err("caps are basis points (max 10000)"); }
        if self.max_wallet_bps != 0 && self.max_wallet_bps < 10 { return Err("holder cap must be at least 0.1%"); }
        if self.max_tx_bps != 0 && self.max_tx_bps < 5 { return Err("transaction cap must be at least 0.05%"); }
        if self.creator_daily_bps != 0 && self.creator_daily_bps < 1 { return Err("invalid creator daily limit"); }
        if self.launch_phase_end_ts < self.created_ts { return Err("launch phase ends before it starts"); }
        if self.launch_phase_end_ts - self.created_ts > MAX_LAUNCH_PHASE_SECS { return Err("launch-phase rules can last at most 30 days"); }
        if self.allowlist_until_ts != 0 && self.allowlist_until_ts > self.launch_phase_end_ts { return Err("the allowlist phase must end within the launch phase"); }
        if self.allowlist_until_ts != 0 && self.allowlist.is_empty() { return Err("allowlist phase needs at least one wallet"); }
        if self.creator_lock_until_ts != 0 && self.creator_lock_until_ts - self.created_ts > MAX_CREATOR_LOCK_SECS { return Err("creator lock can last at most 2 years"); }
        if self.exempt.len() > MAX_EXEMPT || self.allowlist.len() > MAX_ALLOW { return Err("too many exempt or allowlisted wallets"); }
        if self.exempt.is_empty() { return Err("the pool authority must be exempt"); }
        Ok(())
    }

    /// The decision. Mutates the counters only when the transfer is allowed.
    pub fn check(&mut self, t: &Transfer) -> Result<(), Reject> {
        let src_ex = self.is_exempt(&t.src_owner);
        let dst_ex = self.is_exempt(&t.dst_owner);
        let is_buy = src_ex && !dst_ex;

        // Creator rules (independent of the launch phase).
        let creator_out = t.src_owner == self.creator && t.dst_owner != self.creator;
        let mut new_window = None;
        if creator_out {
            if self.creator_lock_until_ts != 0 && t.now < self.creator_lock_until_ts {
                return Err(Reject::CreatorLocked);
            }
            if self.creator_daily_bps != 0 {
                let (start, sent) = if t.now - self.creator_window_start >= DAY { (t.now, 0u64) } else { (self.creator_window_start, self.creator_window_sent) };
                let total = sent.saturating_add(t.amount);
                if total > share(self.supply, self.creator_daily_bps) { return Err(Reject::CreatorDailyLimit); }
                new_window = Some((start, total));
            }
        }

        let mut new_slot = None;
        if t.now < self.launch_phase_end_ts {
            if self.allowlist_until_ts != 0 && t.now < self.allowlist_until_ts && is_buy
                && t.dst_owner != self.creator && !self.allowlist.iter().any(|a| *a == t.dst_owner) {
                return Err(Reject::NotAllowlisted);
            }
            if self.no_p2p && !src_ex && !dst_ex && t.src_owner != t.dst_owner {
                return Err(Reject::NoP2p);
            }
            if self.max_tx_bps != 0 && !(src_ex && dst_ex) && t.amount > share(self.supply, self.max_tx_bps) {
                return Err(Reject::TxCap);
            }
            if self.max_wallet_bps != 0 && !dst_ex && t.dst_balance_after > share(self.supply, self.max_wallet_bps) {
                return Err(Reject::HolderCap);
            }
            if self.max_buys_per_slot != 0 && is_buy {
                let count = if t.slot == self.last_buy_slot { self.buys_in_slot.saturating_add(1) } else { 1 };
                if count > self.max_buys_per_slot { return Err(Reject::BundleLimit); }
                new_slot = Some((t.slot, count));
            }
        }

        if let Some((s, n)) = new_window { self.creator_window_start = s; self.creator_window_sent = n; }
        if let Some((s, n)) = new_slot { self.last_buy_slot = s; self.buys_in_slot = n; }
        Ok(())
    }

    pub fn pack(&self, out: &mut [u8]) {
        let mut w = W { b: out, o: 0 };
        w.u8(self.version); w.u8(self.bump); w.key(&self.creator); w.u64(self.supply);
        w.i64(self.created_ts); w.i64(self.launch_phase_end_ts); w.u16(self.max_wallet_bps); w.u16(self.max_tx_bps);
        w.u8(self.max_buys_per_slot); w.u8(self.no_p2p as u8); w.i64(self.allowlist_until_ts); w.i64(self.creator_lock_until_ts);
        w.u16(self.creator_daily_bps); w.i64(self.creator_window_start); w.u64(self.creator_window_sent); w.u64(self.last_buy_slot);
        w.u8(self.buys_in_slot);
        w.u8(self.exempt.len() as u8);
        for i in 0..MAX_EXEMPT { w.key(self.exempt.get(i).unwrap_or(&Pubkey::default())); }
        w.u8(self.allowlist.len() as u8);
        for i in 0..MAX_ALLOW { w.key(self.allowlist.get(i).unwrap_or(&Pubkey::default())); }
    }

    pub fn unpack(b: &[u8]) -> Option<Rules> {
        if b.len() < LEN { return None; }
        let mut r = R { b, o: 0 };
        let mut x = Rules {
            version: r.u8(), bump: r.u8(), creator: r.key(), supply: r.u64(), created_ts: r.i64(), launch_phase_end_ts: r.i64(),
            max_wallet_bps: r.u16(), max_tx_bps: r.u16(), max_buys_per_slot: r.u8(), no_p2p: r.u8() != 0,
            allowlist_until_ts: r.i64(), creator_lock_until_ts: r.i64(), creator_daily_bps: r.u16(),
            creator_window_start: r.i64(), creator_window_sent: r.u64(), last_buy_slot: r.u64(), buys_in_slot: r.u8(),
            exempt: vec![], allowlist: vec![],
        };
        let ne = (r.u8() as usize).min(MAX_EXEMPT);
        let ex: Vec<Pubkey> = (0..MAX_EXEMPT).map(|_| r.key()).collect();
        x.exempt = ex[..ne].to_vec();
        let na = (r.u8() as usize).min(MAX_ALLOW);
        let al: Vec<Pubkey> = (0..MAX_ALLOW).map(|_| r.key()).collect();
        x.allowlist = al[..na].to_vec();
        if x.version != 1 { return None; }
        Some(x)
    }
}

struct W<'a> { b: &'a mut [u8], o: usize }
impl W<'_> {
    fn put(&mut self, s: &[u8]) { self.b[self.o..self.o + s.len()].copy_from_slice(s); self.o += s.len(); }
    fn u8(&mut self, v: u8) { self.put(&[v]); }
    fn u16(&mut self, v: u16) { self.put(&v.to_le_bytes()); }
    fn u64(&mut self, v: u64) { self.put(&v.to_le_bytes()); }
    fn i64(&mut self, v: i64) { self.put(&v.to_le_bytes()); }
    fn key(&mut self, k: &Pubkey) { self.put(k.as_ref()); }
}
struct R<'a> { b: &'a [u8], o: usize }
impl R<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] { let mut a = [0u8; N]; a.copy_from_slice(&self.b[self.o..self.o + N]); self.o += N; a }
    fn u8(&mut self) -> u8 { self.take::<1>()[0] }
    fn u16(&mut self) -> u16 { u16::from_le_bytes(self.take()) }
    fn u64(&mut self) -> u64 { u64::from_le_bytes(self.take()) }
    fn i64(&mut self) -> i64 { i64::from_le_bytes(self.take()) }
    fn key(&mut self) -> Pubkey { Pubkey::new_from_array(self.take()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SUPPLY: u64 = 1_000_000_000_000_000; // 1B with 6 decimals
    fn k(n: u8) -> Pubkey { Pubkey::new_from_array([n; 32]) }
    fn pool() -> Pubkey { k(200) }
    fn base() -> Rules {
        Rules { version: 1, bump: 255, creator: k(1), supply: SUPPLY, created_ts: 1_000, launch_phase_end_ts: 1_000 + 3_600,
            max_wallet_bps: 0, max_tx_bps: 0, max_buys_per_slot: 0, no_p2p: false, allowlist_until_ts: 0, creator_lock_until_ts: 0,
            creator_daily_bps: 0, creator_window_start: 0, creator_window_sent: 0, last_buy_slot: 0, buys_in_slot: 0, exempt: vec![pool()], allowlist: vec![] }
    }
    fn buy(to: u8, amount: u64, after: u64, now: i64, slot: u64) -> Transfer { Transfer { src_owner: pool(), dst_owner: k(to), amount, dst_balance_after: after, now, slot } }
    fn sell(from: u8, amount: u64, now: i64) -> Transfer { Transfer { src_owner: k(from), dst_owner: pool(), amount, dst_balance_after: 0, now, slot: 1 } }
    fn send(from: u8, to: u8, amount: u64, after: u64, now: i64) -> Transfer { Transfer { src_owner: k(from), dst_owner: k(to), amount, dst_balance_after: after, now, slot: 1 } }
    const PCT: u64 = SUPPLY / 100;

    #[test] fn no_rules_allows_everything() { let mut r = base(); assert!(r.check(&buy(5, 50 * PCT, 50 * PCT, 1_500, 1)).is_ok()); assert!(r.check(&send(5, 6, PCT, PCT, 1_500)).is_ok()); }

    #[test] fn holder_cap() {
        let mut r = base(); r.max_wallet_bps = 100; // 1%
        assert!(r.check(&buy(5, PCT, PCT, 1_500, 1)).is_ok());
        assert_eq!(r.check(&buy(5, 1, PCT + 1, 1_500, 2)), Err(Reject::HolderCap));
        assert_eq!(r.check(&send(5, 6, PCT, PCT * 2, 1_500)), Err(Reject::HolderCap));
        assert!(r.check(&sell(5, 10 * PCT, 1_500)).is_ok(), "the pool is exempt");
        assert!(r.check(&buy(5, 5 * PCT, 5 * PCT, 4_601, 3)).is_ok(), "ends with the launch phase");
    }

    #[test] fn tx_cap_applies_to_buys_sells_and_sends() {
        let mut r = base(); r.max_tx_bps = 50; // 0.5%
        assert_eq!(r.check(&buy(5, PCT, PCT, 1_500, 1)), Err(Reject::TxCap));
        assert_eq!(r.check(&sell(5, PCT, 1_500)), Err(Reject::TxCap));
        assert_eq!(r.check(&send(5, 6, PCT, PCT, 1_500)), Err(Reject::TxCap));
        assert!(r.check(&buy(5, PCT / 2, PCT / 2, 1_500, 1)).is_ok());
    }

    #[test] fn anti_bundle_counts_per_slot_and_only_on_success() {
        let mut r = base(); r.max_buys_per_slot = 2; r.max_wallet_bps = 100;
        assert!(r.check(&buy(5, 1, 1, 1_500, 10)).is_ok());
        assert_eq!(r.check(&buy(6, 2 * PCT, 2 * PCT, 1_500, 10)), Err(Reject::HolderCap));
        assert!(r.check(&buy(7, 1, 1, 1_500, 10)).is_ok(), "a rejected buy did not use up the slot");
        assert_eq!(r.check(&buy(8, 1, 1, 1_500, 10)), Err(Reject::BundleLimit));
        assert!(r.check(&buy(8, 1, 1, 1_500, 11)).is_ok(), "next slot resets");
        assert!(r.check(&sell(5, 1, 1_500)).is_ok(), "sells are not counted");
    }

    #[test] fn no_p2p() {
        let mut r = base(); r.no_p2p = true;
        assert_eq!(r.check(&send(5, 6, 1, 1, 1_500)), Err(Reject::NoP2p));
        assert!(r.check(&send(5, 5, 1, 1, 1_500)).is_ok(), "moving between your own accounts is fine");
        assert!(r.check(&buy(5, 1, 1, 1_500, 1)).is_ok());
        assert!(r.check(&send(5, 6, 1, 1, 9_999)).is_ok(), "ends with the launch phase");
    }

    #[test] fn allowlist_phase() {
        let mut r = base(); r.allowlist_until_ts = 1_100; r.allowlist = vec![k(5)];
        assert!(r.check(&buy(5, 1, 1, 1_050, 1)).is_ok());
        assert!(r.check(&buy(1, 1, 1, 1_050, 1)).is_ok(), "creator dev buy");
        assert_eq!(r.check(&buy(6, 1, 1, 1_050, 2)), Err(Reject::NotAllowlisted));
        assert!(r.check(&buy(6, 1, 1, 1_100, 3)).is_ok(), "open to everyone afterwards");
        assert!(r.check(&sell(6, 1, 1_050)).is_ok(), "selling is never blocked by the allowlist");
    }

    #[test] fn creator_lock_and_daily_limit() {
        let mut r = base(); r.creator_lock_until_ts = 2_000; r.creator_daily_bps = 100; // 1%/day after the lock
        assert_eq!(r.check(&sell(1, 1, 1_500)), Err(Reject::CreatorLocked));
        assert_eq!(r.check(&send(1, 9, 1, 1, 1_500)), Err(Reject::CreatorLocked));
        assert!(r.check(&buy(1, PCT, PCT, 1_500, 1)).is_ok(), "the creator can still buy");
        assert!(r.check(&sell(1, PCT / 2, 2_000)).is_ok());
        assert!(r.check(&sell(1, PCT / 2, 2_100)).is_ok());
        assert_eq!(r.check(&sell(1, 1, 2_200)), Err(Reject::CreatorDailyLimit));
        assert!(r.check(&sell(1, PCT, 2_000 + DAY)).is_ok(), "new day, new allowance");
        assert!(r.check(&sell(5, 50 * PCT, 2_200)).is_ok(), "other wallets unaffected");
    }

    #[test] fn validation_blocks_permanent_honeypots() {
        let mut r = base(); r.launch_phase_end_ts = r.created_ts + MAX_LAUNCH_PHASE_SECS + 1; assert!(r.validate().is_err());
        let mut r = base(); r.max_wallet_bps = 1; assert!(r.validate().is_err());
        let mut r = base(); r.exempt = vec![]; assert!(r.validate().is_err());
        let mut r = base(); r.allowlist_until_ts = 1_100; assert!(r.validate().is_err(), "allowlist phase without wallets");
        let mut r = base(); r.creator_lock_until_ts = r.created_ts + MAX_CREATOR_LOCK_SECS + 1; assert!(r.validate().is_err());
        assert!(base().validate().is_ok());
    }

    #[test] fn pack_roundtrip() {
        let mut r = base(); r.allowlist = vec![k(3), k(4)]; r.max_wallet_bps = 150; r.no_p2p = true; r.creator_window_sent = 77;
        let mut buf = vec![0u8; LEN]; r.pack(&mut buf);
        assert_eq!(Rules::unpack(&buf), Some(r));
    }
}
