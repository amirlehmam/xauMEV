// SPDX‑License‑Identifier: MIT
//! Streaming price scanner *plus* flash‑loan trigger.
//!
//! • Still uses your existing Uniswap/Sushi reserve logic
//! • When spread > THRESHOLD_BPS it calls `tx_executor::fire`

use std::{env, sync::Arc};

use anyhow::Result;
use dotenv::dotenv;
use ethers::{
    contract::abigen,
    prelude::*,
    providers::{Provider, StreamExt, Ws},
    types::Address,
};
use tokio::time::{sleep, Duration};

mod tx_executor; // ← our new hot‑path module

// ── ABI bindings (unchanged from your file)
abigen!(
    UniswapV2Factory,
    r#"[function getPair(address tokenA, address tokenB) external view returns (address)]"#,
);
abigen!(
    UniswapV2Pair,
    r#"[function getReserves() external view returns (uint112,uint112,uint32)
       function token0() external view returns (address)
       function token1() external view returns (address)]"#,
);

#[tokio::main]
async fn main() -> Result<()> {
    // ───────────────────────────────────────────────────────────
    // 1. Load environment
    dotenv().ok();
    let ws_url            = env::var("ETH_WS_URL")?;          // WebSocket RPC
    let uni_factory_addr: Address    = env::var("UNISWAP_FACTORY")?.parse()?;
    let sushi_factory_addr: Address  = env::var("SUSHI_FACTORY")?.parse()?;
    let token0_addr: Address         = env::var("TOKEN_0")?.parse()?; // e.g. WETH
    let token1_addr: Address         = env::var("TOKEN_1")?.parse()?; // e.g. USDT
    let threshold_bps: f64           = env::var("SPREAD_THRESHOLD_BPS")?.parse()?;

    //   Flash‑loan‑related addresses
    let arb_contract: Address = env::var("FLASHLOAN_ARBITRAGE")?.parse()?;
    let buy_router:  Address  = env::var("UNISWAP_ROUTER")?.parse()?;   // buy‑low
    let sell_router: Address  = env::var("SUSHI_ROUTER")?.parse()?;     // sell‑high

    // ───────────────────────────────────────────────────────────
    // 2. Connect provider
    let ws       = Ws::connect(&ws_url).await?;
    let provider = Arc::new(Provider::new(ws));

    // 3. Get pair addresses
    let uni_pair_addr = UniswapV2Factory::new(uni_factory_addr, provider.clone())
        .get_pair(token0_addr, token1_addr)
        .call()
        .await?;
    let sushi_pair_addr = UniswapV2Factory::new(sushi_factory_addr, provider.clone())
        .get_pair(token0_addr, token1_addr)
        .call()
        .await?;

    println!("Uniswap pair  : {uni_pair_addr}");
    println!("SushiSwap pair: {sushi_pair_addr}");

    let uni_pair   = UniswapV2Pair::new(uni_pair_addr, provider.clone());
    let sushi_pair = UniswapV2Pair::new(sushi_pair_addr, provider.clone());

    // 4. Stream blocks
    let mut blocks = provider.subscribe_blocks().await?;
    println!("🚀  Scanner running …");

    while let Some(block) = blocks.next().await {
        let bn = block.number.unwrap_or_default().as_u64();

        // 5. Fetch reserves concurrently
        let ((u_res, uni_t0), (s_res, sushi_t0)) = tokio::try_join!(
            async {
                let res = uni_pair.get_reserves().call().await?;
                let t0  = uni_pair.token_0().call().await?;
                Ok::<_, ContractError<Provider<Ws>>>((res, t0))
            },
            async {
                let res = sushi_pair.get_reserves().call().await?;
                let t0  = sushi_pair.token_0().call().await?;
                Ok::<_, ContractError<Provider<Ws>>>((res, t0))
            }
        )?;

        let (u0, u1, _) = u_res;
        let (s0, s1, _) = s_res;

        // 6. Align reserves (USDT has 6 dec, WETH 18 dec)
        let (uni_usdt, uni_weth)   = if uni_t0 == token1_addr { (u0, u1) } else { (u1, u0) };
        let (sushi_usdt, sushi_weth) = if sushi_t0 == token1_addr { (s0, s1) } else { (s1, s0) };

        let price_uni   = (uni_usdt as f64 / 1e6)  / (uni_weth as f64 / 1e18);
        let price_sushi = (sushi_usdt as f64 / 1e6) / (sushi_weth as f64 / 1e18);
        let spread_bps  = ((price_sushi - price_uni).abs() / price_uni) * 10_000.0;

        if spread_bps > threshold_bps {
            println!(
                "[Block {bn}] ⚡ Arb!  uni={price_uni:.6}  sushi={price_sushi:.6}  spread={spread_bps:.2} bps"
            );

            // 7. Spawn flash‑loan executor (non‑blocking)
            //    Convert to u32; cap to avoid f64‑>u32 overflow.
            let _ = tokio::spawn(tx_executor::fire(
                &ws_url,
                arb_contract,
                buy_router,
                sell_router,
                token1_addr,   // USDT
                token0_addr,   // WETH/XAUT (same direction as encode_swap)
                spread_bps.min(u32::MAX as f64) as u32,
            ));
        }

        sleep(Duration::from_millis(200)).await; // throttle log spam
    }
    Ok(())
}
