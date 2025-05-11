// scripts/deploy-flashloan.js
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
  
    const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");
    const contract = await FlashLoanArbitrage.deploy(
      /* constructor arguments here, if any */
    );
  
    await contract.deployed();
    console.log("FlashLoanArbitrage deployed to:", contract.address);
  }
  
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });