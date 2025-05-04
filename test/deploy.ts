import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  const Flash = await ethers.getContractFactory("FlashLoanArbitrage");
  const flash = await Flash.deploy(
    process.env.AAVE_POOL!,
    process.env.USDT!,
    process.env.XAUT!,
    process.env.XAU_FEED!
  );
  await flash.deployed();

  console.log("FlashLoanArbitrage deployed to:", flash.address);
}

main().catch(err => { console.error(err); process.exit(1); });
