// SPDX-License-Identifier: MIT
use ethers::prelude::*;                  // Ethers-rs prelude :contentReference[oaicite:6]{index=6}
use ethers::providers::{Provider, Ws, StreamExt};
use ethers::contract::abigen;
use std::convert::TryFrom;
use std::env;
use tokio::time::{sleep, Duration};

abigen!(
    UniswapV2Pair,
    r#"[
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32)
    ]"#,
);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1) Load config from .env
    dotenv::dotenv().ok();
    let ws_url = env::var("ETH_WS_URL")?;
    let uniswap_pair: Address = env::var("UNISWAP_PAIR")?.parse()?;
    let sushi_pair:   Address = env::var("SUSHI_PAIR")?.parse()?;
    let threshold_bps: u128 = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;  // e.g. 50 → 0.5%

    // 2) Create WebSocket provider for real-time subscriptions :contentReference[oaicite:7]{index=7}
    let ws = Ws::connect(ws_url).await?;
    let provider = Provider::new(ws);

    // 3) Instantiate pair contracts :contentReference[oaicite:8]{index=8}
    let uni = UniswapV2Pair::new(uniswap_pair, provider.clone());
    let sushi = UniswapV2Pair::new(sushi_pair, provider.clone());

    // 4) Subscribe to new block headers for per-block scanning :contentReference[oaicite:9]{index=9}
    let mut stream = provider.subscribe_blocks().await?;

    println!("🚀 Scanner started, waiting for new blocks…");
    while let Some(block) = stream.next().await {
        let block_number = block.number.unwrap_or_default().as_u64();
        // 5) Fetch reserves concurrently
        let (u_res, s_res) = tokio::try_join!(
            uni.get_reserves(),
            sushi.get_reserves()
        )?;

        // Uniswap reserves: (reserve0, reserve1)
        let (u0, u1, _) = u_res;
        let (s0, s1, _) = s_res;

        // 6) Compute prices: price = reserve1/reserve0 (assuming token0=XAUT, token1=USDT)
        let price_uni = u1 as f64 / u0 as f64;
        let price_sushi = s1 as f64 / s0 as f64;

        // 7) Check for spread opportunity
        let spread = (price_sushi - price_uni).abs() / price_uni * 10_000.0;  // in BPS
        if spread > threshold_bps as f64 {
            println!(
                "[Block {}] Arb detected! Uniswap: {:.6}, Sushi: {:.6}, Spread: {:.2} bps",
                block_number, price_uni, price_sushi, spread
            );
        }
        // Throttle loop in case WS pushes too fast
        sleep(Duration::from_millis(200)).await;
    }

    Ok(())
}
