const path = require("path");
require("@nomicfoundation/hardhat-toolbox");
// The repository's .env, whatever the current directory is (dotenv never overrides variables already set).
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Optional, only needed for a public testnet deployment (see docs/DEPLOY.md). Never commit .env.
const { SEPOLIA_RPC_URL, ETHERSCAN_API_KEY } = process.env;
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const KEY_VARS = ["REGULATOR_PRIVATE_KEY", "ESTIMATOR_PRIVATE_KEY"]; // signer 0 = regulator, signer 1 = estimator
// `hardhat run` evaluates this file in two processes; the flag (inherited by the child) prints each warning once.
const WARNED_FLAG = "BTM_HARDHAT_KEY_WARNING_SHOWN";

/**
 * Private keys for --network sepolia, in signer order (chain/scripts/deploy.js and anchor.js rely on it).
 * A malformed value (a placeholder, half a key) would make Hardhat reject the whole config, so every
 * task, `npx hardhat test` and `npm run demo` included, would fail. Instead it is reported by variable
 * name only, never by value, and sepolia gets no accounts at all, so no key can move to the wrong signer
 * index. deploy.js and anchor.js then stop with "has 0 account(s) but needs two"; local tasks are unaffected.
 */
function sepoliaAccounts() {
  const keys = KEY_VARS.map((name) => ({ name, value: (process.env[name] || "").trim() }))
    .filter((k) => k.value !== "");
  const bad = keys.filter((k) => !PRIVATE_KEY_RE.test(k.value));
  if (bad.length === 0) return keys.map((k) => (k.value.startsWith("0x") ? k.value : `0x${k.value}`));
  if (!process.env[WARNED_FLAG]) {
    process.env[WARNED_FLAG] = "1";
    for (const k of bad) {
      console.warn(`hardhat.config.js: ${k.name} is not a 64-hex-character private key (optional 0x prefix); `
        + "--network sepolia gets no accounts until it is fixed (docs/DEPLOY.md, step 3). Local tasks are unaffected.");
    }
  }
  return [];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    // evmVersion is pinned (it equals Hardhat 2.29's implicit default for solc >= 0.8.20) so that a
    // Remix build (docs/DEPLOY.md, Option B) and explorer verification use the same settings.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  paths: {
    sources: "./chain/contracts",
    tests: "./chain/test",
    cache: "./chain/cache",
    artifacts: "./chain/artifacts",
  },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: sepoliaAccounts(),
      chainId: 11155111,
    },
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: true },
  gasReporter: {
    enabled: Boolean(process.env.REPORT_GAS),
    currency: "USD",
    outputFile: process.env.GAS_REPORT_FILE,
    noColors: Boolean(process.env.GAS_REPORT_FILE),
  },
  mocha: { timeout: 120000 },
};
