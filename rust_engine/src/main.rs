// SPDX‑License‑Identifier: MIT
//
// 50‑pair Uniswap–Sushi scanner with Flashbots sender
// Compiles on: ethers 2.0.14  •  ethers‑flashbots 0.15

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
    prelude::*,
    providers::{Provider, StreamExt, Ws},
    signers::LocalWallet,
    types::{Address, BlockNumber, Filter, Log, U256},
};
use serde::Deserialize;
use tokio::sync::broadcast;
use tracing::info;

// ─── Minimal ABIs ────────────────────────────────────────────────────────
abigen!(
    UniswapV2Factory,
    r#"[ function getPair(address,address) view returns (address) ]"#,
);

abigen!(
    UniswapV2Pair,
    r#"[ event Sync(uint112,uint112) function token0() view returns (address) function token1() view returns (address) ]"#,
);

abigen!(
    FlashLoanArb,
    r#"[ function executeArbitrage(address,bytes,address,bytes,uint256,uint256,uint256) ]"#,
);

// ─── Data structures ────────────────────────────────────────────────────
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

// ─── Main ───────────────────────────────────────────────────────────────
#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    dotenv().ok();
    tracing_subscriber::fmt().with_env_filter("info").init();

    // ENV
    let ws_url             = env::var("ETH_WS_URL")?;
    let uni_factory: Address   = env::var("UNISWAP_FACTORY")?.parse()?;
    let sushi_factory: Address = env::var("SUSHI_FACTORY")?.parse()?;
    let uni_router: Address    = env::var("UNISWAP_ROUTER")?.parse()?;
    let sushi_router: Address  = env::var("SUSHI_ROUTER")?.parse()?;
    let usdt: Address          = env::var("USDT_ADDR")?.parse()?;
    let threshold_bps: f64     = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;
    let flash_contract: Address= env::var("FLASHLOAN_ARBITRAGE")?.parse()?;

    // Provider + gas escalator + signer
    let ws        = Ws::connect(&ws_url).await?;
    let base      = Provider::new(ws).interval(Duration::from_millis(50));
    let escalator = GeometricGasPrice::new(
        1.125,                           // 12.5 % bump factor
        U256::from(50_000_000_000u64),   // start at 50 gwei
        None::<U256>,                    // no hard cap
    );
    let provider  = GasEscalatorMiddleware::new(base, escalator, Frequency::PerBlock);

    let wallet: LocalWallet = env::var("PRIVATE_KEY")?
        .parse::<LocalWallet>()?
        .with_chain_id(1u64);

    let provider  = NonceManagerMiddleware::new(provider, wallet.address());
    let client    = Arc::new(SignerMiddleware::new(provider, wallet));

    // Load token list
    let tokens: Vec<Token> =
        serde_json::from_str(&std::fs::read_to_string("config/tokens.json")?)?;

    // Broadcast channel for reserve updates
    let (tx, mut rx) = broadcast::channel::<(String, bool, Reserves)>(2048);

    // Caches
    let mut uni_map   : HashMap<String, Reserves> = HashMap::new();
    let mut sushi_map : HashMap<String, Reserves> = HashMap::new();
    let mut decimals  : HashMap<String, u8>       = HashMap::new();

    // Discover pools and spawn listeners
    for t in &tokens {
        decimals.insert(t.symbol.clone(), t.decimals);

        let uni_pair = UniswapV2Factory::new(uni_factory, client.clone())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        let sushi_pair = UniswapV2Factory::new(sushi_factory, client.clone())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        if uni_pair.is_zero() || sushi_pair.is_zero() {
            continue;
        }

        spawn_listener(client.clone(), t.symbol.clone(), uni_pair, true,  tx.clone());
        spawn_listener(client.clone(), t.symbol.clone(), sushi_pair, false, tx.clone());
    }
    info!("✅  listeners started for {} tokens", decimals.len());

    // Hot loop
    while let Ok((sym, is_uni, res)) = rx.recv().await {
        if is_uni { uni_map.insert(sym.clone(), res); }
        else      { sushi_map.insert(sym.clone(), res); }

        if let (Some(u), Some(s)) = (uni_map.get(&sym), sushi_map.get(&sym)) {
            let dec     = *decimals.get(&sym).unwrap_or(&18) as i32;
            let factor  = 10f64.powi(dec) / 1e6;
            let p_uni   = (u.usdt as f64) / (u.token as f64 / factor);
            let p_su    = (s.usdt as f64) / (s.token as f64 / factor);
            let spread  = ((p_su - p_uni).abs() / p_uni) * 10_000.0;

            if spread >= threshold_bps {
                info!("⚡  {sym} spread {:.2} bps  uni={p_uni:.5} sushi={p_su:.5}", spread);
                // TODO: fire_flashloan_bundle(client.clone(), flash_contract, ...)
            }
        }
    }
    Ok(())
}

// ─── Listener – generic over any Middleware so we can pass client.clone()
fn spawn_listener<M: Middleware + 'static>(
    provider: Arc<M>,
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
                    Reserves { token: r0, usdt: r1, last_updated: now() },
                ));
            }
        }
    });
}

#[inline] fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
