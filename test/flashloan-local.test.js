/* Hardhat‑only flash‑loan smoke test
   ─────────────────────────────────
   Requires the following mocks in contracts/test/:
     • MockERC20.sol
     • MockPool.sol
     • MockRouter.sol
     • MockPriceFeed.sol
*/

const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("Flash‑loan smoke on Hardhat (mocks)", () => {
  let flash, usdc, usdt, pool, router, priceFeed;

  before(async () => {
    /* ── Mock tokens ─────────────────────────────────────────── */
    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await ERC20.deploy("Mock USDC", "mUSDC", 6);
    usdt = await ERC20.deploy("Mock USDT", "mUSDT", 6);
    await Promise.all([usdc.deployed(), usdt.deployed()]);

    /* ── Mock Aave pool ──────────────────────────────────────── */
    const Pool = await ethers.getContractFactory("MockPool");
    pool = await Pool.deploy();
    await pool.deployed();
    await usdc.mint(pool.address, ethers.utils.parseUnits("1000000", 6)); // seed liquidity

    /* ── Stub router & price feed (compiled from .sol files) ─── */
    router     = await (await ethers.getContractFactory("MockRouter")).deploy();
    priceFeed  = await (await ethers.getContractFactory("MockPriceFeed")).deploy();

    /* ── Contract under test ─────────────────────────────────── */
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(
      pool.address,
      usdc.address,
      usdt.address,
      priceFeed.address           // non‑zero => passes constructor check
    );
    await flash.deployed();
  });

  it("borrows 5 000 mUSDC and returns it", async () => {
    const loan  = ethers.utils.parseUnits("5000", 6);
    const blank = "0x";                        // dummy calldata for mocks

    await expect(
      flash.executeArbitrage(
        router.address, blank,                // buy side (mocked)
        router.address, blank,                // sell side
        loan,
        0,                                    // minProfit
        10_000                                // deviation guard (ignored by mocks)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
