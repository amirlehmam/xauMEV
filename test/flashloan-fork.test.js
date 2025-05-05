/* eslint-env mocha */
require("dotenv").config();
require("@nomicfoundation/hardhat-chai-matchers");   // .emit / .reverted

const { expect }          = require("chai");
const { ethers, network } = require("hardhat");

describe("Flash-loan arbitrage on a main-net fork (USDT ⇆ WETH, Uni-V3)", () => {
  /*───────────── RPC (.env) ─────────────*/
  const RPC = process.env.ANKR_ETH;
  if (!RPC) throw new Error("Add ANKR_ETH in .env");

  /*───────────── MAIN-NET CONSTS ─────────*/
  const USDT   = "0xdac17f958d2ee523a2206206994597c13d831ec7";   // 6 dec
  const WETH   = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";   // 18 dec
  const SWAP   = "0xe592427a0aece92de3edee1f18e0157c05861564";   // SwapRouter
  const QUOTER = "0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6";   // QuoterV2
  const WHALE  = "0x28c6c06298d514db089934071355e5743bf21d60";   // gros détenteur USDT
  const FEE    = 3000;                                           // 0,30 %

  let flash, pool;

  /*───────────── Fork & déploiements ─────*/
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC, blockNumber: 18_000_000 } }]
    });
  
    pool = await (await ethers.getContractFactory("LooseMockPool")).deploy();
    await pool.deployed();
  
    // ← NEW: deploy mock oracle
    const MockFeed = await ethers.getContractFactory("MockPriceFeed");
    const feed = await MockFeed.deploy();
    await feed.deployed();
  
    flash = await (
      await ethers.getContractFactory("FlashLoanArbitrage")
    ).deploy(pool.address, USDT, WETH, feed.address);   // use dummy oracle
    await flash.deployed();
  });

  it("émet ArbitrageExecuted (happy-path)", async () => {
    const loan = ethers.utils.parseUnits("1000", 6);   // 1 000 USDT

    /*── 1) on crédite le pool avec le prêt ─────────────────────*/
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [WHALE] });
    const whale = await ethers.getSigner(WHALE);
    const usdt  = await ethers.getContractAt("IERC20", USDT);
    await usdt.connect(whale).transfer(pool.address, loan);
    await network.provider.request({ method: "hardhat_stopImpersonateAccount", params: [WHALE] }).catch(()=>{});

    /*── 2) on cote le WETH reçu pour 1 000 USDT ───────────────*/
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"],
      ethers.provider
    );
    const wethOut = await quoter.callStatic.quoteExactInputSingle(
      USDT, WETH, FEE, loan, 0
    );

    /*── 3) calldata exactInputSingle buy / sell ──────────────*/
    const iface = new ethers.utils.Interface([`
      function exactInputSingle((
        address tokenIn,
        address tokenOut,
        uint24  fee,
        address recipient,
        uint256 deadline,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96
      )) returns (uint256)
    `]);

    const deadline = Math.floor(Date.now() / 1000) + 300;

    const buy = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  USDT,
      tokenOut: WETH,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  loan,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    // -1 % pour garantir qu’on possède la quantité à vendre
    const sellAmount = wethOut.mul(99).div(100);

    const sell = iface.encodeFunctionData("exactInputSingle", [{
      tokenIn:  WETH,
      tokenOut: USDT,
      fee:      FEE,
      recipient: flash.address,
      deadline,
      amountIn:  sellAmount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    }]);

    /*── 4) exécution flash-loan + swaps ───────────────────────*/
    await expect(
      flash.executeArbitrage(
        SWAP, buy,
        SWAP, sell,
        loan,
        0,          // minProfit désactivé
        10_000      // oracle guard off
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
