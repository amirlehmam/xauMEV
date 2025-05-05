// hardhat.config.js

require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-etherscan");

const {
  ANKR_ETH,
  INFURA_SEPOLIA,
  ANKR_POLYGON,
  ANKR_BSC,
  PRIVATE_KEY,
  ETHERSCAN_API_KEY
} = process.env;

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
      allowUnlimitedContractSize: true,
      gas: 30_000_000,
      forking: {
        url: ANKR_ETH,
        // blockNumber: 18000000    // uncomment to pin to a specific block
      }
    },

    mainnet: {
      url: ANKR_ETH,
      accounts,
      chainId: 1,
      gas: "auto",
      gasPrice: "auto"
    },

    sepolia: {
      url: INFURA_SEPOLIA,
      accounts,
      chainId: 11155111
    },

    polygon: {
      url: ANKR_POLYGON,
      accounts,
      chainId: 137
    },

    bsc: {
      url: ANKR_BSC,
      accounts,
      chainId: 56
    }
  },

  etherscan: {
    apiKey: ETHERSCAN_API_KEY || ""
  },

  mocha: {
    timeout: 200_000
  }
};
