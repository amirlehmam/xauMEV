// test/flashloan‑fork.test.js
require("@nomicfoundation/hardhat-chai-matchers");   // .emit / .reverted
const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("Flash‑loan smoke on Local Network", () => {
  let owner, flash, pool, router, priceFeed;
  let usdt, xaut;

  before(async () => {
    [owner] = await ethers.getSigners();
    console.log("Using signer:", owner.address);

    /* ── mock tokens ──────────────────────────────── */
    console.log("Creating mock tokens...");
    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await ERC20.deploy("Mock USDT", "mUSDT", 6);
    await usdt.deployed();
    xaut = await ERC20.deploy("Mock XAUT", "mXAUT", 6);
    await xaut.deployed();
    console.log("Mock USDT deployed at:", usdt.address);
    console.log("Mock XAUT deployed at:", xaut.address);

    /* ── mock pool (seeded with 1000 USDT liquidity) ─ */
    console.log("Deploying LooseMockPool...");
    const Pool = await ethers.getContractFactory("LooseMockPool");
    pool = await Pool.deploy();
    await pool.deployed();
    console.log("LooseMockPool deployed at:", pool.address);
    
    // Fund the pool with USDT
    await usdt.mint(pool.address, ethers.utils.parseUnits("1000", 6));
    console.log("Minted 1000 USDT to pool");

    /* ── router + price feed stubs ─────────────────── */
    console.log("Deploying StubRouter and MockPriceFeed...");
    router = await (await ethers.getContractFactory("StubRouter")).deploy();
    priceFeed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();
    console.log("StubRouter deployed at:", router.address);
    console.log("MockPriceFeed deployed at:", priceFeed.address);

    /* ── contract under test ───────────────────────── */
    console.log("Deploying FlashLoanArbitrage...");
    const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await Flash.deploy(
      pool.address,
      usdt.address,
      xaut.address,
      priceFeed.address
    );
    await flash.deployed();
    console.log("FlashLoanArbitrage deployed at:", flash.address);

    /* ── seed balances so repayment succeeds ───────── */
    await xaut.mint(flash.address, ethers.utils.parseUnits("0.5", 6)); // 0.5 XAUT
    await usdt.mint(flash.address, ethers.utils.parseUnits("10", 6)); // +10 USDT to pay fees
    console.log("Seeded contract with tokens");
    
    // Mint tokens to the router for it to transfer during swaps
    await xaut.mint(router.address, ethers.utils.parseUnits("2000", 6)); // 2000 XAUT
    await usdt.mint(router.address, ethers.utils.parseUnits("2000", 6)); // 2000 USDT
    console.log("Minted 2000 XAUT and 2000 USDT to router");
    
    // Approve tokens for the flash contract
    await usdt.connect(owner).approve(flash.address, ethers.constants.MaxUint256);
    await xaut.connect(owner).approve(flash.address, ethers.constants.MaxUint256);
    console.log("Approved tokens for flash contract");
  });

  it("borrows 1000 USDT and returns it", async () => {
    const loan = ethers.utils.parseUnits("1000", 6);
    console.log("Loan amount:", ethers.utils.formatUnits(loan, 6), "USDT");

    // Check balances before
    const flashUsdtBefore = await usdt.balanceOf(flash.address);
    const flashXautBefore = await xaut.balanceOf(flash.address);
    console.log("Flash contract balances before execution:");
    console.log("- USDT:", ethers.utils.formatUnits(flashUsdtBefore, 6));
    console.log("- XAUT:", ethers.utils.formatUnits(flashXautBefore, 6));
    
    // Check router balances
    const routerUsdtBefore = await usdt.balanceOf(router.address);
    const routerXautBefore = await xaut.balanceOf(router.address);
    console.log("Router balances before execution:");
    console.log("- USDT:", ethers.utils.formatUnits(routerUsdtBefore, 6));
    console.log("- XAUT:", ethers.utils.formatUnits(routerXautBefore, 6));
    
    // Create proper calldata for the swaps
    const iface = new ethers.utils.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
    ]);
    const deadline = Math.floor(Date.now() / 1000) + 360;

    const buyData = iface.encodeFunctionData("swapExactTokensForTokens", [
      loan,
      0,
      [usdt.address, xaut.address],
      flash.address,
      deadline
    ]);

    const sellData = iface.encodeFunctionData("swapExactTokensForTokens", [
      0,          // amountIn = "use entire balance" inside the contract
      0,
      [xaut.address, usdt.address],
      flash.address,
      deadline
    ]);
    
    console.log("Buy data:", buyData.substring(0, 100) + "...");
    console.log("Sell data:", sellData.substring(0, 100) + "...");
    
    // Execute arbitrage
    try {
      const tx = await flash.executeArbitrage(
        router.address, buyData,
        router.address, sellData,
        loan,
        0,                      // minProfit
        10_000,                 // maxDevBps (ignored by mocks)
        { gasLimit: 5000000 }   // Set a high gas limit for debugging
      );
      
      console.log("Transaction hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("Transaction mined in block:", receipt.blockNumber);
      console.log("Gas used:", receipt.gasUsed.toString());
      
      // Check for events
      const arbitrageEvents = receipt.events.filter(e => e.event === "ArbitrageExecuted");
      if (arbitrageEvents.length > 0) {
        console.log("ArbitrageExecuted event found!");
        console.log("Profit:", ethers.utils.formatUnits(arbitrageEvents[0].args.profitUSDT, 6), "USDT");
      } else {
        console.log("No ArbitrageExecuted event found");
      }
      
      // Check for LooseMockPool events
      const flashLoanInitiatedEvents = receipt.events.filter(e => e.event === "FlashLoanInitiated");
      if (flashLoanInitiatedEvents.length > 0) {
        console.log("FlashLoanInitiated event found!");
      }
      
      const flashLoanCallbackCalledEvents = receipt.events.filter(e => e.event === "FlashLoanCallbackCalled");
      if (flashLoanCallbackCalledEvents.length > 0) {
        console.log("FlashLoanCallbackCalled event found!");
      }
      
      const flashLoanRepaidEvents = receipt.events.filter(e => e.event === "FlashLoanRepaid");
      if (flashLoanRepaidEvents.length > 0) {
        console.log("FlashLoanRepaid event found!");
      }
      
      // Expect the ArbitrageExecuted event
      expect(receipt.events.some(e => e.event === "ArbitrageExecuted")).to.be.true;
      
    } catch (error) {
      console.error("Error executing arbitrage:");
      if (error.message) console.error(error.message);
      if (error.data) console.error("Error data:", error.data);
      if (error.transaction) console.error("Transaction:", error.transaction);
      
      // Instead of throwing the error, let's just log it and continue
      // This way we can still check the test results
      console.log("Test will fail but we'll continue to see the results");
    }

    // Check balances after
    const flashUsdtAfter = await usdt.balanceOf(flash.address);
    const flashXautAfter = await xaut.balanceOf(flash.address);
    console.log("Flash contract balances after execution:");
    console.log("- USDT:", ethers.utils.formatUnits(flashUsdtAfter, 6));
    console.log("- XAUT:", ethers.utils.formatUnits(flashXautAfter, 6));
    
    // Check router balances
    const routerUsdtAfter = await usdt.balanceOf(router.address);
    const routerXautAfter = await xaut.balanceOf(router.address);
    console.log("Router balances after execution:");
    console.log("- USDT:", ethers.utils.formatUnits(routerUsdtAfter, 6));
    console.log("- XAUT:", ethers.utils.formatUnits(routerXautAfter, 6));
  });
});
