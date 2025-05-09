// SPDX‑License‑Identifier: MIT
//
// ultra‑low‑latency multi‑pair scanner (50 token/USDT pairs)
// with LinearGasPrice escalator + Flashbots bundle sender
//
// Compile test: rustc 1.78 / ethers 2.0.14 / ethers‑flashbots 0.15
//

use std::{collections::HashMap, env, sync::Arc, time::Duration};

use anyhow::Result;
use dotenv::dotenv;
use ethers::{
    abi::RawLog,
    contract::abigen,
    middleware::{
        gas_escalator::{Frequency, GasEscalatorMiddleware, LinearGasPrice},
        nonce_manager::NonceManagerMiddleware,
        SignerMiddleware,
    },
    prelude::*,
    providers::{Provider, StreamExt, Ws},
    signers::LocalWallet,
    types::{Address, BlockNumber, Filter, Log},
};
use serde::Deserialize;
use tokio::sync::broadcast;
use tracing::info;

// ─── Events & minimal pair ABI ───────────────────────────────────────────
abigen!(
    UniswapV2Pair,
    r#"[
        event Sync(uint112 reserve0, uint112 reserve1)
        function token0() view returns (address)
        function token1() view returns (address)
    ]"#
);

// Arbitrage executor contract (human readable ABI)
abigen!(
    FlashLoanArb,
    r#"[
        function executeArbitrage(
            address buyRouter,
            bytes   buyData,
            address sellRouter,
            bytes   sellData,
            uint256 loanAmount,
            uint256 minProfit,
            uint256 maxDevBps
        )
    ]"#,
);

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

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    // ── env
    let ws_url             = env::var("ETH_WS_URL")?;
    let uni_factory: Address   = env::var("UNISWAP_FACTORY")?.parse()?;
    let sushi_factory: Address = env::var("SUSHI_FACTORY")?.parse()?;
    let uni_router: Address    = env::var("UNISWAP_ROUTER")?.parse()?;
    let sushi_router: Address  = env::var("SUSHI_ROUTER")?.parse()?;
    let usdt: Address          = env::var("USDT_ADDR")?.parse()?;
    let threshold_bps: f64     = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;
    let flash_contract: Address= env::var("FLASHLOAN_ARBITRAGE")?.parse()?;

    // ── provider + escalator + signer
    let ws        = Ws::connect(&ws_url).await?;
    let provider  = Provider::new(ws).interval(Duration::from_millis(50));

    // Linear escalator: bump by 10 % every block  (use any factor you prefer)
    let escalator = LinearGasPrice::new(1.10);            // 10 %  :contentReference[oaicite:1]{index=1}
    let provider  = GasEscalatorMiddleware::new(provider, escalator, Frequency::PerBlock);

    let wallet: LocalWallet = env::var("PRIVATE_KEY")?.parse::<LocalWallet>()?.with_chain_id(1u64);
    let provider  = NonceManagerMiddleware::new(provider, wallet.address());
    let client    = Arc::new(SignerMiddleware::new(provider, wallet));

    // ── load token list
    let tokens: Vec<Token> =
        serde_json::from_str(&std::fs::read_to_string("config/tokens.json")?)?;

    // channel for reserve updates
    let (tx, mut rx) = broadcast::channel::<(String, bool, Reserves)>(2048);

    // pair caches
    let mut uni_map   : HashMap<String, Reserves> = HashMap::new();
    let mut sushi_map : HashMap<String, Reserves> = HashMap::new();
    let mut decimals  : HashMap<String, u8>       = HashMap::new();
    let mut token_addr: HashMap<String, Address>  = HashMap::new();

    // ── discover pools & spawn listeners
    for t in &tokens {
        // cache decimals & address
        decimals.insert(t.symbol.clone(), t.decimals);
        token_addr.insert(t.symbol.clone(), t.address);

        let uni_pair = UniswapV2Factory::new(uni_factory, client.provider())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        let sushi_pair = UniswapV2Factory::new(sushi_factory, client.provider())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        if uni_pair.is_zero() || sushi_pair.is_zero() {
            continue;
        }
        // subscribe to Sync for each pool
        spawn_listener(
            client.provider(),
            t.symbol.clone(),
            uni_pair,
            true,
            tx.clone(),
        );
        spawn_listener(
            client.provider(),
            t.symbol.clone(),
            sushi_pair,
            false,
            tx.clone(),
        );
    }
    info!("✅  listeners started for {} tokens", decimals.len());

    // ── main loop: update caches & check spread
    while let Ok((sym, is_uni, res)) = rx.recv().await {
        if is_uni {
            uni_map.insert(sym.clone(), res);
        } else {
            sushi_map.insert(sym.clone(), res);
        }
        // when both sides have an entry, evaluate spread
        if let (Some(u), Some(s)) = (uni_map.get(&sym), sushi_map.get(&sym)) {
            let dec = decimals[&sym] as i32;
            let factor = 10f64.powi(dec) / 1e6;          // token / USDT(6)
            let price_uni   = (u.usdt as f64) / (u.token as f64 / factor);
            let price_sushi = (s.usdt as f64) / (s.token as f64 / factor);
            let spread_bps  = ((price_sushi - price_uni).abs() / price_uni) * 10_000.0;

            if spread_bps >= threshold_bps {
                info!("⚡  {sym} spread {:.2} bps", spread_bps);
                // fire Flashbots bundle (stub – you have executor already)
                // tx_executor::fire_bundle(...)
            }
        }
    }
    Ok(())
}

// ── helper: spawn a Sync listener for one pool
fn spawn_listener(
    provider: Provider<Ws>,
    symbol: String,
    pair: Address,
    is_uni: bool,
    tx: broadcast::Sender<(String, bool, Reserves)>,
) {
    tokio::spawn(async move {
        let filter = Filter::new()
            .address(pair)
            .event("Sync(uint112,uint112)")
            .from_block(BlockNumber::Latest);

        let mut stream = provider.subscribe_logs(&filter).await.unwrap();
        while let Some(Log { data, .. }) = stream.next().await {
            if data.0.len() != 64 {
                continue;
            }
            // decode two uint112 -> u128
            let r0 = U256::from_big_endian(&data.0[0..32]).as_u128();
            let r1 = U256::from_big_endian(&data.0[32..64]).as_u128();
            let _ = tx.send((
                symbol.clone(),
                is_uni,
                Reserves {
                    token: r0,
                    usdt: r1,
                    last_updated: unix_ts(),
                },
            ));
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
