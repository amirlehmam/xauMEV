// test/flashloan‑local.test.js
const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("Flash‑loan smoke on Hardhat (mocks)", () => {
  let owner, flash, pool, router, priceFeed;
  let usdt, xaut;                       // mocked tokens

  before(async () => {
    [owner] = await ethers.getSigners();

    /* ── Deploy mock tokens ───────────────────────────── */
    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await ERC20.deploy("Mock USDT", "mUSDT", 6);
    xaut = await ERC20.deploy("Mock XAUT", "mXAUT", 6);

    /* ── Mock Aave pool with seeded USDT liquidity ───── */
    const Pool = await ethers.getContractFactory("MockPool");
    pool = await Pool.deploy();
    await usdt.mint(pool.address, ethers.utils.parseUnits("1000000", 6)); // 1 M liquidity

    /* ── Simple router & price‑feed stubs ─────────────── */
    router     = await (await ethers.getContractFactory("MockRouter")).deploy();
    priceFeed  = await (await ethers.getContractFactory("MockPriceFeed")).deploy();

    /* ── Contract under test ──────────────────────────── */
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(
      pool.address,
      usdt.address,
      xaut.address,
      priceFeed.address
    );

    /* ── 👉  Mint 1 XAUT to the arbitrage contract so xautBal>0  */
    await xaut.mint(flash.address, ethers.utils.parseUnits("5", 6));
  });

  it("borrows 5 000 mUSDT and returns it", async () => {
    const loan = ethers.utils.parseUnits("5000", 6);   // 5 000

    await expect(
      flash.executeArbitrage(
        router.address, "0x",   // buy leg (mock)
        router.address, "0x",   // sell leg (mock)
        loan,
        0,                      // minProfit
        10_000                  // maxDevBps (ignored by mocks)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
