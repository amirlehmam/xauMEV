// SPDX-License-Identifier: MIT
use std::sync::Arc;
use ethers::{prelude::*, contract::abigen};
use ethers::providers::{Provider, Ws, StreamExt};
use std::env;
use tokio::time::{sleep, Duration};
use anyhow::Result;

abigen!(
    UniswapV2Factory,
    r#"[
        function getPair(address tokenA, address tokenB) external view returns (address pair)
    ]"#,
);

abigen!(
    UniswapV2Pair,
    r#"[
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
        function token0()    external view returns (address)
        function token1()    external view returns (address)
    ]"#,
);

#[tokio::main]
async fn main() -> Result<()> {
    // 1) Load config
    dotenv::dotenv().ok();
    let ws_url            = env::var("ETH_WS_URL")?;
    let uni_factory_addr: Address    = env::var("UNISWAP_FACTORY")?.parse()?;
    let sushi_factory_addr: Address  = env::var("SUSHI_FACTORY")?.parse()?;
    let token0_addr: Address         = env::var("TOKEN_0")?.parse()?; // e.g. WETH
    let token1_addr: Address         = env::var("TOKEN_1")?.parse()?; // e.g. USDT
    let threshold_bps: f64           = env::var("SPREAD_THRESHOLD_BPS")?.parse()?; // e.g. 50 = 0.50%

    // 2) Connect WebSocket Provider
    let ws       = Ws::connect(ws_url).await?;
    let provider = Arc::new(Provider::new(ws));

    // 3) Instantiate factories & discover pair addresses
    let uni_factory   = UniswapV2Factory::new(uni_factory_addr, Arc::clone(&provider));
    let sushi_factory = UniswapV2Factory::new(sushi_factory_addr, Arc::clone(&provider));

    let uniswap_pair_addr = uni_factory
        .get_pair(token0_addr, token1_addr)
        .call()
        .await?;
    let sushi_pair_addr = sushi_factory
        .get_pair(token0_addr, token1_addr)
        .call()
        .await?;

    println!("Uniswap V2 pair:  {uniswap_pair_addr}");
    println!("SushiSwap V2 pair: {sushi_pair_addr}");

    // 4) Instantiate pair contracts
    let uni_pair   = UniswapV2Pair::new(uniswap_pair_addr, Arc::clone(&provider));
    let sushi_pair = UniswapV2Pair::new(sushi_pair_addr, Arc::clone(&provider));

    // 5) Subscribe to new block headers
    let mut stream = provider.subscribe_blocks().await?;
    println!("🚀 Scanner started. Listening for opportunities…");

    while let Some(block) = stream.next().await {
        let bn = block.number.unwrap_or_default().as_u64();

        // 6) Fetch reserves & token0 for both pairs concurrently
        let ((u_reserves, uni_t0), (s_reserves, sushi_t0)) = tokio::try_join!(
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

        let (u0, u1, _) = u_reserves;
        let (s0, s1, _) = s_reserves;

        // 7) Map reserves to USDT vs WETH correctly
        // TOKEN_1 = USDT, TOKEN_0 = WETH
        let (uni_usdt_res, uni_weth_res) = if uni_t0 == token1_addr {
            (u0, u1)
        } else {
            (u1, u0)
        };
        let (sushi_usdt_res, sushi_weth_res) = if sushi_t0 == token1_addr {
            (s0, s1)
        } else {
            (s1, s0)
        };

        // 8) Normalize reserves to human floats
        let uni_usdt_f   = uni_usdt_res.as_u128() as f64 / 1e6;  // USDT has 6 decimals
        let uni_weth_f   = uni_weth_res.as_u128() as f64 / 1e18; // WETH has 18 decimals
        let sushi_usdt_f = sushi_usdt_res.as_u128() as f64 / 1e6;
        let sushi_weth_f = sushi_weth_res.as_u128() as f64 / 1e18;

        // 9) Compute price (USDT per WETH)
        let price_uni   = uni_usdt_f / uni_weth_f;
        let price_sushi = sushi_usdt_f / sushi_weth_f;

        // 10) Calculate spread in bps & alert
        let spread_bps = ((price_sushi - price_uni).abs() / price_uni) * 10_000.0;
        if spread_bps > threshold_bps {
            println!(
                "[Block {bn}] Arb detected!\n  • Uni:   {price_uni:.6}\n  • Sushi: {price_sushi:.6}\n  • Spread: {spread_bps:.2} bps\n"
            );
        }

        // Avoid spamming too fast
        sleep(Duration::from_millis(200)).await;
    }

    Ok(())
}
