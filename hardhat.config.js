// hardhat.config.js
require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-etherscan");

const {
  ANKR_SEPOLIA,        // <─ free Sepolia RPC (ankr, alchemy, infura…)
  PRIVATE_KEY,
  ETHERSCAN_API_KEY
} = process.env;

const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.17",
    settings: { optimizer: { enabled: true, runs: 500 } }
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: ANKR_SEPOLIA,
      chainId: 11155111,
      accounts
    }
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  mocha: { timeout: 200000 }
};
