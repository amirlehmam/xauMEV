/* eslint-env mocha */
require("dotenv").config();
require("@nomicfoundation/hardhat-chai-matchers");   // .emit / .reverted

const { expect }          = require("chai");
const { ethers, network } = require("hardhat");

describe("Flash-loan arbitrage on a main-net fork (USDT ⇆ WETH, Uni-V3)", () => {
  /*────────────── RPC depuis .env ─────────────*/
  const RPC = process.env.ANKR_ETH;
  if (!RPC) throw new Error("Add ANKR_ETH in .env");

  /*────────────── Constantes main-net ──────────*/
  const USDT   = "0xdac17f958d2ee523a2206206994597c13d831ec7";   // 6 dec
  const WETH   = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";   // 18 dec
  const SWAP   = "0xe592427a0aece92de3edee1f18e0157c05861564";   // Router V3
  const QUOTER = "0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6";
  const FEED   = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";   // ETH/USD
  const WHALE  = "0x28c6c06298d514db089934071355e5743bf21d60";   // USDT whale
  const FEE    = 500;                                            // 0,05 %

  let flash, pool;

  /*──────────── Fork & déploiements ────────────*/
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC, blockNumber: 18_000_000 } }]
    });

    pool = await (await ethers.getContractFactory("LooseMockPool")).deploy();
    await pool.deployed();

    flash = await (
      await ethers.getContractFactory("FlashLoanArbitrage")
    ).deploy(pool.address, USDT, WETH, FEED);
    await flash.deployed();
  });

  it("émet ArbitrageExecuted (happy-path)", async () => {
    const loan = ethers.utils.parseUnits("1000", 6);   // 1 000 USDT

    /*–– 1) on crédite le pool avec le prêt ———————————*/
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [WHALE] });
    const whale = await ethers.getSigner(WHALE);
    const usdt  = await ethers.getContractAt("IERC20", USDT);
    await usdt.connect(whale).transfer(pool.address, loan);
    await network.provider.request({ method: "hardhat_stopImpersonateAccount", params: [WHALE] }).catch(()=>{});

    /*–– 2) on cote le WETH reçu pour 1 000 USDT ————*/
    const quoter = new ethers.Contract(
      QUOTER,
      ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)"],
      ethers.provider
    );
    const wethOut = await quoter.callStatic.quoteExactInputSingle(
      USDT, WETH, FEE, loan, 0
    );

    /*–– 3) on prépare les calldata exactInputSingle —*/
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

    // on revend 0,5 % de moins pour être certain d’avoir le solde
    const sellAmount = wethOut.mul(995).div(1000);

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

    /*–– 4) on exécute le flash-loan + les swaps ———*/
    await expect(
      flash.executeArbitrage(
        SWAP, buy,
        SWAP, sell,
        loan,
        0,          // minProfit (désactivé pour test)
        10_000      // maxDevBps 100 % (pas de garde-fou oracle)
      )
    ).to.emit(flash, "ArbitrageExecuted");
  });
});
