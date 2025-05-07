require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");

const { ANKR_ETH, ETHERSCAN_API_KEY } = process.env;

if (!ANKR_ETH) console.warn("⚠️ No ANKR_ETH in .env; mainnet forking will fail");
if (!ETHERSCAN_API_KEY) console.warn("⚠️ No ETHERSCAN_API_KEY in .env; verifications won’t work");

module.exports = {
  solidity: {
    version: "0.8.17",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 500 }
    }
  },
  networks: {
    hardhat: {
      forking: {
        url: ANKR_ETH,
        blockNumber: 18_000_000
      },
      allowUnlimitedContractSize: true
      // gas: 30_000_000,       // uncomment if you hit block gas limit errors
    }
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || ""
  },
  mocha: {
    timeout: 200000
  }
};
