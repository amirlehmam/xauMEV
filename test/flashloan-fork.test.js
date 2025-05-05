// test/flashloan-fork.test.js
/* eslint-env mocha */
require("dotenv").config();
const { expect }           = require("chai");
const { ethers, network }  = require("hardhat");

describe("Flash-loan arbitrage on a mainnet fork (Uniswap V3)", () => {
  /* ——— RPC endpoint from .env ——— */
  const RPC = process.env.ANKR_ETH;
  if (!RPC) throw new Error("Fill ANKR_ETH in .env");

  /* ——— Main-net constants (lowercase = skip checksum) ——— */
  const USDT  = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const XAUT  = "0x68749665ff8d2d112fa859aa293f07a622782f38";
  const SWAP  = "0xe592427a0aece92de3edee1f18e0157c05861564";  // SwapRouter V3
  const FEED  = "0x214ed9da11d2fbe465a6fc601a91e62ebec1a0d6";  // Chainlink XAU/USD
  const WHALE = "0x28c6c06298d514db089934071355e5743bf21d60";  // USDT whale
  const FEE   = 10_000;   // 1 % tier — pool exists at block 18 000 000

  let flash, poolStub;

  /* —————————————————  Set-up fork and contracts  ————————————————— */
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: { jsonRpcUrl: RPC, blockNumber: 18_000_000 }
      }]
    });

    /* Stub flash-loan pool */
    const MockPool = await ethers.getContractFactory("MockPool");
    poolStub = await MockPool.deploy();
    await poolStub.deployed();

    /* Flash-loan arbitrage contract */
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Arb.deploy(poolStub.address, USDT, XAUT, FEED);
    await flash.deployed();
  });

  /* ————————————————————  Main happy-path test  ———————————————————— */
  it("executes USDT ⇆ XAUT round-trip via SwapRouter exactInputSingle", async () => {
    const loan = ethers.utils.parseUnits("1000", 6);     // 1 000 USDT

    /* seed the stub pool with USDT (impersonate whale) */
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [WHALE]
    });
    const whale = await ethers.getSigner(WHALE);
    try {
      const usdt = await ethers.getContractAt("IERC20", USDT);
      await usdt.connect(whale).transfer(poolStub.address, loan);
    } finally {
      // Hardhat ≥ 2.20 n’a plus stopImpersonate, on ignore l’erreur
      await network.provider.request({
        method: "hardhat_stopImpersonateAccount",
        params: [WHALE]
      }).catch(() => {});
    }

    /* ABI with **field names** so we can pass an object */
    const iface = new ethers.utils.Interface([
      `function exactInputSingle((
          address tokenIn,
          address tokenOut,
          uint24  fee,
          address recipient,
          uint256 deadline,
          uint256 amountIn,
          uint256 amountOutMinimum,
          uint160 sqrtPriceLimitX96
        )) returns (uint256)`
    ]);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    /* BUY  USDT → XAUT */
    const buy = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  USDT,
      tokenOut: XAUT,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  loan,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    /* SELL XAUT → USDT  (on test, we juste revendent la même quantité) */
    const sell = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  XAUT,
      tokenOut: USDT,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  loan,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    /* Execute flash-loan + dual swap */
    await expect(
      flash.executeArbitrage(
        SWAP, buy,
        SWAP, sell,
        loan,
        0,        // no minProfit for unit-test
        3_000     // 30 % max deviation
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
