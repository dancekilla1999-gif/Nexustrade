use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo, Burn, Transfer};

declare_id!("NexUsToken11111111111111111111111111111111");

/// NexusTrade token helper program.
/// Основной mint создаётся как стандартный SPL Token;
/// эта программа — опциональный контроль: mint/burn только authority.
#[program]
pub mod nexus_token {
    use super::*;

    /// Инициализация конфига токена (authority + mint)
    pub fn initialize(ctx: Context<Initialize>, decimals: u8) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.mint = ctx.accounts.mint.key();
        cfg.decimals = decimals;
        cfg.bump = ctx.bumps.config;
        msg!("Nexus token config initialized");
        Ok(())
    }

    /// Mint токенов (только authority)
    pub fn mint_tokens(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.config.authority, ctx.accounts.authority.key());
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
        );
        token::mint_to(cpi, amount)?;
        Ok(())
    }

    /// Burn токенов пользователем
    pub fn burn_tokens(ctx: Context<BurnTokens>, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.from.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::burn(cpi, amount)?;
        Ok(())
    }

    /// Перевод (обёртка; обычно делают напрямую SPL transfer)
    pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::transfer(cpi, amount)?;
        Ok(())
    }
}

#[account]
pub struct TokenConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub decimals: u8,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 1 + 1,
        seeds = [b"config", mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, TokenConfig>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"config", mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, TokenConfig>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// CHECK: mint authority (может быть PDA или wallet)
    pub mint_authority: Signer<'info>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
