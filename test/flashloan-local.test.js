// test/flashloan‑local.test.js
const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("Flash‑loan smoke on Hardhat (mocks)", () => {
  let owner, flash, pool, router, priceFeed;
  let usdt, xaut;

  before(async () => {
    [owner] = await ethers.getSigners();

    /* ── mock tokens ──────────────────────────────── */
    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await ERC20.deploy("Mock USDT", "mUSDT", 6);
    xaut = await ERC20.deploy("Mock XAUT", "mXAUT", 6);

    /* ── mock pool (seeded with 1 M USDT liquidity) ─ */
    const Pool = await ethers.getContractFactory("MockPool");
    pool = await Pool.deploy();
    await usdt.mint(pool.address, ethers.utils.parseUnits("1000000", 6));

    /* ── router + price feed stubs ─────────────────── */
    router    = await (await ethers.getContractFactory("MockRouter")).deploy();
    priceFeed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();

    /* ── contract under test ───────────────────────── */
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(
      pool.address,
      usdt.address,
      xaut.address,
      priceFeed.address
    );

    /* ── seed balances so repayment succeeds ───────── */
    await xaut.mint(flash.address, ethers.utils.parseUnits("5000", 6)); // 5 000 XAUT (matches loan)
    await usdt.mint(flash.address, ethers.utils.parseUnits("10",    6)); // +10 USDT to pay the 4.5 USDT fee
  });

  it("borrows 5 000 mUSDT and returns it", async () => {
    const loan = ethers.utils.parseUnits("5000", 6);

    await expect(
      flash.executeArbitrage(
        router.address, "0x",   // dummy buy
        router.address, "0x",   // dummy sell
        loan,
        0,                      // minProfit
        10_000                  // maxDevBps (ignored by mocks)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
