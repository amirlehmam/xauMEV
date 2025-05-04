const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// **Real addresses on Ethereum mainnet**
const POOL_ADDR          = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";    // Aave V3 Pool :contentReference[oaicite:13]{index=13}
const USDT_ADDR          = "0xdAC17F958D2ee523a2206206994597C13D831ec7";    // USDT (6 decimals)
const XAUT_ADDR          = "0x68749665FF8D2d112Fa859AA293F07A622782F38";  // XAUT :contentReference[oaicite:14]{index=14}
const PRICE_FEED_ADDR    = "0x214eD9Da11D2fbe465a6fc601a91e62EbEc1a0D6";  // Chainlink XAU/USD :contentReference[oaicite:15]{index=15}
const UNISWAP_ROUTER     = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";  // Uniswap V2 Router02 :contentReference[oaicite:16]{index=16}

describe("FlashLoanArbitrage on Mainnet Fork", function () {
  let flashArb, owner;
  before(async () => {
    // ensure we’re forking fresh at a known block
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          url: process.env.ANKR_ETH,
          blockNumber: 18_000_000
        }
      }]
    });

    [owner] = await ethers.getSigners();

    // deploy your arbitrage contract into the fork
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flashArb = await Arb.deploy(
      POOL_ADDR,
      USDT_ADDR,
      XAUT_ADDR,
      PRICE_FEED_ADDR
    );
    await flashArb.deployed();
  });

  it("performs a flash loan + buy-low/sell-high on Uniswap V2", async function () {
    const loanAmount = ethers.utils.parseUnits("5000", 6);
    const minProfit   = ethers.utils.parseUnits("10", 6);
    const maxDevBps   = 50; // 0.5%

    // Build Uniswap V2 calldata for USDT→XAUT (buy low)
    const uni = new ethers.Contract(
      UNISWAP_ROUTER,
      [
        "function getAmountsOut(uint256, address[]) view returns (uint256[])",
        "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
      ],
      owner
    );

    // 1) Pre-approve USDT to router
    const usdt = await ethers.getContractAt("IERC20", USDT_ADDR);
    await usdt.connect(owner).approve(UNISWAP_ROUTER, loanAmount);

    // 2) Encode buy swap
    const pathBuy = [USDT_ADDR, XAUT_ADDR];
    const buyCalldata = uni.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [
        loanAmount,
        0,
        pathBuy,
        flashArb.address,
        Math.floor(Date.now()/1000) + 300
      ]
    );

    // 3) We won’t know exact XAUT out until runtime—Aave callback will handle that.

    // 4) Call the flash-loan entrypoint
    await expect(
      flashArb.connect(owner).executeArbitrage(
        UNISWAP_ROUTER, buyCalldata,
        UNISWAP_ROUTER, buyCalldata, // (for demo, same path reversed in callback)
        loanAmount,
        minProfit,
        maxDevBps
      )
    ).to.emit(flashArb, "ArbitrageExecuted");
  });
});
