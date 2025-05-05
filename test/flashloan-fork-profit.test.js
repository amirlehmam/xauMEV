// test/flashloan-fork-profit.test.js

const chai   = require("chai");
const waffle = require("ethereum-waffle");
chai.use(waffle.solidity);
const { expect } = chai;

require("dotenv").config();
const { ethers, network } = require("hardhat");

describe("Profitable FlashLoan Arbitrage (MockProfitRouter → UniswapV2)", function() {
  const ANKR_ETH     = process.env.ANKR_ETH;
  if (!ANKR_ETH) throw new Error("Missing ANKR_ETH in .env");

  // Mainnet tokens & routers
  const USDT         = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const WETH         = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const PROFIT_ROUTER= ""; // will be deployed
  const UNISWAP_V2   = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const ETH_USD_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419"; // Chainlink ETH/USD
  const USDT_WHALE   = "0x28C6c06298d514Db089934071355E5743bf21d60";

  let flash, pool, profitRouter;

  before(async () => {
    // 1) Fork mainnet
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: ANKR_ETH, blockNumber: 18_000_000 } }]
    });

    // 2) Deploy MockPool (Aave stub)
    const MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();
    await pool.deployed();

    // 3) Deploy ProfitRouter
    profitRouter = await (await ethers.getContractFactory("MockProfitRouter")).deploy();
    await profitRouter.deployed();

    // 4) Deploy FlashLoanArbitrage pointing at USDT→WETH
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Arb.deploy(pool.address, USDT, WETH, ETH_USD_FEED);
    await flash.deployed();
  });

  it("performs a profitable arbitrage via MockProfitRouter -> UniswapV2", async () => {
    const loanAmount = ethers.utils.parseUnits("1000", 6); // 1 000 USDT

    // 5) Seed pool by impersonating USDT whale
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [USDT_WHALE]
    });
    const whale = await ethers.getSigner(USDT_WHALE);
    const usdt  = await ethers.getContractAt("IERC20", USDT);
    await usdt.connect(whale).transfer(pool.address, loanAmount);
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [USDT_WHALE]
    });

    // 6) Build buy & sell calldata
    const iface = new ethers.utils.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
    ]);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // buy: USDT -> WETH on profitRouter (2×)
    const buyData = iface.encodeFunctionData("swapExactTokensForTokens", [
      loanAmount, 0, [USDT, WETH], flash.address, deadline
    ]);

    // determine WETH out from profitRouter (should be loanAmount*2)
    const [ , wethOut ] = await profitRouter.getAmountsOut(loanAmount, [USDT, WETH]);

    // sell: WETH -> USDT on Uniswap V2
    const sellData = iface.encodeFunctionData("swapExactTokensForTokens", [
      wethOut, 0, [WETH, USDT], flash.address, deadline
    ]);

    // 7) Execute arbitrage: set minProfit=0, maxDevBps=10000 to skip oracle check
    await expect(
      flash.executeArbitrage(
        profitRouter.address, buyData,
        UNISWAP_V2,          sellData,
        loanAmount,
        0,      // minProfit
        10_000  // maxDevBps = 100%
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
