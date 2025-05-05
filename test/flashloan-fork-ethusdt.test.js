// test/flashloan-fork-ethusdt.test.js

const chai   = require("chai");
const waffle = require("ethereum-waffle");
chai.use(waffle.solidity);
const { expect } = chai;

require("dotenv").config();
const { ethers, network } = require("hardhat");

describe("Mainnet-Fork FlashLoanArbitrage (WETH/USDT)", function() {
  const ANKR_ETH = process.env.ANKR_ETH;
  if (!ANKR_ETH) throw new Error("Missing ANKR_ETH in .env");

  // ——— Mainnet Addresses ———
  const USDT            = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const WETH            = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const UNISWAP_V2      = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const ETH_USD_FEED    = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419"; // Chainlink ETH/USD
  const USDT_WHALE      = "0x28C6c06298d514Db089934071355E5743bf21d60";

  let flash, pool;

  before(async () => {
    // 1) Fork mainnet
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: ANKR_ETH,
          blockNumber: 18_000_000
        }
      }]
    });

    // 2) Deploy MockPool stub (Aave flashLoanSimple)
    const MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();
    await pool.deployed();

    // 3) Deploy FlashLoanArbitrage pointing at real WETH/USDT + ETH/USD feed
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Arb.deploy(
      pool.address,
      USDT,
      WETH,
      ETH_USD_FEED
    );
    await flash.deployed();
  });

  it("reads live WETH/USDT price from Uniswap V2", async () => {
    const router = new ethers.Contract(
      UNISWAP_V2,
      ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
      ethers.provider
    );

    // Query how many WETH for 1000 USDT
    const usdtIn = ethers.utils.parseUnits("1000", 6);
    const [, wethOut] = await router.getAmountsOut(usdtIn, [USDT, WETH]);
    const price = parseFloat(ethers.utils.formatUnits(wethOut, 18))  // WETH has 18 decimals
                   / parseFloat(ethers.utils.formatUnits(usdtIn, 6));
    console.log(`⚡ WETH per USDT: ${price}`);
    expect(price).to.be.greaterThan(0);
  });

  it("executes flash-loan + dual-swap on WETH/USDT via Uniswap V2", async () => {
    const loanAmount = ethers.utils.parseUnits("1000", 6); // borrow 1 000 USDT

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

    // Build Uniswap V2 swap calldata
    const uniIface = new ethers.utils.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
    ]);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // 1) Get WETH amount for loanUSDT
    const router = new ethers.Contract(
      UNISWAP_V2,
      ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
      ethers.provider
    );
    const [, wethAmount] = await router.getAmountsOut(loanAmount, [USDT, WETH]);

    // 2) Calldata for USDT→WETH (buy) and WETH→USDT (sell)
    const buyData = uniIface.encodeFunctionData("swapExactTokensForTokens", [
      loanAmount, 0, [USDT, WETH], flash.address, deadline
    ]);
    const sellData = uniIface.encodeFunctionData("swapExactTokensForTokens", [
      wethAmount, 0, [WETH, USDT], flash.address, deadline
    ]);

    // 3) Execute arbitrage
    await expect(
      flash.executeArbitrage(
        UNISWAP_V2, buyData,
        UNISWAP_V2, sellData,
        loanAmount,
        0,       // no minProfit for smoke test
        500      // maxDevBps
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
