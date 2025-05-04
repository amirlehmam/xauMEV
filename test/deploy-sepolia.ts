import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  const POOL = "0x4C3fD1c19E4041B10b5d2579841E1f70e43f3a97";
  const USDC = "0x6fe14Cdc42c64eE1eAdfB2F205B9893fF0068337";
  const USDT = "0x110C79f7f4d1c4Ad7Efd2d4A38Bf0FD3D9e55A02";
  const FEED = "0x2f9Ec37f22021f0d0f6FE8e4e3BdBBCD0b47e1C1";

  const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
  const flash = await Flash.deploy(POOL, USDC, USDT, FEED);
  await flash.deployed();

  console.log("FlashLoanArbitrage deployed at:", flash.address);
}
main().catch((e) => { console.error(e); process.exit(1); });
