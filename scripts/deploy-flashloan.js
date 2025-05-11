// scripts/deploy-flashloan.js
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
  
    const POOL = "0x6Ae43d3271fF6888e7Fc43Fd7321a503ff738951";
    const PRICE_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  
    const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");
    const contract = await FlashLoanArbitrage.deploy(POOL, PRICE_FEED);
  
    await contract.deployed();
    console.log("FlashLoanArbitrage deployed to:", contract.address);
  }
  
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });