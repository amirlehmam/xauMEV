import { expect } from "chai";
import { ethers } from "hardhat";

const POOL  = "0x4C3fD1c19E4041B10b5d2579841E1f70e43f3a97";                // Aave V3 pool :contentReference[oaicite:5]{index=5}
const USDC  = "0x6Fe14Cdc42c64eE1eAdfB2F205B9893fF0068337";                // test‑USDC :contentReference[oaicite:6]{index=6}
const USDT  = "0x110C79f7f4d1c4Ad7Efd2d4A38Bf0FD3D9e55A02";                // test‑USDT :contentReference[oaicite:7]{index=7}
const FEED  = "0x2f9Ec37f22021f0d0f6FE8e4e3BdBBCD0b47e1C1";                // Chainlink USDT/USD :contentReference[oaicite:8]{index=8}

const ROUTER = "0x9AC64Cc6e4415144C455BD8E4837Fea55603e5c3";               // Uniswap V3 router :contentReference[oaicite:9]{index=9}
const QUOTER = "0x61FFE014bA17989E743c5F6cB21bF9697530B21e";               // Quoter V2 :contentReference[oaicite:10]{index=10}
const FEE    = 100;                                                        // 0.01 %

describe("Sepolia flash‑loan smoke test", function () {
  it("borrows USDC and swaps USDC⇄USDT", async () => {
    const [deployer] = await ethers.getSigners();

    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    const flash = await Flash.deploy(POOL, USDC, USDT, FEED);
    await flash.deployed();

    const quoter = new ethers.Contract(QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"],
      deployer);

    const loan = ethers.utils.parseUnits("100", 6); // 100 USDC
    const usdtOut = await quoter.callStatic.quoteExactInputSingle(USDC, USDT, FEE, loan, 0);

    const iface = new ethers.utils.Interface([
      "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)"
    ]);
    const deadline = Math.floor(Date.now() / 1e3) + 1200;

    const buyData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDC, tokenOut: USDT, fee: FEE, recipient: flash.address,
      deadline, amountIn: loan, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);
    const sellData = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDT, tokenOut: USDC, fee: FEE, recipient: flash.address,
      deadline, amountIn: usdtOut, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    }]);

    await expect(
      flash.executeArbitrage(
        ROUTER, buyData,
        ROUTER, sellData,
        loan,
        0,          // minProfit = 0 for smoke test
        1000        // 10 % deviation guard
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
