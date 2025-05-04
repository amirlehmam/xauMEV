const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashLoanArbitrage", function () {
  let flashArb, usdt, xaut, pool, owner, user;
  let buyRouter, sellRouter;
  let priceFeed;

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();

    // 1) Deploy mock USDT, XAUT tokens
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    usdt = await ERC20Mock.deploy("USDT", "USDT", 6);
    xaut = await ERC20Mock.deploy("XAUT", "XAUT", 6);

    // 2) Deploy mock Aave pool & price feed
    const PoolMock = await ethers.getContractFactory("PoolMock");
    pool = await PoolMock.deploy();

    const PriceFeedMock = await ethers.getContractFactory("PriceFeedMock");
    priceFeed = await PriceFeedMock.deploy(ethers.utils.parseUnits("1850", 8)); // $1850

    // 3) Deploy two SimpleDEX mocks: one cheap, one expensive
    const DexMock = await ethers.getContractFactory("SimpleDexMock");
    buyRouter  = await DexMock.deploy(usdt.address, xaut.address, 100, 100);  // price 1 USDT→0.9 XAUT
    sellRouter = await DexMock.deploy(usdt.address, xaut.address, 100, 110);  // price 1 USDT→1.1 XAUT

    // 4) Deploy our arbitrage contract
    const Arb = await ethers.getContractFactory("FlashLoanArbitrage");
    flashArb = await Arb.deploy(
      pool.address,
      usdt.address,
      xaut.address,
      priceFeed.address
    );

    // 5) Fund pool with USDT for flash loan
    await usdt.mint(pool.address, ethers.utils.parseUnits("1000000", 6));

    // 6) Give arbitrage contract some allowances if needed...
  });

  it("should perform a profitable flash loan arbitrage", async function () {
    // Prepare buyData and sellData: encode swapExactTokensForTokens
    // For our SimpleDexMock, assume function: swap(uint256 amountIn) → amountOut
    const buyData  = buyRouter.interface.encodeFunctionData("swap", [ethers.utils.parseUnits("1000", 6)]);
    const sellData = sellRouter.interface.encodeFunctionData("swap", [ethers.utils.parseUnits("1000", 6)]);

    // Execute: borrow 1,000 USDT, require at least 10 USDT profit, max 1% oracle deviation
    await expect(
      flashArb.connect(owner).executeArbitrage(
        buyRouter.address,
        buyData,
        sellRouter.address,
        sellData,
        ethers.utils.parseUnits("1000", 6),
        ethers.utils.parseUnits("10", 6),
        100 // 1%
      )
    ).to.emit(flashArb, "ArbitrageExecuted")
     .withArgs(ethers.utils.parseUnits("10", 6), buyRouter.address, sellRouter.address);
  });
});
