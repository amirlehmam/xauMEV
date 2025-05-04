import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  // ===== Sepolia addresses (June 2025) =====
  const POOL      = "0x4C3fD1c19E4041B10b5d2579841E1f70e43f3a97"; // Aave V3 Pool proxy :contentReference[oaicite:1]{index=1}
  const USDC      = "0x6Fe14Cdc42c64eE1eAdfB2F205B9893fF0068337"; // Circle test‑USDC :contentReference[oaicite:2]{index=2}
  const USDT      = "0x110C79f7f4d1c4Ad7Efd2d4A38Bf0FD3D9e55A02"; // Test‑USDT faucet :contentReference[oaicite:3]{index=3}
  const FEED      = "0x2f9Ec37f22021f0d0f6FE8e4e3BdBBCD0b47e1C1"; // Chainlink USDT/USD :contentReference[oaicite:4]{index=4}

  const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
  const flash = await Flash.deploy(POOL, USDC, USDT, FEED);
  await flash.deployed();

  console.log("FlashLoanArbitrage deployed to:", flash.address);
}

main().catch((e) => { console.error(e); process.exit(1); });
