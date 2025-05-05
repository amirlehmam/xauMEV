// test/flashloan-fork.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Mainnet-Fork: XAUT/USDT on Uniswap V2", function() {
  const USDT      = "0xdAC17F958D2ee523a2206206994597C13D831ec7";      // USDT (6d) :contentReference[oaicite:0]{index=0}
  const XAUT      = "0x68749665FF8D2d112Fa859AA293F07A622782F38";    // XAUT (6d) :contentReference[oaicite:1]{index=1}
  const UNIV2     = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";    // Uniswap V2 Router :contentReference[oaicite:2]{index=2}
  const PRICE_FEED= "0x214eD9Da11D2fbe465a6fc601a91e62EbEc1a0D6";    // Chainlink XAU/USD :contentReference[oaicite:3]{index=3}

  let FlashLoanArb, flash, MockPool, pool;

  before(async () => {
    // 1) Reset the Hardhat network to a mainnet fork
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { url: process.env.ANKR_ETH, blockNumber: 18_000_000 } }]
    });

    // 2) Deploy MockPool locally (so we control the flashLoan callback)
    MockPool = await ethers.getContractFactory("MockPool");
    pool = await MockPool.deploy();

    // 3) Deploy your FlashLoanArbitrage against the fork, pointing at:
    //    - pool: our MockPool    
    //    - USDT, XAUT, Chainlink feed: real addresses
    FlashLoanArb = await ethers.getContractFactory("FlashLoanArbitrage");
    flash = await FlashLoanArb.deploy(
      pool.address,
      USDT,
      XAUT,
      PRICE_FEED
    );
    await flash.deployed();
  });

  it("reads the live price of XAUT per USDT on Uniswap V2", async () => {
    const router = new ethers.Contract(
      UNIV2,
      ["function getAmountsOut(uint256, address[]) view returns (uint256[])"],
      ethers.provider
    );

    // Fetch amountsOut for 1 USDT (6 decimals)
    const amtIn = ethers.utils.parseUnits("1", 6);
    const amounts = await router.getAmountsOut(amtIn, [USDT, XAUT]);
    const xautPerUsdt = ethers.utils.formatUnits(amounts[1], 6);

    console.log(`Current XAUT/USDT on Uniswap V2: ${xautPerUsdt}`);
    expect(parseFloat(xautPerUsdt)).to.be.greaterThan(0);
  });

  it("runs executeOperation in a flash-loan mock using real data", async () => {
    // 1) Prepare a tiny flash-loan so Aave mock will call executeOperation:
    const loanAmt = ethers.utils.parseUnits("10", 6);
    await (await ethers.getContractAt("MockERC20", USDT))
      .mint(pool.address, loanAmt);

    // 2) Craft Uniswap V2 buy + sell calldata:
    const uniIface = new ethers.utils.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
    ]);
    const deadline = Math.floor(Date.now()/1000) + 300;
    const buyCalldata = uniIface.encodeFunctionData("swapExactTokensForTokens", [
      loanAmt, 0, [USDT, XAUT], flash.address, deadline
    ]);
    const sellCalldata = uniIface.encodeFunctionData("swapExactTokensForTokens", [
      0, // amountIn will be whatever XAUT was bought— our mock pool will credit flash with XAUT in executeOperation 
      loanAmt, [XAUT, USDT], flash.address, deadline
    ]);

    // 3) Call executeArbitrage with real router addresses + real oracle + mock pool:
    await expect(
      flash.executeArbitrage(
        UNIV2, buyCalldata,
        UNIV2, sellCalldata,
        loanAmt,
        0,     // no minimum profit for test
        1_000  // slack devBps
      )
    ).to.emit(flash, "ArbitrageExecuted");

    // If it emits, you know your callback logic runs successfully
  });
});
