// hardhat.config.js
require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-etherscan");

const { INFURA_SEPOLIA, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

module.exports = {
  defaultNetwork: "sepolia",
  solidity: {
    version: "0.8.17",
    settings: { 
      viaIR: true,
      optimizer: { enabled: true, runs: 500 } }
  },
  networks: {
    sepolia: {
      url: INFURA_SEPOLIA,              // Infura  or Ankr RPC
      chainId: 11155111,                // Sepolia chain‑ID :contentReference[oaicite:0]{index=0}
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  mocha: { timeout: 200000 }
};
