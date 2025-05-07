const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashLoanArbitrage – Negative Scenarios", function () {
  let owner, other;
  let pool, usdt, xaut, priceFeed, flash;

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();

    // 1) Deploy MockPool
    const MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();
    await pool.deployed();

    // 2) Deploy mock ERC20s
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await MockERC20.deploy("Tether USD", "USDT", 6);
    await usdt.deployed();
    xaut = await MockERC20.deploy("Gold Token", "XAUT", 6);
    await xaut.deployed();

    // 3) Deploy MockPriceFeed
    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
    priceFeed = await MockPriceFeed.deploy();
    await priceFeed.deployed();

    // 4) Seed the pool so flashLoanSimple can lend
    await usdt.mint(pool.address, ethers.utils.parseUnits("1000", 6));

    // 5) Deploy FlashLoanArbitrage
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(
      pool.address,
      usdt.address,
      xaut.address,
      priceFeed.address
    );
    await flash.deployed();
  });

  it("reverts if non-owner calls executeArbitrage", async function () {
    try {
      await flash.connect(other).executeArbitrage(
        ethers.constants.AddressZero, "0x",
        ethers.constants.AddressZero, "0x",
        /*loanAmount*/ 1000,
        /*minProfit*/ 0,
        /*maxDevBps*/ 100
      );
      expect.fail("Expected revert");
    } catch (err) {
      expect(err.message).to.include("Ownable: caller is not the owner");
    }
  });

  it("reverts when loanAmount is zero", async function () {
    try {
      await flash.executeArbitrage(
        ethers.constants.AddressZero, "0x",
        ethers.constants.AddressZero, "0x",
        /*loanAmount*/ 0,
        /*minProfit*/ 0,
        /*maxDevBps*/ 100
      );
      expect.fail("Expected revert");
    } catch (err) {
      expect(err.message).to.include("loan=0");
    }
  });

  it("reverts when maxDevBps > 10000", async function () {
    try {
      await flash.executeArbitrage(
        ethers.constants.AddressZero, "0x",
        ethers.constants.AddressZero, "0x",
        /*loanAmount*/ 1000,
        /*minProfit*/ 0,
        /*maxDevBps*/ 10001
      );
      expect.fail("Expected revert");
    } catch (err) {
      expect(err.message).to.include("dev>100%");
    }
  });

  it("reverts when observed price deviates too far from oracle", async function () {
    // Deploy and seed the MockRouter
    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy();
    await router.deployed();

    const loanAmount = ethers.utils.parseUnits("500", 6);
    await xaut.mint(router.address, loanAmount);
    await usdt.mint(router.address, loanAmount);

    const pathBuy  = [usdt.address, xaut.address];
    const pathSell = [xaut.address, usdt.address];
    const buyData  = router.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [0, 0, pathBuy, flash.address, 0]
    );
    const sellData = router.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [0, 0, pathSell, flash.address, 0]
    );

    try {
      await flash.executeArbitrage(
        router.address, buyData,
        router.address, sellData,
        loanAmount,
        /*minProfit*/ 0,
        /*maxDevBps*/ 1   // too tight
      );
      expect.fail("Expected revert");
    } catch (err) {
      expect(err.message).to.include("deviation too big");
    }
  });

  it("reverts when profit < minProfit", async function () {
    // Deploy and seed the MockRouter
    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy();
    await router.deployed();

    const loanAmount = ethers.utils.parseUnits("100", 6);
    await xaut.mint(router.address, loanAmount);
    await usdt.mint(router.address, loanAmount);

    const pathBuy  = [usdt.address, xaut.address];
    const pathSell = [xaut.address, usdt.address];
    const buyData  = router.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [0, 0, pathBuy, flash.address, 0]
    );
    const sellData = router.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [0, 0, pathSell, flash.address, 0]
    );

    try {
      await flash.executeArbitrage(
        router.address, buyData,
        router.address, sellData,
        loanAmount,
        /*minProfit*/ ethers.utils.parseUnits("1", 6),  // require ≥1 USDT profit
        /*maxDevBps*/ 10000
      );
      expect.fail("Expected revert");
    } catch (err) {
      // match the contract's revert string "profit < min: 0 < 1000000"
      expect(err.message).to.include("profit < min:");
    }
  });
});
