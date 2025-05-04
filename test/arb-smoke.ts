import { expect } from "chai";
import { ethers } from "hardhat";

const AAVE_POOL  = "0x7BeA39867e4169DBe237d55C8242a8f2fcDcc387"; // Aave V3 mainnet
const USDT       = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const XAUT       = "0x68749665FF8D2d112Fa859AA293F07A622782F38";
const XAU_USD_FEED = "0x9C4424Fd8cE446EF6eEe4674f37362D17b4F4BB8"; // Chainlink XAU/USD

describe("FlashLoanArbitrage smoke", function () {
  it("borrows, swaps, repays, and yields profit ≥ 0", async () => {
    const [deployer] = await ethers.getSigners();

    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    const flash = await Flash.deploy(
      AAVE_POOL,
      USDT,
      XAUT,
      XAU_USD_FEED
    );
    await flash.deployed();

    // --- Build swap calldata on the fly ------------------------------
    const router      = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // UniswapV3Router
    const iface       = new ethers.utils.Interface([
      "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
    ]);

    /* USDT → XAUT */
    const buyCall = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  USDT,
      tokenOut: XAUT,
      fee:      500,
      recipient: flash.address,
      deadline:  Math.floor(Date.now()/1000) + 1800,
      amountIn:  ethers.utils.parseUnits("10000", 6),
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    /* XAUT → USDT (reverse) */
    const sellCall = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  XAUT,
      tokenOut: USDT,
      fee:      500,
      recipient: flash.address,
      deadline:  Math.floor(Date.now()/1000) + 1800,
      amountIn:  0,              // will use entire balance via router fee tricks
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    // --- Trigger flash‑loan ------------------------------------------
    await expect(
      flash.executeArbitrage(
        router, buyCall,
        router, sellCall,
        ethers.utils.parseUnits("10000", 6), // loanAmount
        0,      // minProfit
        150      // maxDevBps = 1.5 %
      )
    ).to.emit(flash, "ArbitrageExecuted");

    const profit = await (await ethers.getContractAt("IERC20", USDT))
                               .balanceOf(deployer.address);
    expect(profit).to.be.gt(0);
  });
});
