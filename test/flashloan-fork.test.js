/* eslint-env mocha */
require("dotenv").config();
require("@nomicfoundation/hardhat-chai-matchers");      // adds .emit/.reverted

const { expect }          = require("chai");
const { ethers, network } = require("hardhat");

describe("Flash-loan arbitrage on a main-net fork (USDT ⇆ WETH, Uni-V3)", () => {
  /*—————————— RPC ——————————*/
  const RPC = process.env.ANKR_ETH;
  if (!RPC) throw new Error("Add ANKR_ETH to .env");

  /*—————————— Main-net addresses (lower-case) ——————————*/
  const USDT  = "0xdac17f958d2ee523a2206206994597c13d831ec7";   // 6 dec
  const WETH  = "0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const SWAP  = "0xe592427a0aece92de3edee1f18e0157c05861564";   // Uni-V3 SwapRouter
  const FEED  = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";   // Chainlink ETH/USD
  const WHALE = "0x28c6c06298d514db089934071355e5743bf21d60";   // big USDT holder
  const FEE   = 500;   // 0.05 % tier (USDT/WETH has deep liquidity)

  let flash, mockPool;

  /*—————————— Fork & deploy ——————————*/
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC, blockNumber: 18_000_000 } }]
    });

    const MockPool = await ethers.getContractFactory("MockPool");
    mockPool       = await MockPool.deploy();
    await mockPool.deployed();

    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash     = await Arb.deploy(mockPool.address, USDT, WETH, FEED);
    await flash.deployed();
  });

  /*—————————— Happy-path flash-loan test ——————————*/
  it("runs USDT ⇆ WETH round-trip via exactInputSingle and emits ArbitrageExecuted", async () => {
    const loan = ethers.utils.parseUnits("1000", 6);   // 1 000 USDT

    /* seed mock pool (impersonate whale) */
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [WHALE]
    });
    const whale = await ethers.getSigner(WHALE);
    const usdt  = await ethers.getContractAt("IERC20", USDT);

    try {
      await usdt.connect(whale).transfer(mockPool.address, loan);
    } finally {
      await network.provider.request({
        method: "hardhat_stopImpersonateAccount",
        params: [WHALE]
      }).catch(() => {});
    }

    /* ABI with field-names so we can pass an object */
    const iface = new ethers.utils.Interface([`
      function exactInputSingle((
        address tokenIn,
        address tokenOut,
        uint24  fee,
        address recipient,
        uint256 deadline,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96
      )) payable returns (uint256)
    `]);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const buy = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  USDT,
      tokenOut: WETH,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  loan,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    const sell = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  WETH,
      tokenOut: USDT,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  loan,                // nominal same amount
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    await expect(
      flash.executeArbitrage(
        SWAP, buy,
        SWAP, sell,
        loan,
        0,          // minProfit (0 for unit-test)
        10_000      // maxDevBps = 100 % (ignore oracle deviation)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
