// SPDX‑License‑Identifier: MIT
//
// 50‑token Uniswap↔Sushi scanner with Flashbots bundle sender.
// Built & tested on:  rustc 1.78  •  ethers 2.0.14  •  ethers‑flashbots 0.15
//

use std::{collections::HashMap, env, sync::Arc, time::Duration};

use anyhow::Result;
use dotenv::dotenv;
use ethers::{
    contract::abigen,
    middleware::{
        gas_escalator::{Frequency, GasEscalatorMiddleware, GeometricGasPrice},
        nonce_manager::NonceManagerMiddleware,
        SignerMiddleware,
    },
    providers::{Middleware, Provider, StreamExt, Ws},
    signers::{LocalWallet, Signer},
    types::{Address, BlockNumber, Filter, Log, U256},
};
use serde::Deserialize;
use tokio::sync::broadcast;
use tracing::info;
mod tx_executor;

// ── Factory ABI (only need getPair) ──────────────────────────────────────
abigen!(
    UniswapV2Factory,
    r#"[ function getPair(address,address) view returns (address) ]"#,
);

// Flash‑loan arbitrage contract (single entry)
abigen!(
    FlashLoanArb,
    r#"[ function executeArbitrage(address,bytes,address,bytes,uint256,uint256,uint256) ]"#,
);

// ── Local structs ───────────────────────────────────────────────────────
#[derive(Debug, Deserialize)]
struct Token {
    symbol:   String,
    address:  Address,
    decimals: u8,
}

#[derive(Clone, Copy)]
struct Reserves {
    token: u128,
    usdt:  u128,
    last_updated: u64,
}

// ── Main ────────────────────────────────────────────────────────────────
#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    dotenv().ok();
    tracing_subscriber::fmt().with_env_filter("info").init();

    // ── ENV
    let ws_url             = env::var("ETH_WS_URL")?;
    let uni_factory: Address   = env::var("UNISWAP_FACTORY")?.parse()?;
    let sushi_factory: Address = env::var("SUSHI_FACTORY")?.parse()?;
    let uni_router: Address    = env::var("UNISWAP_ROUTER")?.parse()?;
    let sushi_router: Address  = env::var("SUSHI_ROUTER")?.parse()?;
    let usdt: Address          = env::var("USDT_ADDR")?.parse()?;
    let threshold_bps: f64     = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;
    let flash_contract: Address= env::var("FLASHLOAN_ARBITRAGE")?.parse()?;

    // ── Base WS provider (implements PubsubClient)
    let ws        = Ws::connect(&ws_url).await?;
    let base_prov = Provider::new(ws).interval(Duration::from_millis(50));
    let arc_prov  = Arc::new(base_prov.clone());

    // ── Gas‑escalated signing client
    let escalator = GeometricGasPrice::new(
        1.125,                 // bump factor
        60u64,                 // re‑quote every 60 s
        Some(U256::from(50_000_000_000u64)), // 50 gwei price‑cap
    );
    let escalated = GasEscalatorMiddleware::new(base_prov, escalator, Frequency::PerBlock);

    let wallet: LocalWallet = env::var("PRIVATE_KEY")?
        .parse::<LocalWallet>()?
        .with_chain_id(1u64);

    let signer_mw   = SignerMiddleware::new(escalated, wallet.clone());
    let client      = Arc::new(NonceManagerMiddleware::new(signer_mw, wallet.address()));

    // ── Load token list
    let tokens: Vec<Token> =
        serde_json::from_str(&std::fs::read_to_string("config/tokens.json")?)?;

    // Channel for reserve updates
    let (tx, mut rx) = broadcast::channel::<(String, bool, Reserves)>(2048);

    // Caches
    let mut uni_map   : HashMap<String, Reserves> = HashMap::new();
    let mut sushi_map : HashMap<String, Reserves> = HashMap::new();
    let mut decimals  : HashMap<String, u8>       = HashMap::new();
    let mut taddr     : HashMap<String, Address>  = HashMap::new();

    // ── Discover pools & spawn listeners
    for t in &tokens {
        decimals.insert(t.symbol.clone(), t.decimals);
        taddr.insert(t.symbol.clone(), t.address);

        let uni_pair = UniswapV2Factory::new(uni_factory, arc_prov.clone())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        let sushi_pair = UniswapV2Factory::new(sushi_factory, arc_prov.clone())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        if uni_pair.is_zero() || sushi_pair.is_zero() {
            continue;
        }

        spawn_listener(arc_prov.clone(), t.symbol.clone(), uni_pair,  true,  tx.clone());
        spawn_listener(arc_prov.clone(), t.symbol.clone(), sushi_pair,false, tx.clone());
    }
    info!("✅  Streaming Sync events for {} tokens", decimals.len());

    // ── Hot loop: merge caches & scan spread
    while let Ok((sym, is_uni, res)) = rx.recv().await {
        if is_uni { uni_map.insert(sym.clone(), res); } else { sushi_map.insert(sym.clone(), res); }

        if let (Some(u), Some(s)) = (uni_map.get(&sym), sushi_map.get(&sym)) {
            let d          = *decimals.get(&sym).unwrap_or(&18) as i32;
            let factor     = 10f64.powi(d) / 1e6;
            let p_uni      = (u.usdt as f64) / (u.token as f64 / factor);
            let p_sushi    = (s.usdt as f64) / (s.token as f64 / factor);
            let spread_bps = ((p_sushi - p_uni).abs() / p_uni) * 10_000.0;

            if spread_bps >= threshold_bps {
                info!("⚡ {sym:>6}  {spread_bps:.2} bps  uni={p_uni:.5}  sushi={p_sushi:.5}");
                let _ = tx_executor::fire(
                    &ws_url,
                    flash_contract,
                    uni_router,
                    sushi_router,
                    usdt,
                    *taddr.get(&sym).unwrap(),
                    spread_bps as u32,
                ).await;
            }
        }
    }
    Ok(())
}

// ── Log‑listener task
fn spawn_listener(
    provider: Arc<Provider<Ws>>,
    symbol:   String,
    pair:     Address,
    is_uni:   bool,
    tx:       broadcast::Sender<(String, bool, Reserves)>,
) {
    tokio::spawn(async move {
        let filter = Filter::new()
            .address(pair)
            .event("Sync(uint112,uint112)")
            .from_block(BlockNumber::Latest);

        let mut stream = provider.subscribe_logs(&filter).await.unwrap();
        while let Some(Log { data, .. }) = stream.next().await {
            if data.0.len() == 64 {
                let r0 = U256::from_big_endian(&data.0[0..32]).as_u128();
                let r1 = U256::from_big_endian(&data.0[32..64]).as_u128();
                let _ = tx.send((
                    symbol.clone(),
                    is_uni,
                    Reserves { token: r0, usdt: r1, last_updated: unix_ts() },
                ));
            }
        }
    });
}

#[inline]
fn unix_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
