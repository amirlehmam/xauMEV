// SPDX-License-Identifier: MIT
//
// ultra‑low‑latency multi‑pair scanner + Flashbots sender
//

use std::{collections::HashMap, env, sync::Arc, time::Duration};

use anyhow::Result;
use dotenv::dotenv;
use ethers::{
    abi::RawLog,
    contract::{abigen, Multicall},
    middleware::{
        gas_escalator::{Frequency, GasEscalatorMiddleware, Percent},
        nonce_manager::NonceManagerMiddleware,
        SignerMiddleware,
    },
    prelude::*,
    providers::{Provider, StreamExt, Ws},
    signers::LocalWallet,
    types::{Address, BlockNumber, Filter, Log, U256},
};
use serde::Deserialize;
use tokio::{sync::broadcast, time::sleep};
use tracing::{info, warn};

abigen!(
    UniswapV2Pair,
    r#"[
        event Sync(uint112 reserve0, uint112 reserve1)
        function getReserves() view returns (uint112,uint112,uint32)
        function token0() view returns (address)
        function token1() view returns (address)
    ]"#,
);

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
        ) external
    ]"#,
);

#[derive(Debug, Deserialize)]
struct Token {
    symbol: String,
    address: Address,
    decimals: u8,
}

// reserve snapshot
#[derive(Clone, Copy)]
struct Reserves {
    token: u128,
    usdt:  u128,
    last_updated: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();

    // ── logging
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // ── env
    let ws_url             = env::var("ETH_WS_URL")?;
    let uni_router: Address= env::var("UNISWAP_ROUTER")?.parse()?;
    let sushi_router:Address= env::var("SUSHI_ROUTER")?.parse()?;
    let arb_contract:Address= env::var("FLASHLOAN_ARBITRAGE")?.parse()?;
    let usdt: Address      = env::var("USDT_ADDR")?.parse()?;
    let threshold_bps: u32 = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;

    let wallet: LocalWallet = env::var("PRIVATE_KEY")?.parse::<LocalWallet>()?
        .with_chain_id(1u64);

    // ── provider & middlewares
    let ws = Ws::connect(&ws_url).await?;
    let provider = Provider::new(ws).interval(Duration::from_millis(50));
    let escalator = GasEscalatorMiddleware::new(provider, Frequency::PerBlock, Percent::new(15));
    let nm        = NonceManagerMiddleware::new(escalator, wallet.address());
    let signer    = SignerMiddleware::new(nm, wallet.clone());
    let client    = Arc::new(signer);

    // ── load tokens & build pair map
    let tokens: Vec<Token> = serde_json::from_str(
        &std::fs::read_to_string("config/tokens.json")?
    )?;
    let mut pairs: HashMap<Address, (String, Address/*router marker*/)> = HashMap::new();

    // Channel: (pair address, reserves, is_uni)
    let (tx, mut rx) = broadcast::channel::<(Address, Reserves, bool)>(1024);

    // ── Spawn WS listeners (Sync events) for every pool
    for t in &tokens {
        for &(router, is_uni) in &[ (uni_router, true), (sushi_router, false) ] {
            let pair_addr = pair_for(router, t.address, usdt).await?;
            let provider = client.provider();
            spawn_listener(
                provider.clone(),
                pair_addr,
                tx.clone(),
                is_uni
            );
            pairs.insert(pair_addr, (t.symbol.clone(), if is_uni {uni_router} else {sushi_router}));
        }
    }
    info!("synced {} pools", pairs.len());

    // ── reserve cache  {pair -> Reserves}
    let mut uni_cache : HashMap<Address, Reserves> = HashMap::new();
    let mut sushi_cache: HashMap<Address, Reserves> = HashMap::new();

    // ── main analytic loop
    while let Ok((pair, res, is_uni)) = rx.recv().await {
        let cache = if is_uni { &mut uni_cache } else { &mut sushi_cache };
        cache.insert(pair, res);

        // Only act when we have both sides
        if let (Some(u), Some(s)) = (uni_cache.get(&pair), sushi_cache.get(&pair)) {
            let (sym, _) = &pairs[&pair];
            let price_uni   = u.usdt as f64 / u.token as f64;
            let price_sushi = s.usdt as f64 / s.token as f64;
            let spread_bps  = ((price_sushi - price_uni).abs() / price_uni * 10_000.0) as u32;

            if spread_bps >= threshold_bps {
                info!("⚡ {sym}  spread={spread_bps} bps");

                let _ = tokio::spawn(fire_bundle(
                    client.clone(),
                    arb_contract,
                    uni_router,
                    sushi_router,
                    t.address,
                    usdt,
                    spread_bps,
                ));
            }
        }
    }
    Ok(())
}

/// Calculates pair address off‑chain from factory + tokens (k‑0 bool swap)
async fn pair_for(_router: Address, token: Address, quote: Address) -> Result<Address> {
    // omitted: use CREATE2 formula with known Init Code Hash
    todo!()
}

/// Listener task to stream Sync events
fn spawn_listener<P: JsonRpcClient + 'static>(
    provider: Provider<P>,
    pair: Address,
    tx: broadcast::Sender<(Address, Reserves, bool)>,
    is_uni: bool,
) {
    tokio::spawn(async move {
        let filt = Filter::new()
            .address(pair)
            .event("Sync(uint112,uint112)")
            .from_block(BlockNumber::Latest);
        let mut stream = provider.subscribe_logs(&filt).await.unwrap();
        while let Some(Log { topics, data, ..}) = stream.next().await {
            // quick decode (manual because fixed types)
            let raw = RawLog {topics, data};
            if let Ok((r0, r1)) = decode_sync(raw) {
                let res = Reserves {
                    token: r0 as u128,
                    usdt:  r1 as u128,
                    last_updated: unix_ts(),
                };
                let _ = tx.send((pair, res, is_uni));
            }
        }
    });
}

fn decode_sync(raw: RawLog) -> Result<(u112, u112)> {
    // use abi::decode, omitted for brevity
    todo!()
}

async fn fire_bundle<M: Middleware + 'static>(
    client: Arc<M>,
    arb_contract: Address,
    buy_router: Address,
    sell_router: Address,
    token: Address,
    usdt: Address,
    _spread_bps: u32,
) -> Result<()> {
    // Build calldata → same as previous answer (encode_swap + FlashLoanArb)
    // but wrap in Flashbots bundle & send
    // use ethers_flashbots::BundleRequest::new()
    Ok(())
}

#[inline] fn unix_ts() -> u64 { 
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() 
}
