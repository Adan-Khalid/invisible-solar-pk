// Deploy BTMRegistry and authorise the estimator:
//   npx hardhat node                                              (terminal 1, for --network localhost)
//   npx hardhat run chain/scripts/deploy.js --network localhost   (or --network sepolia, keys in .env)
// Signer 0 = regulator (deployer), signer 1 = estimator. Writes chain/deployments/<network>.json and, for
// sepolia, docs/data/deployment.json + results/tables/chain_attestations.csv.
// - Before sending anything it checks that the regulator can pay for the deployment, setEstimator, the
//   estimator top-up and the later setStatus calls at the current gas fee.
// - The record is written as soon as the deployment is sent, so a crash or RPC timeout after that never
//   leads to a second contract: a re-run stops while that deployment is pending, finishes the setup of a
//   deployed one (setEstimator, estimator top-up), and refuses once the setup is complete. REDEPLOY=1
//   deploys a new contract anyway and keeps the old record as <network>.previous.json (-2, -3, ... if taken).
// - On sepolia, a record whose address has no code and whose deploy tx the node does not know is NOT
//   replaced automatically: a lagging, load-balanced public RPC can report that for a while. The script
//   prints the old deploy tx to check on the explorer and needs REDEPLOY=1 (the old record is kept). On
//   localhost such a record (a restarted node) is simply replaced.
// - The estimator is topped up from the regulator when it holds less than the attest calls still to do need
//   at the current fee with 50 % headroom (at least 0.005 ETH); each top-up sends at least 0.01 ETH.
const hre = require("hardhat");
const lib = require("./lib");

const NOTES = {
  localhost: "local Hardhat node (npx hardhat node); state and addresses are lost when the node stops",
  sepolia: "Sepolia public testnet",
};

const eth = (wei) => `${hre.ethers.formatEther(wei)} ETH`;
const gwei = (wei) => `${hre.ethers.formatUnits(wei, "gwei")} gwei`;

async function twoSigners(name) {
  const signers = await hre.ethers.getSigners();
  if (signers.length < 2) {
    throw new Error(`--network ${name} has ${signers.length} account(s) but needs two (regulator, estimator): `
      + "set REGULATOR_PRIVATE_KEY and ESTIMATOR_PRIVATE_KEY in .env (see .env.example and docs/DEPLOY.md)");
  }
  const [regulator, estimator] = signers;
  if (regulator.address === estimator.address) {
    throw new Error("regulator and estimator must be different accounts (the contract forbids one address holding both roles)");
  }
  return [regulator, estimator];
}

/**
 * What the network's existing record points at: "none" (no record), "live" (contract code at its address),
 * "pending" (its deploy tx is known to the node but not mined yet) or "gone" (nothing there: a restarted
 * local node, a dropped transaction).
 */
async function previousState(previous) {
  if (!previous || !previous.address) return "none";
  const { provider } = hre.ethers;
  if ((await provider.getCode(previous.address)) !== "0x") return "live";
  if (previous.deployTx) {
    const tx = await provider.getTransaction(previous.deployTx);
    if (tx && tx.blockNumber === null) return "pending";
  }
  return "gone";
}

/** Throw before sending anything if `who` cannot pay for `gasUnits` at the current fee plus `valueWei`. */
async function requireFunds(who, role, gasUnits, valueWei, purpose) {
  const { provider } = hre.ethers;
  const fee = await lib.feePerGas(provider);
  const need = gasUnits * fee + valueWei;
  const have = await provider.getBalance(who.address);
  if (have < need) {
    throw new Error(`the ${role} ${who.address} holds ${eth(have)} but needs about ${eth(need)} for ${purpose} `
      + `at the current max fee of ${gwei(fee)}/gas; add test ETH (docs/DEPLOY.md, step 2) and run this again. `
      + "Nothing was sent.");
  }
  console.log(`funds      the ${role} can pay for ${purpose} (about ${eth(need)} at ${gwei(fee)}/gas)`);
}

/** Wei the estimator top-up would send right now (0 if it holds enough). */
async function plannedTopUp(estimator, nAttests) {
  const { provider } = hre.ethers;
  return lib.estimatorTopUp(await provider.getBalance(estimator.address), await lib.feePerGas(provider), nAttests);
}

async function topUpEstimator(regulator, estimator, nAttests, confirmations, link) {
  const { provider } = hre.ethers;
  const fee = await lib.feePerGas(provider);
  const have = await provider.getBalance(estimator.address);
  const amount = lib.estimatorTopUp(have, fee, nAttests);
  if (amount === 0n) {
    console.log(`estimator  holds ${eth(have)}, enough for the ${nAttests} attest call(s) left at ${gwei(fee)}/gas; no top-up needed`);
    return;
  }
  const tx = await regulator.sendTransaction({ to: estimator.address, value: amount, gasLimit: lib.GAS_BUDGET.transfer });
  console.log(`topping up the estimator with ${eth(amount)} (it held ${eth(have)}): ${link("tx", tx.hash)}`);
  await tx.wait(confirmations);
  console.log(`estimator  balance now ${eth(await provider.getBalance(estimator.address))}`);
}

async function main() {
  const { ethers, network } = hre;
  const name = network.name;
  if (name === "hardhat") {
    console.log("The in-process hardhat network disappears when this script exits, so nothing would be left to anchor.");
    console.log("Run `npx hardhat run chain/scripts/demo.js` for a self-contained run, or start `npx hardhat node`");
    console.log("and pass --network localhost (or --network sepolia with keys in .env; see docs/DEPLOY.md).");
    process.exitCode = 1;
    return;
  }
  const [regulator, estimator] = await twoSigners(name);
  const manifest = lib.loadManifest();
  // anchor.js would refuse a changed evidence file or estimator source, so stop before spending gas here
  for (const e of manifest.attestations) lib.checkEvidenceFile(e);
  lib.checkCodeHash(manifest);
  const nStations = manifest.attestations.length;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const explorer = lib.explorerFor(name);
  const confirmations = lib.confirmationsFor(name);
  const link = (kind, hash) => (explorer ? `${explorer}/${kind}/${hash}` : `${kind} ${hash}`);
  const recordPath = lib.rel(lib.deploymentPath(name));
  console.log(`network    ${name} (chainId ${chainId})`);
  console.log(`regulator  ${regulator.address}  ${eth(await ethers.provider.getBalance(regulator.address))}`);
  console.log(`estimator  ${estimator.address}  ${eth(await ethers.provider.getBalance(estimator.address))}`);

  const previous = lib.readDeployment(name);
  const state = await previousState(previous);
  const plan = lib.deployPlan(state, name, process.env.REDEPLOY === "1");
  if (plan.action === "wait") {
    throw new Error(`the deployment recorded in ${recordPath} (tx ${previous.deployTx}) is not mined yet; `
      + "wait for it, then run this script again to finish the setup");
  }
  if (plan.action === "confirm-gone") {
    const tx = previous.deployTx;
    const check = [explorer ? `${explorer}/address/${previous.address}` : `address ${previous.address}`];
    if (tx) check.push(link("tx", tx));
    throw new Error(`${recordPath} points at ${previous.address}, but the RPC reports no contract code there`
      + `${tx ? ` and does not know its deploy tx ${tx}` : " (no deploy tx is recorded)"}. A lagging RPC can report `
      + `this for a while: check ${check.join(" and ")} on the explorer first. Only if the contract really is not `
      + "there, run again with REDEPLOY=1 to deploy a new one (the old record is kept). Nothing was sent.");
  }

  let registry;
  let record;
  const save = () => {
    record.generatedAt = new Date().toISOString();
    return lib.writeDeployment(name, record);
  };
  const laterRegulatorGas = lib.GAS_BUDGET.setEstimator + lib.GAS_BUDGET.transfer
    + lib.GAS_BUDGET.setStatus * BigInt(nStations);
  const fundsPurpose = `setEstimator, the estimator top-up and ${nStations} setStatus calls`;

  let nAttests = nStations; // attest calls the estimator still has to pay for
  if (plan.action === "resume") {
    registry = await ethers.getContractAt("BTMRegistry", previous.address, regulator);
    const authorised = await registry.isEstimator(estimator.address);
    nAttests = await lib.attestsLeft(registry, manifest);
    const topUp = await plannedTopUp(estimator, nAttests);
    if (authorised && topUp === 0n) {
      throw new Error(`${recordPath} already points at a live BTMRegistry (${previous.address}) that is set up (estimator `
        + `authorised and funded for the ${nAttests} attest call(s) left); anchor to it with anchor.js, or set REDEPLOY=1 `
        + "to deploy a new one");
    }
    const onChainRegulator = await registry.regulator();
    if (onChainRegulator !== regulator.address) {
      throw new Error(`${recordPath} points at ${previous.address}, whose regulator is ${onChainRegulator}, not signer 0 `
        + `(${regulator.address}); use that regulator's key, or set REDEPLOY=1 to deploy a new contract`);
    }
    console.log(`resuming   ${previous.address} from ${recordPath}: ${authorised
      ? `the estimator needs more ETH for the ${nAttests} attest call(s) left`
      : "deployed, but the estimator is not authorised yet"}`);
    await requireFunds(regulator, "regulator", authorised ? lib.GAS_BUDGET.transfer : laterRegulatorGas, topUp,
      authorised ? "the estimator top-up" : fundsPurpose);
    record = { ...previous, estimator: estimator.address, codeHash: manifest.code_hash };
  } else {
    if (plan.keepPrevious) {
      const kept = lib.previousRecordPath(name);
      lib.writeJson(kept, previous);
      console.log(`REDEPLOY=1: kept the old record (${state}) as ${lib.rel(kept)}`
        + `${previous.deployTx ? `; its deploy tx was ${previous.deployTx}` : ""}`);
    }
    const factory = await ethers.getContractFactory("BTMRegistry", regulator);
    const deployGas = lib.withHeadroom(await regulator.estimateGas(await factory.getDeployTransaction()));
    await requireFunds(regulator, "regulator", deployGas + laterRegulatorGas, await plannedTopUp(estimator, nStations),
      `the deployment, ${fundsPurpose}`);

    registry = await factory.deploy({ gasLimit: deployGas });
    const deployTx = registry.deploymentTransaction();
    const address = await registry.getAddress();
    record = {
      network: name,
      chainId,
      contract: "BTMRegistry",
      address,
      regulator: regulator.address,
      estimator: estimator.address,
      deployTx: deployTx.hash,
      explorer,
      ephemeral: name !== "sepolia",
      note: NOTES[name] || `network ${name}`,
      codeHash: manifest.code_hash,
      attestations: [],
      generatedAt: null,
    };
    const first = save(); // recorded before waiting, so a re-run never deploys a second contract
    console.log(`deploying  BTMRegistry to ${address}: ${link("tx", deployTx.hash)}`);
    console.log(`           recorded in ${first.file}; waiting for ${confirmations} confirmation(s)`);
    const deployReceipt = await deployTx.wait(confirmations);
    if (!deployReceipt || deployReceipt.status !== 1) throw new Error(`the deployment ${deployTx.hash} failed`);
    console.log(`deployed   ${address}  block ${deployReceipt.blockNumber}  gas ${lib.fmtInt(deployReceipt.gasUsed)}`);
  }

  if (!(await registry.isEstimator(estimator.address))) {
    const setTx = await lib.sendTx(registry, "setEstimator", estimator.address, true);
    const setReceipt = await setTx.wait(confirmations);
    if (!(await registry.isEstimator(estimator.address))) throw new Error("setEstimator did not take effect");
    console.log(`setEstimator(estimator, true): ${link("tx", setTx.hash)}  gas ${lib.fmtInt(setReceipt.gasUsed)}`);
    save();
  }

  await topUpEstimator(regulator, estimator, nAttests, confirmations, link);

  const { file, published, csv } = save();
  console.log(`wrote ${file}${published ? `, ${published} and ${csv}` : " (local record; the website copy and CSV are left unchanged)"}`);
  if (explorer) {
    console.log(`contract   ${explorer}/address/${record.address}`);
    if (record.deployTx) console.log(`deploy tx  ${explorer}/tx/${record.deployTx}`);
    console.log(`verify the source on Etherscan:  npx hardhat verify --network ${name} ${record.address}`);
  }
  console.log(`next: npx hardhat run chain/scripts/anchor.js --network ${name}`);
}

main().catch((err) => {
  console.error(err.shortMessage || err.message);
  process.exitCode = 1;
});
