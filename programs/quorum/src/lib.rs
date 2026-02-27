use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("FC1476pqPa9YtMiXVk2QTFMNEjfh8P16HiEM3DihHhqy");

// The program that turns checkout timeouts into financial primitives.
// KYD Labs, if you're reading this: please give us an API.
// We built this instead and honestly it kind of slaps.

#[program]
pub mod quorum {
    use super::*;

    /// Create an option contract — fan pays premium SOL to lock in
    /// the right to buy tickets at face value until expiry.
    /// The options market reveals true demand intensity.
    pub fn create_option(
        ctx: Context<CreateOption>,
        option_id: String,
        event_name: String,
        event_date: String,
        ticket_type: String,
        quantity: u8,
        premium_lamports: u64,
        expiry: i64,
        venue_royalty_bps: u16,
    ) -> Result<()> {
        require!(quantity > 0 && quantity <= 20, QuorumError::InvalidQuantity);
        require!(premium_lamports > 0, QuorumError::InvalidPremium);
        require!(option_id.len() <= 32, QuorumError::StringTooLong);
        require!(event_name.len() <= 64, QuorumError::StringTooLong);
        require!(event_date.len() <= 16, QuorumError::StringTooLong);
        require!(ticket_type.len() <= 32, QuorumError::StringTooLong);
        require!(venue_royalty_bps <= 5000, QuorumError::InvalidRoyalty); // max 50%

        let clock = Clock::get()?;
        require!(expiry > clock.unix_timestamp, QuorumError::ExpiryInPast);

        // Transfer premium from fan to this PDA (held in the account's lamports)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.holder.to_account_info(),
                    to: ctx.accounts.option_contract.to_account_info(),
                },
            ),
            premium_lamports,
        )?;

        let option = &mut ctx.accounts.option_contract;
        option.option_id = option_id;
        option.event_name = event_name;
        option.event_date = event_date;
        option.ticket_type = ticket_type;
        option.quantity = quantity;
        option.premium_lamports = premium_lamports;
        option.holder = ctx.accounts.holder.key();
        option.expiry = expiry;
        option.status = OptionStatus::Active as u8;
        option.created_at = clock.unix_timestamp;
        option.venue_royalty_bps = venue_royalty_bps;
        option.bump = ctx.bumps.option_contract;

        emit!(OptionCreated {
            option_id: option.option_id.clone(),
            event_name: option.event_name.clone(),
            holder: option.holder,
            premium_lamports,
            expiry,
        });

        msg!("Option created: {} for {} — premium: {} lamports",
             option.option_id, option.event_name, premium_lamports);

        Ok(())
    }

    /// Exercise an option — fan converts the option to tickets (status → Exercised)
    /// In a real system, this would trigger ticket issuance via the venue API.
    /// KYD: this is the CPI you'd implement on your end. Call us.
    pub fn exercise_option(ctx: Context<ExerciseOption>) -> Result<()> {
        let option = &mut ctx.accounts.option_contract;

        require!(option.status == OptionStatus::Active as u8, QuorumError::NotActive);
        require!(
            ctx.accounts.holder.key() == option.holder,
            QuorumError::UnauthorizedHolder
        );

        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= option.expiry, QuorumError::OptionExpired);

        option.status = OptionStatus::Exercised as u8;

        emit!(OptionExercised {
            option_id: option.option_id.clone(),
            holder: option.holder,
        });

        msg!("Option exercised: {} by {}", option.option_id, option.holder);
        Ok(())
    }

    /// Expire an option — anyone can call this after expiry timestamp.
    /// Premium stays in the PDA (venue/protocol fee).
    /// This is how venues capture upside from options they write.
    pub fn expire_option(ctx: Context<ExpireOption>) -> Result<()> {
        let option = &mut ctx.accounts.option_contract;

        require!(option.status == OptionStatus::Active as u8, QuorumError::NotActive);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp > option.expiry, QuorumError::NotExpiredYet);

        option.status = OptionStatus::Expired as u8;

        emit!(OptionExpired {
            option_id: option.option_id.clone(),
            holder: option.holder,
            premium_lamports: option.premium_lamports,
        });

        msg!("Option expired: {} — premium retained: {} lamports",
             option.option_id, option.premium_lamports);
        Ok(())
    }
}

// ============================================================================
// ACCOUNT STRUCTS
// ============================================================================

#[account]
pub struct OptionContract {
    pub option_id: String,          // unique ID (max 32 chars)
    pub event_name: String,         // "Florist" (max 64 chars)
    pub event_date: String,         // "2026-03-01" (max 16 chars)
    pub ticket_type: String,        // "GA Early Bird" (max 32 chars)
    pub quantity: u8,               // number of tickets
    pub premium_lamports: u64,      // premium paid in lamports
    pub holder: Pubkey,             // fan's wallet
    pub expiry: i64,                // unix timestamp
    pub status: u8,                 // 0=Active, 1=Exercised, 2=Expired
    pub created_at: i64,            // unix timestamp
    pub venue_royalty_bps: u16,     // basis points (1000 = 10%)
    pub bump: u8,                   // PDA bump seed
}

impl OptionContract {
    // 8 discriminator + actual data
    // Strings: 4 bytes length prefix + content
    pub const MAX_SIZE: usize = 8
        + (4 + 32)   // option_id
        + (4 + 64)   // event_name
        + (4 + 16)   // event_date
        + (4 + 32)   // ticket_type
        + 1          // quantity
        + 8          // premium_lamports
        + 32         // holder pubkey
        + 8          // expiry
        + 1          // status
        + 8          // created_at
        + 2          // venue_royalty_bps
        + 1;         // bump
}

// Option lifecycle states
pub enum OptionStatus {
    Active = 0,
    Exercised = 1,
    Expired = 2,
}

// ============================================================================
// CONTEXT STRUCTS
// ============================================================================

#[derive(Accounts)]
#[instruction(option_id: String)]
pub struct CreateOption<'info> {
    #[account(
        init,
        payer = holder,
        space = OptionContract::MAX_SIZE,
        seeds = [b"option", option_id.as_bytes()],
        bump
    )]
    pub option_contract: Account<'info, OptionContract>,

    #[account(mut)]
    pub holder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExerciseOption<'info> {
    #[account(
        mut,
        seeds = [b"option", option_contract.option_id.as_bytes()],
        bump = option_contract.bump
    )]
    pub option_contract: Account<'info, OptionContract>,

    pub holder: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExpireOption<'info> {
    #[account(
        mut,
        seeds = [b"option", option_contract.option_id.as_bytes()],
        bump = option_contract.bump
    )]
    pub option_contract: Account<'info, OptionContract>,

    // Anyone can call expire — no signer constraint needed
    pub caller: Signer<'info>,
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct OptionCreated {
    pub option_id: String,
    pub event_name: String,
    pub holder: Pubkey,
    pub premium_lamports: u64,
    pub expiry: i64,
}

#[event]
pub struct OptionExercised {
    pub option_id: String,
    pub holder: Pubkey,
}

#[event]
pub struct OptionExpired {
    pub option_id: String,
    pub holder: Pubkey,
    pub premium_lamports: u64,
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum QuorumError {
    #[msg("Quantity must be between 1 and 20")]
    InvalidQuantity,
    #[msg("Premium must be greater than 0")]
    InvalidPremium,
    #[msg("String exceeds maximum length")]
    StringTooLong,
    #[msg("Venue royalty cannot exceed 50%")]
    InvalidRoyalty,
    #[msg("Expiry timestamp must be in the future")]
    ExpiryInPast,
    #[msg("Option is not in Active status")]
    NotActive,
    #[msg("Only the option holder can exercise")]
    UnauthorizedHolder,
    #[msg("Option has expired")]
    OptionExpired,
    #[msg("Option has not expired yet")]
    NotExpiredYet,
}
