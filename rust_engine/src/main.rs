// SPDX‑License‑Identifier: MIT
//
// Lightning‑fast Uniswap/Sushi scanner with Flashbots bundle sender.
// Works with:  ethers 2.0.14  •  ethers‑flashbots 0.15
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
    providers::{Provider, StreamExt, Ws},
    signers::LocalWallet,
    types::{Address, BlockNumber, Filter, Log, U256},
};
use serde::Deserialize;
use tokio::sync::broadcast;
use tracing::info;

// ── Minimal ABI bindings ────────────────────────────────────────────────
abigen!(
    UniswapV2Factory,
    r#"[function getPair(address,address) view returns (address)]"#,
);

abigen!(
    FlashLoanArb,
    r#"[function executeArbitrage(address,bytes,address,bytes,uint256,uint256,uint256)]"#,
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
    // .env + logger
    dotenv().ok();
    tracing_subscriber::fmt().with_env_filter("info").init();

    // ── ENV vars
    let ws_url              = env::var("ETH_WS_URL")?;
    let uni_factory: Address   = env::var("UNISWAP_FACTORY")?.parse()?;
    let sushi_factory: Address = env::var("SUSHI_FACTORY")?.parse()?;
    let uni_router: Address    = env::var("UNISWAP_ROUTER")?.parse()?;
    let sushi_router: Address  = env::var("SUSHI_ROUTER")?.parse()?;
    let usdt: Address          = env::var("USDT_ADDR")?.parse()?;
    let threshold_bps: f64     = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;
    let flash_contract: Address= env::var("FLASHLOAN_ARBITRAGE")?.parse()?;

    // ── Base WebSocket provider (PubsubClient)
    let ws         = Ws::connect(&ws_url).await?;
    let base_prov  = Provider::new(ws).interval(Duration::from_millis(50));
    let arc_base   = Arc::new(base_prov.clone()); // for listeners & getPair

    // ── Gas‑escalated signing client
    let ggp     = GeometricGasPrice::new(1.125, 50_000_000_000u64, 60u64); // 50 gwei start, +12.5 %/block, 1 min horizon
    let escal   = GasEscalatorMiddleware::new(base_prov, ggp, Frequency::PerBlock);

    let wallet: LocalWallet = env::var("PRIVATE_KEY")?.parse::<LocalWallet>()?.with_chain_id(1u64);
    let signer  = SignerMiddleware::new(escal, wallet);
    let client  = Arc::new(NonceManagerMiddleware::new(signer, wallet.address()));

    // ── Load watch‑list
    let tokens: Vec<Token> =
        serde_json::from_str(&std::fs::read_to_string("config/tokens.json")?)?;

    // Broadcast channel for reserve updates
    let (tx, mut rx) = broadcast::channel::<(String, bool, Reserves)>(2048);

    // Caches
    let mut uni_map   : HashMap<String, Reserves> = HashMap::new();
    let mut sushi_map : HashMap<String, Reserves> = HashMap::new();
    let mut decimals  : HashMap<String, u8>       = HashMap::new();
    let mut addr_map  : HashMap<String, Address>  = HashMap::new();

    // ── Discover pools & spawn listeners
    for t in &tokens {
        decimals.insert(t.symbol.clone(), t.decimals);
        addr_map.insert(t.symbol.clone(), t.address);

        let uni_pair = UniswapV2Factory::new(uni_factory, arc_base.clone())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        let sushi_pair = UniswapV2Factory::new(sushi_factory, arc_base.clone())
            .get_pair(t.address, usdt)
            .call()
            .await?;
        if uni_pair.is_zero() || sushi_pair.is_zero() { continue; }

        spawn_listener(arc_base.clone(), t.symbol.clone(), uni_pair,  true,  tx.clone());
        spawn_listener(arc_base.clone(), t.symbol.clone(), sushi_pair,false, tx.clone());
    }
    info!("✅  listeners running for {} tokens", decimals.len());

    // ── Hot loop
    while let Ok((sym, is_uni, res)) = rx.recv().await {
        if is_uni { uni_map.insert(sym.clone(), res); } else { sushi_map.insert(sym.clone(), res); }

        if let (Some(u), Some(s)) = (uni_map.get(&sym), sushi_map.get(&sym)) {
            let dec   = *decimals.get(&sym).unwrap_or(&18) as i32;
            let factor= 10f64.powi(dec) / 1e6;
            let p_u   = (u.usdt as f64) / (u.token as f64 / factor);
            let p_s   = (s.usdt as f64) / (s.token as f64 / factor);
            let spread= ((p_s - p_u).abs() / p_u) * 10_000.0;

            if spread >= threshold_bps {
                info!("⚡  {sym:>6} spread {spread:.2} bps  uni={p_u:.5} sushi={p_s:.5}");
                // TODO: craft calldata + Flashbots bundle -> fire
                // fire_bundle(client.clone(), flash_contract, uni_router, sushi_router, addr_map[&sym], usdt, ...)
            }
        }
    }
    Ok(())
}

// ── Listener: Arc<Provider<Ws>> to satisfy PubsubClient bound
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
