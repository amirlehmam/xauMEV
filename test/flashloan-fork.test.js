/* eslint-env mocha */
require("dotenv").config();
require("@nomicfoundation/hardhat-chai-matchers");   // adds .emit/.reverted

const { expect }          = require("chai");
const { ethers, network } = require("hardhat");

describe("Flash-loan arbitrage on a main-net fork (USDT ⇆ WETH, Uni-V3)", () => {
  /*────────────────── RPC from .env ──────────────────*/
  const RPC = process.env.ANKR_ETH;
  if (!RPC) throw new Error("Add ANKR_ETH in .env");

  /*────────────────── Main-net constants ─────────────*/
  const USDT   = "0xdac17f958d2ee523a2206206994597c13d831ec7";   // 6 dec
  const WETH   = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";   // 18 dec
  const SWAP   = "0xe592427a0aece92de3edee1f18e0157c05861564";   // Uniswap V3 SwapRouter
  const QUOTER = "0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6";   // Quoter V2
  const FEED   = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";   // Chainlink ETH/USD
  const WHALE  = "0x28c6c06298d514db089934071355e5743bf21d60";   // big USDT holder
  const FEE    = 500;   // 0.05 % tier

  let flash, mockPool;

  /*────────────────── Fork & deployments ─────────────*/
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC, blockNumber: 18_000_000 } }]
    });

    mockPool = await (await ethers.getContractFactory("MockPool")).deploy();
    await mockPool.deployed();

    flash = await (
      await ethers.getContractFactory("FlashLoanArbitrage")
    ).deploy(mockPool.address, USDT, WETH, FEED);
    await flash.deployed();
  });

  it("emits ArbitrageExecuted (happy-path)", async () => {
    const loan = ethers.utils.parseUnits("1000", 6);          // 1 000 USDT

    /*—— 1) seed pool & flash-contract ——*/
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [WHALE] });
    const whale = await ethers.getSigner(WHALE);
    const usdt  = await ethers.getContractAt("IERC20", USDT);

    // pool gets 2× the loan (covers premium)
    await usdt.connect(whale).transfer(mockPool.address, loan.mul(2));
    // flash-contract gets a 5 USDT buffer to repay fee+slippage
    await usdt.connect(whale).transfer(flash.address, ethers.utils.parseUnits("5", 6));
    await network.provider.request({ method: "hardhat_stopImpersonateAccount", params: [WHALE] })
      .catch(() => {});

    /*—— 2) quote expected WETH out ——*/
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"],
      ethers.provider
    );
    const wethOut = await quoter.callStatic.quoteExactInputSingle(
      USDT, WETH, FEE, loan, 0
    );

    /*—— 3) build exactInputSingle calldata ——*/
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
      )) returns (uint256)
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

    // sell a hair less than quoted (−0.5 %) to avoid “insufficient input” revert
    const sellAmount = wethOut.mul(995).div(1000);

    const sell = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  WETH,
      tokenOut: USDT,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  sellAmount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    /*—— 4) execute flash-loan + swaps ——*/
    await expect(
      flash.executeArbitrage(
        SWAP, buy,
        SWAP, sell,
        loan,
        0,          // minProfit disabled for test
        10_000      // maxDevBps = 100 % (ignore oracle guard)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
