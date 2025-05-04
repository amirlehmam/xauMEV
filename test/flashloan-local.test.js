const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("Flash‑loan smoke on Hardhat (mocks)", () => {
  let flash, usdc, usdt, pool, router, priceFeed;

  before(async () => {
    /* deploy mocks */
    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await ERC20.deploy("Mock USDC","mUSDC",6);
    usdt = await ERC20.deploy("Mock USDT","mUSDT",6);

    const Pool   = await ethers.getContractFactory("MockPool");
    pool   = await Pool.deploy();
    await usdc.mint(pool.address, ethers.utils.parseUnits("1000000",6));

    router    = await (await ethers.getContractFactory("MockRouter")).deploy();
    priceFeed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();

    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(pool.address, usdc.address, usdt.address, priceFeed.address);
  });

  it("borrows 5 000 mUSDC and returns it", async () => {
    const loan = ethers.utils.parseUnits("5000",6);
    await expect(
      flash.executeArbitrage(
        router.address, "0x",
        router.address, "0x",
        loan,
        0,
        10_000
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
