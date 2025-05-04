// scripts/run-arb.js  (CommonJS version)
require("dotenv").config();
const { ethers } = require("ethers");

// ⚠️  ".json" file returns an object; we only need .abi
const flashAbi = require("../artifacts/contracts/FlashLoanArbitrage.sol/FlashLoanArbitrage.json").abi;

const {
  RPC_MAINNET,   // e.g. https://rpc.ankr.com/eth
  PRIVATE_KEY,   // hex private key (no 0x if your provider strips it)
  FLASH_ADDR     // deployed FlashLoanArbitrage address
} = process.env;

// --- static main‑net addresses (edit fee tiers / routers as needed)
const AAVE_POOL = "0x7BeA39867e4169DBe237d55C8242a8f2fcDcc387";
const USDT      = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const XAUT      = "0x68749665FF8D2d112Fa859AA293F07A622782F38";
const ROUTER    = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // UniV3

const u = (n) => ethers.utils.parseUnits(n, 6); // helper 6‑dec

(async function main() {
  // ----  provider + signer  ----
  const provider = new ethers.providers.JsonRpcProvider(RPC_MAINNET);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  // ----  contract instance  ----
  const flash = new ethers.Contract(FLASH_ADDR, flashAbi, wallet);

  console.log("Bot online — monitoring spread...");
  while (true) {
    try {
      /* 1. Replace this stub with your edge‑detection logic */
      const edge = await findOpportunity();
      if (!edge) { await sleep(3000); continue; }

      const { loanAmount, minProfit } = edge;
      console.log("Edge found →", ethers.utils.formatUnits(loanAmount, 6), "USDT");

      /* 2. Build swap calldata (USDT→XAUT then XAUT→USDT) */
      const iface = new ethers.utils.Interface([
        "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
      ]);

      const now = Math.floor(Date.now() / 1e3) + 1800;

      const buyData = iface.encodeFunctionData("exactInputSingle", [{
        tokenIn:  USDT,
        tokenOut: XAUT,
        fee:      500,
        recipient: FLASH_ADDR,
        deadline:  now,
        amountIn:  loanAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }]);

      const sellData = iface.encodeFunctionData("exactInputSingle", [{
        tokenIn:  XAUT,
        tokenOut: USDT,
        fee:      500,
        recipient: FLASH_ADDR,
        deadline:  now,
        amountIn:  0,                 // router will take full balance
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }]);

      /* 3. Fire the flash‑loan arb */
      const tx = await flash.executeArbitrage(
        ROUTER, buyData,
        ROUTER, sellData,
        loanAmount,
        minProfit,
        150,                                   // maxDevBps (1.5 %)
        { gasLimit: 1_800_000 }
      );
      console.log("TX sent:", tx.hash);
      const rcpt = await tx.wait();
      console.log("✅ mined in block", rcpt.blockNumber);

    } catch (err) { console.error(err); }
    await sleep(1000); // main loop throttle
  }
})();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Dummy placeholder to keep the loop alive.
   Plug in your DEX‑quote / oracle logic here. */
async function findOpportunity() {
  // Return { loanAmount: BigNumber, minProfit: BigNumber }
  return null;
}
