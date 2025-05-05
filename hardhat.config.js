// test/flashloan-fork.test.js
require("dotenv").config();              // load ANKR_ETH from .env
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Mainnet-Fork: XAUT/USDT on Uniswap V2", function() {
  const ANKR_ETH = process.env.ANKR_ETH;
  if (!ANKR_ETH) throw new Error("⛔️ Missing ANKR_ETH in .env");

  // Real mainnet addresses
  const USDT       = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const XAUT       = "0x68749665FF8D2d112Fa859AA293F07A622782F38";
  const UNIV2      = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const PRICE_FEED = "0x214eD9Da11D2fbe465a6fc601a91e62EbEc1a0D6";

  // A known USDT whale (e.g. Binance hot wallet)
  const USDT_WHALE = "0x28C6c06298d514Db089934071355E5743bf21d60";

  let flash, pool, MockPool, FlashLoanArb;

  before(async () => {
    // 1) Reset & fork to mainnet at a fixed block
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: ANKR_ETH,
          blockNumber: 18_000_000
        }
      }]
    });

    // 2) Deploy our MockPool (stub for Aave V3)
    MockPool = await ethers.getContractFactory("MockPool");
    pool     = await MockPool.deploy();
    await pool.deployed();

    // 3) Deploy the flash-loan arbitrage contract
    FlashLoanArb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await FlashLoanArb.deploy(
      pool.address,
      USDT,
      XAUT,
      PRICE_FEED
    );
    await flash.deployed();
  });

  it("reads the live XAUT/USDT price on Uniswap V2", async () => {
    const router = new ethers.Contract(
      UNIV2,
      ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
      ethers.provider
    );

    const amtIn   = ethers.utils.parseUnits("1", 6);              // 1 USDT
    const [ , xautOut ] = await router.getAmountsOut(amtIn, [USDT, XAUT]);
    const price   = ethers.utils.formatUnits(xautOut, 6);

    console.log(`🔍 XAUT/USDT on Uniswap V2: ${price}`);
    expect(parseFloat(price)).to.be.greaterThan(0);
  });

  it("executes flash loan arbitrage logic using real liquidity & oracle", async () => {
    const loanAmt = ethers.utils.parseUnits("10", 6); // 10 USDT

    // ── Impersonate USDT whale to fund our MockPool ─────
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [USDT_WHALE]
    });
    const whale = await ethers.getSigner(USDT_WHALE);
    const usdt  = await ethers.getContractAt("IERC20", USDT);

    // Transfer 10 USDT to pool.address so flashLoanSimple can lend it
    await usdt.connect(whale).transfer(pool.address, loanAmt);
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [USDT_WHALE]
    });

    // ── Build Uniswap V2 swap calldatas ──────────────────
    const uniIface = new ethers.utils.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
    ]);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // 1) Compute how much XAUT we'd get for 10 USDT
    const router = new ethers.Contract(
      UNIV2,
      ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
      ethers.provider
    );
    const [ , xautAmount ] = await router.getAmountsOut(loanAmt, [USDT, XAUT]);

    // 2) Encode buy (USDT→XAUT) & sell (XAUT→USDT)
    const buyData  = uniIface.encodeFunctionData("swapExactTokensForTokens", [
      loanAmt,         // amountIn
      0,               // amountOutMin
      [USDT, XAUT],    // path
      flash.address,   // to
      deadline
    ]);
    const sellData = uniIface.encodeFunctionData("swapExactTokensForTokens", [
      xautAmount,      // amountIn (the exact XAUT we expect)
      0,               // amountOutMin
      [XAUT, USDT],    // path
      flash.address,   // to
      deadline
    ]);

    // ── Call the arbitrage entrypoint ─────────────────────
    await expect(
      flash.executeArbitrage(
        UNIV2,
        buyData,
        UNIV2,
        sellData,
        loanAmt,
        0,      // minProfit = 0 for test
        1000    // maxDevBps tolerance
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
