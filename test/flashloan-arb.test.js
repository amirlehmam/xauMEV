// test/flashloan-arb.test.js — main‑net fork, flash‑loan USDC vs USDT on Uni V3 (stable‑stable pool)

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

/* ----------------------------------------------------------------------
   Main‑net constants
   ---------------------------------------------------------------------- */
const POOL_ADDR       = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"; // Aave V3 pool
const USDC_ADDR       = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC (6 dec, flash‑loan OK)
const USDT_ADDR       = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // USDT (6 dec)
const FEED_ADDR       = "0x3e7d1eab13ad0104d2750b8863b489d65364e32d"; // Chainlink USDT/USD (8 dec)

const V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";  // SwapRouter02
const V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";  // Quoter V2
const FEE_TIER  = 100;  // 0.01 % pool for USDC/USDT

/* ---------------------------------------------------------------------- */
describe("FlashLoanArbitrage on Mainnet Fork", function () {
  let flashArb, owner;

  const loanAmount = ethers.utils.parseUnits("3000", 6); // 3 000 USDC
  const minProfit  = ethers.utils.parseUnits("0", 6);    // accept any non‑negative profit
  const maxDevBps  = 500;                                 // 5 % oracle dev guard

  /* -------------------------- Fork reset -------------------------- */
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: process.env.ANKR_ETH,
          blockNumber: 18_000_000
        }
      }]
    });

    [owner] = await ethers.getSigners();

    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flashArb = await Arb.deploy(
      POOL_ADDR,
      USDC_ADDR,  // loan asset
      USDT_ADDR,  // counter asset held in XAUT slot
      FEED_ADDR
    );
    await flashArb.deployed();
  });

  it("performs a flash‑loan + buy‑low/sell‑high on Uniswap V3", async function () {
    // 1. On‑chain quote USDC -> USDT
    const quoter = new ethers.Contract(
      V3_QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"],
      owner
    );

    const usdtOut = await quoter.callStatic.quoteExactInputSingle(
      USDC_ADDR,
      USDT_ADDR,
      FEE_TIER,
      loanAmount,
      0
    );

    // 2. Build calldata for exactInputSingle both directions
    const iface = new ethers.utils.Interface([
      "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) external returns (uint256)"
    ]);

    const deadline = Math.floor(Date.now() / 1e3) + 1800;

    const buyData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  USDC_ADDR,
      tokenOut: USDT_ADDR,
      fee:      FEE_TIER,
      recipient: flashArb.address,
      deadline,
      amountIn:  loanAmount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    const sellData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  USDT_ADDR,
      tokenOut: USDC_ADDR,
      fee:      FEE_TIER,
      recipient: flashArb.address,
      deadline,
      amountIn:  usdtOut,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    // 3. Execute flash‑loan arbitrage
    await expect(
      flashArb.connect(owner).executeArbitrage(
        V3_ROUTER, buyData,
        V3_ROUTER, sellData,
        loanAmount,
        minProfit,
        maxDevBps
      )
    ).to.emit(flashArb, "ArbitrageExecuted");
  });
});
