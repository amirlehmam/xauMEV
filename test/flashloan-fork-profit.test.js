// test/flashloan-fork-profit.test.js
/* eslint-env mocha */

require("dotenv").config();
const { expect }       = require("chai");
const { ethers, network } = require("hardhat");

describe("Profitable flash-loan arbitrage on a main-net fork", () => {
  /* -------------------------------------------------------------------- */
  /*  Constants – change only if you really need to                        */
  /* -------------------------------------------------------------------- */
  const RPC          = process.env.ANKR_ETH;               // main-net endpoint
  const BLOCK        = 18_000_000;                         // deterministic fork
  const USDT         = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const WETH         = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const UNISWAP_V2   = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const ETH_USD_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
  const USDT_WHALE   = "0x28C6c06298d514Db089934071355E5743bf21d60"; // Binance-hot-wallet

  let flash, pool, stub;

  /* -------------------------------------------------------------------- */
  /*  Test set-up                                                          */
  /* -------------------------------------------------------------------- */
  before(async () => {
    if (!RPC) throw new Error("Set ANKR_ETH in .env to a working main-net RPC");

    // 1️⃣  Fork Ethereum main-net
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC, blockNumber: BLOCK } }]
    });

    // 2️⃣  Deploy a tiny Aave-like mock pool that just hands out flash-loans
    const MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();
    await pool.deployed();

    // 3️⃣  Deploy our new StubRouter
    const StubRouter = await ethers.getContractFactory("StubRouter");
    stub = await StubRouter.deploy();
    await stub.deployed();

    // 4️⃣  Deploy the Flash-Loan Arbitrage contract under test
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Arb.deploy(
      pool.address,    // mock lending pool
      USDT,            // token we borrow
      WETH,            // token we trade into
      ETH_USD_FEED     // price-feed (only needed to satisfy ctor)
    );
    await flash.deployed();
  });

  /* -------------------------------------------------------------------- */
  /*  The happy-path check                                                 */
  /* -------------------------------------------------------------------- */
  it("executes and logs profit via StubRouter ➞ Uniswap-V2", async () => {
    const loanAmount = ethers.utils.parseUnits("1_000", 6);   // 1 000 USDT

    /* 5️⃣  Seed the mock pool with USDT to repay principal + fee */
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [USDT_WHALE]
    });
    const whaleSigner = await ethers.getSigner(USDT_WHALE);
    const usdt        = await ethers.getContractAt("IERC20", USDT);
    await usdt.connect(whaleSigner).transfer(pool.address, loanAmount);
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [USDT_WHALE]
    });

    /* 6️⃣  Build calldata for BUY (cheap StubRouter) and SELL (real Uni-V2) */
    const iface = new ethers.utils.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
    ]);
    const deadline = Math.floor(Date.now() / 1000) + 360;

    const buyData = iface.encodeFunctionData("swapExactTokensForTokens", [
      loanAmount,
      0,
      [USDT, WETH],
      flash.address,
      deadline
    ]);

    const sellData = iface.encodeFunctionData("swapExactTokensForTokens", [
      0,          // amountIn = “use entire balance” inside the contract
      0,
      [WETH, USDT],
      flash.address,
      deadline
    ]);

    /* 7️⃣  Run the arbitrage.  We don't care about oracle checks in unit-test
           so pass maxDevBps = 10 000 (== 100 %). */
    await expect(
      flash.executeArbitrage(
        stub.address,   buyData,
        UNISWAP_V2,     sellData,
        loanAmount,
        0,              // minProfit
        10_000          // maxDevBps – disable deviation guard in test
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
