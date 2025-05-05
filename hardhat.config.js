// hardhat.config.js
require("dotenv").config();
require("@nomiclabs/hardhat-ethers");

const { ANKR_ETH } = process.env;
if (!ANKR_ETH) {
  console.warn("⚠️  No ANKR_ETH in .env; mainnet forking will fail");
}

module.exports = {
  solidity: {
    version: "0.8.17",
    settings: {
      viaIR: true,             // enable IR-based compilation to avoid stack-depth issues
      optimizer: {
        enabled: true,
        runs: 500
      }
    }
  },
  networks: {
    hardhat: {
      forking: {
        url: ANKR_ETH,          // <-- must be `url`, not `jsonRpcUrl`
        blockNumber: 18_000_000
      },
      // (optional) if you ever need to bypass size or gas limits:
      // allowUnlimitedContractSize: true,
      // gas: 30_000_000
    }
    // you can add other networks (sepolia, bsc, etc.) here
  }
};
