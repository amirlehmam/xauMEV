// test/flashloan-arb.sepolia.js — pure Sepolia integration test (NO hardhat_reset)

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ---------------- Sepolia addresses ----------------
const POOL   = "0x4c3fd1c19e4041b10b5d2579841e1f70e43f3a97";  // Aave V3 pool (lowercase)  // Aave V3 pool
const USDC   = "0x6fe14cdc42c64ee1eadfb2f205b9893ff0068337";  // test‑USDC (lowercase)  // test‑USDC
const USDT   = "0x110C79f7f4d1c4Ad7Efd2d4A38Bf0FD3D9e55A02";  // test‑USDT
const FEED   = "0x2f9Ec37f22021f0d0f6FE8e4e3BdBBCD0b47e1C1";  // USDT/USD feed
const ROUTER = "0x9AC64Cc6e4415144C455BD8E4837Fea55603e5c3";  // Uni V3 router02
const QUOTER = "0x61FFE014bA17989E743c5F6cB21bF9697530B21e";  // Quoter V2
const FEE    = 100;                                          // 0.01 % pool

/* -------------------------------------------------------------------------- */
describe("FlashLoanArbitrage • Sepolia", function () {
  it("borrows 100 USDC and round‑trips USDC⇄USDT", async () => {
    const [signer] = await ethers.getSigners();

    // Deploy fresh contract pointing to Sepolia addresses
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    const flash = await Flash.deploy(POOL, USDC, USDT, FEED);
    await flash.deployed();

    // Quote on‑chain via Quoter V2
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"],
      signer
    );
    const loan    = ethers.utils.parseUnits("100", 6);
    const usdtOut = await quoter.callStatic.quoteExactInputSingle(USDC, USDT, FEE, loan, 0);

    // Build Uniswap V3 calldata
    const iface = new ethers.utils.Interface([
      "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)"
    ]);
    const dl = Math.floor(Date.now() / 1e3) + 900;

    const buyData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDC, tokenOut: USDT, fee: FEE, recipient: flash.address,
      deadline: dl, amountIn: loan, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);

    const sellData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDT, tokenOut: USDC, fee: FEE, recipient: flash.address,
      deadline: dl, amountIn: usdtOut, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);

    // Execute flash‑loan arbitrage (minProfit = 0 for smoke test)
    await expect(
      flash.executeArbitrage(
        ROUTER, buyData,
        ROUTER, sellData,
        loan,
        0,
        1000 // 10 % deviation guard
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
