// test/flashloan-arb.sepolia.js — WETH flash‑loan (flash‑loan enabled)

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// Sepolia addresses (all lowercase)
const POOL   = "0x4c3fd1c19e4041b10b5d2579841e1f70e43f3a97"; // Aave V3 pool
const WETH   = "0xdd13e55209fd76afe204dbda4007c227904f0a81"; // Wrapped ETH
const USDC   = "0x6fe14cdc42c64ee1eadfb2f205b9893ff0068337"; // test‑USDC
const FEED   = "0x694AA1769357215DE4FAC081bf1f309aDC325306"; // ETH/USD feed
const ROUTER = "0x9ac64cc6e4415144c455bd8e4837fea55603e5c3"; // Uni V3 router
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e"; // Quoter V2
const FEE    = 3000; // 0.30 % pool (deepest WETH/USDC on Sepolia)

describe.skip("FlashLoanArbitrage • Sepolia (WETH → USDC)", () => {
  it("borrows 0.1 WETH and round‑trips WETH⇄USDC", async () => {
    const [signer] = await ethers.getSigners();

    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    const flash = await Flash.deploy(POOL, WETH, USDC, FEED);
    await flash.deployed();

    /* on‑chain quote WETH → USDC */
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"],
      signer
    );
    const loan    = ethers.utils.parseEther("0.1"); // 0.1 WETH (18 dec)
    const usdcOut = await quoter.callStatic.quoteExactInputSingle(WETH, USDC, FEE, loan, 0);

    /* build calldata */
    const iface = new ethers.utils.Interface([
      "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)"
    ]);
    const dl = Math.floor(Date.now()/1e3) + 900;

    const buyData  = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: WETH, tokenOut: USDC, fee: FEE, recipient: flash.address,
      deadline: dl, amountIn: loan, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);
    const sellData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDC, tokenOut: WETH, fee: FEE, recipient: flash.address,
      deadline: dl, amountIn: usdcOut, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);

    /* execute flash‑loan (minProfit = 0) */
    await expect(
      flash.executeArbitrage(
        ROUTER, buyData,
        ROUTER, sellData,
        loan,
        0,
        2000 // 20 % deviation guard (ETH volatile vs oracle)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
