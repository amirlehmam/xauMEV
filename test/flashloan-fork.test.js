// test/flashloan-fork.test.js

const chai   = require("chai");
const waffle = require("ethereum-waffle");
chai.use(waffle.solidity);
const { expect } = chai;

require("dotenv").config();
const { ethers, network } = require("hardhat");

describe("Mainnet-Fork FlashLoanArbitrage (Uniswap V3)", function() {
  const ANKR_ETH = process.env.ANKR_ETH;
  if (!ANKR_ETH) throw new Error("Missing ANKR_ETH in .env");

  // ——— Mainnet addresses ———
  const USDT       = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const XAUT       = "0x68749665FF8D2d112Fa859AA293F07A622782F38";
  const QUOTER     = "0xb27308F9F90D607463bb33eA1BeBb41C27CE5AB6";  // correct checksummed
  const SWAP_ROUTER= "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const PRICE_FEED = "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1A0D6";
  const USDT_WHALE = "0x28C6c06298d514Db089934071355E5743bf21d60";

  const FEE_TIER = 3000; // 0.3%

  let flash, pool;

  before(async () => {
    // 1) Reset & fork Ethereum mainnet
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: ANKR_ETH,
          blockNumber: 18_000_000
        }
      }]
    });

    // 2) Deploy MockPool (stub for Aave flashLoanSimple)
    const MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();
    await pool.deployed();

    // 3) Deploy your FlashLoanArbitrage pointing at real USDT/XAUT + Chainlink feed
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Arb.deploy(pool.address, USDT, XAUT, PRICE_FEED);
    await flash.deployed();
  });

  it("quotes XAUT/USDT via Uniswap V3 Quoter", async () => {
    // Use callStatic to avoid on-chain revert
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns (uint256)"],
      ethers.provider
    );

    const amountIn = ethers.utils.parseUnits("1", 6); // 1 USDT
    const xautOut = await quoter.callStatic.quoteExactInputSingle(
      USDT, XAUT, FEE_TIER, amountIn, 0
    );
    const price = ethers.utils.formatUnits(xautOut, 6);

    console.log("⚡ XAUT per USDT:", price);
    expect(parseFloat(price)).to.be.greaterThan(0);
  });

  it("executes flash-loan + dual-swap via SwapRouter exactInputSingle", async () => {
    const loanAmount = ethers.utils.parseUnits("10", 6);

    // Impersonate a USDT whale to fund MockPool
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

    // Build exactInputSingle calldata
    const routerIface = new ethers.utils.Interface([
      "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) external payable returns (uint256)"
    ]);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // Quote the exact amount of XAUT for loanAmount USDT
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns (uint256)"],
      ethers.provider
    );
    const xautAmount = await quoter.callStatic.quoteExactInputSingle(
      USDT, XAUT, FEE_TIER, loanAmount, 0
    );

    // Encode buy (USDT→XAUT) & sell (XAUT→USDT)
    const buyData = routerIface.encodeFunctionData("exactInputSingle", [{
      tokenIn:           USDT,
      tokenOut:          XAUT,
      fee:               FEE_TIER,
      recipient:         flash.address,
      deadline,
      amountIn:          loanAmount,
      amountOutMinimum:  0,
      sqrtPriceLimitX96: 0
    }]);
    const sellData = routerIface.encodeFunctionData("exactInputSingle", [{
      tokenIn:           XAUT,
      tokenOut:          USDT,
      fee:               FEE_TIER,
      recipient:         flash.address,
      deadline,
      amountIn:          xautAmount,
      amountOutMinimum:  0,
      sqrtPriceLimitX96: 0
    }]);

    // Execute arbitrage
    await expect(
      flash.executeArbitrage(
        SWAP_ROUTER, buyData,
        SWAP_ROUTER, sellData,
        loanAmount,
        0,     // minProfit
        1000   // maxDevBps tolerance
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
