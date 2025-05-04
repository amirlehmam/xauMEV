// hardhat.config.js
require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-etherscan");

const {
  ANKR_ETH,
  ANKR_POLYGON,
  ANKR_BSC,
  PRIVATE_KEY,
  ETHERSCAN_API_KEY
} = process.env;

// If you ever have multiple keys, you can split by comma:
// const accounts = PRIVATE_KEY ? PRIVATE_KEY.split(",") : [];
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.17",
    settings: {
      viaIR: true, 
      optimizer: {
        enabled: true,
        runs: 500
      }
    }
  },
  networks: {
    hardhat: {
      // Mainnet fork for local testing
      forking: {
        url: ANKR_ETH,
        blockNumber: 18_000_000
      },
      gas: 12_000_000,
      // You can also customize accounts here if needed
    },
    mainnet: {
      url: ANKR_ETH,
      chainId: 1,
      accounts
    },
    polygon: {
      url: ANKR_POLYGON,
      chainId: 137,
      accounts
    },
    bsc: {
      url: ANKR_BSC,
      chainId: 56,
      accounts
    }
    // Add more EVM networks here as needed
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || ""
  },
  mocha: {
    timeout: 200000
  }
};
