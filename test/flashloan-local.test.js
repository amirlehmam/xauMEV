// Flash‑loan unit test (Hardhat local network) using pure mocks
// ────────────────────────────────────────────────────────────
// This file lives in test/flashloan-local.test.js. It deploys:
//   • MockERC20   – mintable tokens with custom decimals
//   • MockPool    – 25‑line flash‑loan stub (Aave‑compatible)
//   • MockPriceFeed – always returns price = 1e8
//   • MockRouter  – stub for Uniswap V2 getAmountsOut()
//   • FlashLoanArbitrage – your production contract under test
// and proves that executeArbitrage emits ArbitrageExecuted without reverting.

const { expect } = require("chai");
const { ethers }  = require("hardhat");

/**
 * Hardhat local smoke‑test
 */
describe("Flash‑loan smoke on Hardhat (mocks)", () => {
  let flash, usdc, usdt, pool, router;
  const DUMMY_FEED = "0x000000000000000000000000000000000000dEaD"; // replaced by real mock below

  before(async () => {
    const [deployer] = await ethers.getSigners();

    /* ── Deploy MockERC20s ─────────────────────────────────────── */
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
    await usdc.deployed();

    usdt = await MockERC20.deploy("Mock USDT", "mUSDT", 6);
    await usdt.deployed();

    /* ── Deploy MockPool  ──────────────────────────────────────── */
    const MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();
    await pool.deployed();

    // seed pool with 1 000 000 USDC liquidity
    await usdc.mint(pool.address, ethers.utils.parseUnits("1000000", 6));

    /* ── Deploy MockPriceFeed (returns constant 1e8) ───────────── */
    const MockPriceFeed = await ethers.getContractFactory(
      `contract MockPriceFeed {
         function latestRoundData() external pure returns (
           uint80, int256, uint256, uint256, uint80
         ) {
           return (0, 1e8, 0, 0, 0);
         }
       }`
    , { language: "Solidity" });
    const priceFeed = await MockPriceFeed.deploy();
    await priceFeed.deployed();

    /* ── Deploy MockRouter (Uni V2 stub) ───────────────────────── */
    const MockRouter = await ethers.getContractFactory(
      `pragma solidity ^0.8.17;
       contract MockRouter {
         function getAmountsOut(uint amountIn, address[] calldata path)
           external pure returns (uint[] memory amounts)
         {
           amounts = new uint[](path.length);
           for (uint i = 0; i < path.length; i++) amounts[i] = amountIn;
         }
       }`
    , { language: "Solidity" });
    router = await MockRouter.deploy();
    await router.deployed();

    /* ── Deploy arbitrage contract ─────────────────────────────── */
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(
      pool.address,
      usdc.address,
      usdt.address,
      priceFeed.address  // any non‑zero addr implementing latestRoundData()
    );
    await flash.deployed();
  });

  it("borrows 5 000 mUSDC and returns it", async () => {
    const loan = ethers.utils.parseUnits("5000", 6);

    // empty calldata for stub
    const emptyData = "0x";

    await expect(
      flash.executeArbitrage(
        router.address, emptyData,  // buyRouter, buyData
        router.address, emptyData,  // sellRouter, sellData
        loan,
        0,        // minProfit = 0
        10000     // 100 % deviation guard (ignored by mocks)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
