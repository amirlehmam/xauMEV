// Smoke‑test: flash‑loan 100 USDC → swap USDC⇄USDT on Uni V3 → repay

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ------- Sepolia addresses (June 2025) -------
const POOL   = "0x4C3fD1c19E4041B10b5d2579841E1f70e43f3a97";      // Aave V3 pool  :contentReference[oaicite:1]{index=1}
const USDC   = "0x6fe14Cdc42c64eE1eAdfB2F205B9893fF0068337";      // test‑USDC    :contentReference[oaicite:2]{index=2}
const USDT   = "0x110C79f7f4d1c4Ad7Efd2d4A38Bf0FD3D9e55A02";      // test‑USDT    :contentReference[oaicite:3]{index=3}
const FEED   = "0x2f9Ec37f22021f0d0f6FE8e4e3BdBBCD0b47e1C1";      // USDT/USD feed :contentReference[oaicite:4]{index=4}
const ROUTER = "0x9AC64Cc6e4415144C455BD8E4837Fea55603e5c3";      // Uni V3 router 02 :contentReference[oaicite:5]{index=5}
const QUOTER = "0x61FFE014bA17989E743c5F6cB21bF9697530B21e";      // Quoter V2      :contentReference[oaicite:6]{index=6}
const FEE    = 100;                                               // 0.01 % pool

describe("FlashLoanArbitrage • Sepolia", () => {
  it("borrows 100 USDC and round‑trips USDC⇄USDT", async () => {
    const [signer] = await ethers.getSigners();

    // deploy fresh instance
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    const flash = await Flash.deploy(POOL, USDC, USDT, FEED);
    await flash.deployed();

    // on‑chain quote
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"],
      signer
    );
    const loan    = ethers.utils.parseUnits("100", 6);
    const usdtOut = await quoter.callStatic.quoteExactInputSingle(USDC, USDT, FEE, loan, 0);

    // build calldata
    const iface = new ethers.utils.Interface([
      "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)"
    ]);
    const dl = Math.floor(Date.now() / 1e3) + 900;

    const buy  = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDC, tokenOut: USDT, fee: FEE, recipient: flash.address,
      deadline: dl, amountIn: loan, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);
    const sell = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDT, tokenOut: USDC, fee: FEE, recipient: flash.address,
      deadline: dl, amountIn: usdtOut, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);

    // run flash‑loan (minProfit = 0 for smoke)
    await expect(
      flash.executeArbitrage(
        ROUTER, buy,
        ROUTER, sell,
        loan,
        0,
        1000                     // 10 % deviation guard
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
