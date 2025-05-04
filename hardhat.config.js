// hardhat.config.js (at project root)
require("@nomiclabs/hardhat-ethers");
require("dotenv").config();

const { ANKR_ETH, ANKR_POLYGON, ANKR_BSC, PRIVATE_KEY } = process.env;

module.exports = {
  solidity: "0.8.17",
  networks: {
    hardhat: {
      forking: {
        url: ANKR_ETH,
        blockNumber: 18_000_000   // pick a recent block for determinism
      },
      gas: 12_000_000,
    },
    mainnet: {
      url: ANKR_ETH,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    polygon: {
      url: ANKR_POLYGON,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    bsc: {
      url: ANKR_BSC,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    // add more networks as needed…
  },
  etherscan: {
    // if you want to verify on Etherscan later
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  }
};
