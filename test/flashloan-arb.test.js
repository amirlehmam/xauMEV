/* test/flashloan-arb.test.js */
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// --------  Main‑net addresses  --------
const POOL_ADDR       = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"; // Aave V3 pool
const USDT_ADDR       = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // 6‑dec
const XAUT_ADDR       = "0x68749665FF8D2d112Fa859AA293F07A622782F38"; // 6‑dec
const PRICE_FEED_ADDR = "0x214ed9dc11d2fbe465a6fc601a91e62ebec1a0d6"; // Chainlink XAU/USD
const UNISWAP_ROUTER  = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2

describe("FlashLoanArbitrage on Mainnet Fork", function () {
  let flashArb;
  let owner;

  before(async () => {
    /** reset the fork at a deterministic block */
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ANKR_ETH,  // <<< MUST be jsonRpcUrl
            blockNumber: 18_000_000
          }
        }
      ]
    });

    [owner] = await ethers.getSigners();

    /** deploy the arbitrage contract into the fork */
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flashArb  = await Arb.deploy(
      POOL_ADDR,
      USDT_ADDR,
      XAUT_ADDR,
      PRICE_FEED_ADDR
    );
    await flashArb.deployed();
  });

  it("performs a flash‑loan + buy‑low/sell‑high on Uniswap V2", async function () {
    const loanAmount = ethers.utils.parseUnits("5_000", 6);   // 5 000 USDT
    const minProfit  = ethers.utils.parseUnits("1", 6);       // ≥ 1 USDT
    const maxDevBps  = 100;                                   // 1 %

    // ------------- Build swap calldata -----------------
    const uni = new ethers.Contract(
      UNISWAP_ROUTER,
      [
        "function getAmountsOut(uint256,address[]) view returns (uint256[])",
        "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
      ],
      owner
    );

    /** path USDT → XAUT */
    const pathBuy = [USDT_ADDR, XAUT_ADDR];

    // estimate the XAUT we will receive for 5 000 USDT
    const amounts = await uni.getAmountsOut(loanAmount, pathBuy);
    const xautOut = amounts[1];

    // ----- calldata for USDT → XAUT (buy) -----
    const buyCalldata = uni.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [
        loanAmount,                 // amountIn (USDT)
        0,                          // amountOutMin
        pathBuy,
        flashArb.address,           // recipient = our contract
        Math.floor(Date.now() / 1000) + 300
      ]
    );

    // ----- calldata for XAUT → USDT (sell) -----
    const pathSell  = [XAUT_ADDR, USDT_ADDR];
    const sellCalldata = uni.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [
        xautOut,                    // amountIn (XAUT we expect to hold)
        0,                          // amountOutMin
        pathSell,
        flashArb.address,
        Math.floor(Date.now() / 1000) + 300
      ]
    );

    // ------------- Trigger the flash‑loan ---------------
    await expect(
      flashArb.connect(owner).executeArbitrage(
        UNISWAP_ROUTER, buyCalldata,
        UNISWAP_ROUTER, sellCalldata,
        loanAmount,
        minProfit,
        maxDevBps
      )
    ).to.emit(flashArb, "ArbitrageExecuted");
  });
});
