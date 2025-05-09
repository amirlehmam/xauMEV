// SPDX‑License‑Identifier: MIT
//! Hot‑path flash‑loan sender for xauMEV.
//! Called from `main.rs` whenever a price‑spread trigger is hit.

use std::{env, sync::Arc, time::Duration};

use anyhow::Result;
use ethers::{
    abi::{Function, Param, ParamType, Token},
    core::types::Address,
    middleware::{
        gas_escalator::{Frequency, GasEscalatorMiddleware, Percent},
        nonce_manager::NonceManagerMiddleware,
        SignerMiddleware,
    },
    prelude::{abigen, LocalWallet, Provider, Ws},
    signers::Signer,
    types::{Bytes, U256},
};

/// ───────────────────────────────────────────────────────────
/// 1. Solidity flash‑loan contract ABI (only the entry we call)
abigen!(
    FlashLoanArbitrage,
    r#"[
        function executeArbitrage(
            address buyRouter,
            bytes   buyData,
            address sellRouter,
            bytes   sellData,
            uint256 loanAmount,
            uint256 minProfit,
            uint256 maxDevBps
        ) external
    ]"#,
);

/// ───────────────────────────────────────────────────────────
/// 2. Helper – encode Uniswap V2 `swapExactTokensForTokens` call
fn encode_swap_exact_tokens(
    amount_in: U256,
    amount_out_min: U256,
    path: Vec<Address>,
    recipient: Address,
    deadline_secs: u64,
) -> Bytes {
    let function = Function {
        name: "swapExactTokensForTokens".into(),
        inputs: vec![
            Param { name: "amountIn".into(), kind: ParamType::Uint(256), internal_type: None },
            Param { name: "amountOutMin".into(), kind: ParamType::Uint(256), internal_type: None },
            Param { name: "path".into(), kind: ParamType::Array(Box::new(ParamType::Address)), internal_type: None },
            Param { name: "to".into(), kind: ParamType::Address, internal_type: None },
            Param { name: "deadline".into(), kind: ParamType::Uint(256), internal_type: None },
        ],
        outputs: vec![],
        constant: None,
        state_mutability: ethers::abi::StateMutability::NonPayable,
    };

    let args = [
        Token::Uint(amount_in),
        Token::Uint(amount_out_min),
        Token::Array(path.into_iter().map(Token::Address).collect()),
        Token::Address(recipient),
        Token::Uint(U256::from(deadline_secs)),
    ];
    function.encode_input(&args).unwrap().into()
}

/// ───────────────────────────────────────────────────────────
/// 3. Fire‑and‑forget transaction
///
/// * `spread_bps` is passed only for logging; all hard guards
///   (minProfit, maxDevBps, loanAmount) come from `.env`.
pub async fn fire(
    ws_url: &str,
    arb_contract: Address,
    buy_router: Address,
    sell_router: Address,
    usdt: Address,
    xaut: Address,
    spread_bps: u32,
) -> Result<()> {
    // Abort quickly if spread is below env‑configured threshold
    let threshold: u32 = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;
    if spread_bps < threshold {
        return Ok(());
    }

    // ── Provider + signer
    let provider = Provider::<Ws>::connect(ws_url).await?;
    let provider = provider.interval(Duration::from_millis(250));
    let chain_id = provider.get_chainid().await?.as_u64();

    let wallet: LocalWallet = env::var("PRIVATE_KEY")?.parse::<LocalWallet>()?.with_chain_id(chain_id);
    let client = SignerMiddleware::new(
        GasEscalatorMiddleware::new(
            NonceManagerMiddleware::new(provider, wallet.address()),
            Frequency::PerBlock,
            Percent::new(15),
        ),
        wallet,
    );
    let client = Arc::new(client);

    // ── Trade sizing & safety limits (for demo: fixed 10 000 USDT)
    let loan_amount = U256::from_dec_str("10000000000")?;             // 10 000 (6 dec)
    let min_profit  = U256::from_dec_str(&env::var("MIN_PROFIT_USDT")?)?;
    let max_dev_bps = U256::from_dec_str(&env::var("MAX_DEV_BPS")?)?;

    // ── Swap calldata
    let now = unix_time();
    let buy_data  = encode_swap_exact_tokens(
        loan_amount,
        U256::zero(),
        vec![usdt, xaut],
        arb_contract,
        now + 120,
    );
    let sell_data = encode_swap_exact_tokens(
        U256::zero(),
        U256::zero(),
        vec![xaut, usdt],
        arb_contract,
        now + 180,
    );

    // ── Send flash‑loan tx
    let arb = FlashLoanArbitrage::new(arb_contract, client.clone());
    let pending = arb
        .execute_arbitrage(
            buy_router,
            buy_data,
            sell_router,
            sell_data,
            loan_amount,
            min_profit,
            max_dev_bps,
        )
        .gas(1_500_000u64)                   // upper‑bound; tune later
        .send()
        .await?
        .interval(Duration::from_secs(3));

    match pending.await? {
        Some(r) => println!(
            "✅  arbitrage tx mined  hash={:?}  spread={} bps",
            r.transaction_hash, spread_bps
        ),
        None => println!("⚠️  tx dropped / replaced – consider manual gas‑bump"),
    }
    Ok(())
}

#[inline]
fn unix_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
