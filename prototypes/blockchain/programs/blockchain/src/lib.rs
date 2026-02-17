use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_VERIFY_PAIR: u32 = comp_def_offset("verify_pair");
const CARD_COUNT: usize = 16;
const ROUND_STATE_SEED: &[u8] = b"round_state";

declare_id!("HSPR8gNS9VN8hVRhRiDAWDo17WmTzENCZAdQeNepG8oy");

#[arcium_program]
pub mod blockchain {
    use super::*;

    pub fn register_round(
        ctx: Context<RegisterRound>,
        round_id: u64,
        encrypted_cards_slot_a: Vec<[u8; 32]>,
        pubkey: [u8; 32],
        board_nonce: [u8; 16],
    ) -> Result<()> {
        require!(encrypted_cards_slot_a.len() == CARD_COUNT, ErrorCode::InvalidCardCount);

        let mut fixed_cards_slot_a = [[0u8; 32]; CARD_COUNT];
        for (idx, card) in encrypted_cards_slot_a.into_iter().enumerate() {
            fixed_cards_slot_a[idx] = card;
        }

        let round_state = &mut ctx.accounts.round_state;
        round_state.player = ctx.accounts.payer.key();
        round_state.round_id = round_id;
        round_state.encrypted_cards_slot_a = fixed_cards_slot_a;
        round_state.encrypted_cards_slot_b = [[0u8; 32]; CARD_COUNT];
        round_state.player_pubkey = pubkey;
        round_state.board_nonce = board_nonce;
        round_state.turns_used = 0;
        round_state.pairs_found = 0;
        round_state.completed = false;
        round_state.bump = ctx.bumps.round_state;
        Ok(())
    }

    pub fn set_round_slot_b(
        ctx: Context<SetRoundSlotB>,
        round_id: u64,
        encrypted_cards_slot_b: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(round_id == ctx.accounts.round_state.round_id, ErrorCode::RoundIdMismatch);
        require!(encrypted_cards_slot_b.len() == CARD_COUNT, ErrorCode::InvalidCardCount);

        let mut fixed_cards_slot_b = [[0u8; 32]; CARD_COUNT];
        for (idx, card) in encrypted_cards_slot_b.into_iter().enumerate() {
            fixed_cards_slot_b[idx] = card;
        }
        ctx.accounts.round_state.encrypted_cards_slot_b = fixed_cards_slot_b;
        Ok(())
    }

    pub fn init_verify_pair_comp_def(ctx: Context<InitVerifyPairCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn verify_pair(
        ctx: Context<VerifyPair>,
        round_id: u64,
        card_a_idx: u8,
        card_b_idx: u8,
        computation_offset: u64,
        _nonce: u128,
    ) -> Result<()> {
        require!(round_id == ctx.accounts.round_state.round_id, ErrorCode::RoundIdMismatch);
        require!(card_a_idx < CARD_COUNT as u8, ErrorCode::CardIndexOutOfBounds);
        require!(card_b_idx < CARD_COUNT as u8, ErrorCode::CardIndexOutOfBounds);

        let card_a_cipher = ctx.accounts.round_state.encrypted_cards_slot_a[card_a_idx as usize];
        let card_b_cipher = ctx.accounts.round_state.encrypted_cards_slot_b[card_b_idx as usize];

        let board_nonce = u128::from_le_bytes(ctx.accounts.round_state.board_nonce);
        let args = ArgBuilder::new()
            .x25519_pubkey(ctx.accounts.round_state.player_pubkey)
            .plaintext_u128(board_nonce)
            .encrypted_u8(card_a_cipher)
            .encrypted_u8(card_b_cipher)
            .build();

        ctx.accounts.round_state.turns_used = ctx.accounts.round_state.turns_used.saturating_add(1);
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let callback_accounts = vec![CallbackAccount {
            pubkey: ctx.accounts.round_state.key(),
            is_writable: true,
        }];

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![VerifyPairCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &callback_accounts,
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "verify_pair")]
    pub fn verify_pair_callback(
        ctx: Context<VerifyPairCallback>,
        output: SignedComputationOutputs<VerifyPairOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(VerifyPairOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(PairVerified {
            player: ctx.accounts.round_state.player,
            round_id: ctx.accounts.round_state.round_id,
            turns_used: ctx.accounts.round_state.turns_used,
            pairs_found: ctx.accounts.round_state.pairs_found,
            is_match_cipher: o.ciphertexts[0],
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }

    pub fn settle_round_score(
        ctx: Context<SettleRoundScore>,
        round_id: u64,
        turns_used: u16,
        pairs_found: u8,
        completed: bool,
        solve_ms: u64,
        points_delta: i64,
        nonce_hash: [u8; 32],
    ) -> Result<()> {
        require!(round_id == ctx.accounts.round_state.round_id, ErrorCode::RoundIdMismatch);
        require!(
            ctx.accounts.round_state.player == ctx.accounts.payer.key(),
            ErrorCode::UnauthorizedRoundOwner
        );

        let round_state = &mut ctx.accounts.round_state;
        round_state.turns_used = turns_used;
        round_state.pairs_found = pairs_found;
        round_state.completed = completed;

        emit!(RoundSettled {
            player: ctx.accounts.payer.key(),
            round_id,
            turns_used,
            pairs_found,
            completed,
            solve_ms,
            points_delta,
            nonce_hash,
        });
        Ok(())
    }
}

#[queue_computation_accounts("verify_pair", payer)]
#[derive(Accounts)]
#[instruction(round_id: u64, card_a_idx: u8, card_b_idx: u8, computation_offset: u64, nonce: u128)]
pub struct VerifyPair<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [ROUND_STATE_SEED, payer.key().as_ref(), &round_id.to_le_bytes()],
        bump = round_state.bump,
        constraint = round_state.player == payer.key() @ ErrorCode::UnauthorizedRoundOwner,
    )]
    pub round_state: Box<Account<'info, RoundState>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_VERIFY_PAIR))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("verify_pair")]
#[derive(Accounts)]
pub struct VerifyPairCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_VERIFY_PAIR))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program via callback constraints.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub round_state: Box<Account<'info, RoundState>>,
}

#[init_computation_definition_accounts("verify_pair", payer)]
#[derive(Accounts)]
pub struct InitVerifyPairCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot)
    )]
    /// CHECK: checked by arcium program
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: LUT program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RegisterRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = RoundState::SPACE,
        seeds = [ROUND_STATE_SEED, payer.key().as_ref(), &round_id.to_le_bytes()],
        bump,
    )]
    pub round_state: Account<'info, RoundState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SettleRoundScore<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [ROUND_STATE_SEED, payer.key().as_ref(), &round_id.to_le_bytes()],
        bump = round_state.bump,
        constraint = round_state.player == payer.key() @ ErrorCode::UnauthorizedRoundOwner,
    )]
    pub round_state: Box<Account<'info, RoundState>>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SetRoundSlotB<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [ROUND_STATE_SEED, payer.key().as_ref(), &round_id.to_le_bytes()],
        bump = round_state.bump,
        constraint = round_state.player == payer.key() @ ErrorCode::UnauthorizedRoundOwner,
    )]
    pub round_state: Box<Account<'info, RoundState>>,
}

#[account]
pub struct RoundState {
    pub player: Pubkey,
    pub round_id: u64,
    pub encrypted_cards_slot_a: [[u8; 32]; CARD_COUNT],
    pub encrypted_cards_slot_b: [[u8; 32]; CARD_COUNT],
    pub player_pubkey: [u8; 32],
    pub board_nonce: [u8; 16],
    pub turns_used: u16,
    pub pairs_found: u8,
    pub completed: bool,
    pub bump: u8,
}

impl RoundState {
    pub const SPACE: usize = 8 + 32 + 8 + (32 * CARD_COUNT) + (32 * CARD_COUNT) + 32 + 16 + 2 + 1 + 1 + 1;
}

#[event]
pub struct PairVerified {
    pub player: Pubkey,
    pub round_id: u64,
    pub turns_used: u16,
    pub pairs_found: u8,
    pub is_match_cipher: [u8; 32],
    pub nonce: [u8; 16],
}

#[event]
pub struct RoundSettled {
    pub player: Pubkey,
    pub round_id: u64,
    pub turns_used: u16,
    pub pairs_found: u8,
    pub completed: bool,
    pub solve_ms: u64,
    pub points_delta: i64,
    pub nonce_hash: [u8; 32],
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Expected exactly 16 encrypted cards")]
    InvalidCardCount,
    #[msg("Card index out of bounds")]
    CardIndexOutOfBounds,
    #[msg("Round owner does not match signer")]
    UnauthorizedRoundOwner,
    #[msg("Round id mismatch")]
    RoundIdMismatch,
}
