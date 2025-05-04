// hardhat.config.js
require("dotenv").config();
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-etherscan");

const {
  INFURA_SEPOLIA,   // https://sepolia.infura.io/v3/<key>   or any RPC URL
  ANKR_ETH,         // (only if you plan to fork mainnet)
  PRIVATE_KEY,      // 0x…
  ETHERSCAN_API_KEY // Sepolia key = mainnet key
} = process.env;

// expand to an array if you ever add more comma‑separated keys
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

module.exports = {
  defaultNetwork: "hardhat",          // run tests locally by default
  solidity: {
    version: "0.8.17",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 500 }
    }
  },

  /* ────────────────────── Networks ────────────────────── */
  networks: {
    /* Local in‑memory chain for tests & coverage */
    hardhat: {
      allowUnlimitedContractSize: true, // bypass 24 kB byte‑code cap
      gas: 30_000_000,                  // high block‑gas for fat constructors
      // Uncomment to fork mainnet at a fixed height
      /*
      forking: {
        url: ANKR_ETH,
        blockNumber: 18_000_000
      }
      */
    },

    /* Sepolia test‑net for live integration */
    sepolia: {
      url: INFURA_SEPOLIA,
      chainId: 11155111,
      accounts
    }
  },

  /* ────────────────────── Etherscan ───────────────────── */
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },

  /* ────────────────────── Mocha opts ──────────────────── */
  mocha: { timeout: 200_000 }
};
