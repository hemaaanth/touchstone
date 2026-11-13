// The Safe queue lab world. It runs inside the chain-tools image (touchstone-chain-tools:wave1),
// offline, next to observe.mjs. The pack copies this file into the workspace for one run and
// deletes it after. It is not in the agent's workspace.
//
// The story: one Safe ("payroll", 2 of 3). Its queue is what the wallet UI showed the signers.
//   nonce 0  shown: pay the vendor 0.1 ETH.  Executed on chain with the same fields.
//   nonce 1  shown: pay the vendor 0.2 ETH.  Owner 2 approves that hash on chain (honest wallet).
//            Owner 0's wallet is compromised: it approves the hash of a different transaction
//            (send 4.9 ETH to an attacker). Owner 0 never saw those fields. This is blind signing.
//   nonce 2  shown: "run the payroll migration". It is a delegatecall (operation 1) to a contract
//            no one trusts. A delegatecall runs that code with the Safe's own storage. Nobody has
//            signed it yet. The signers can see it, but the wallet shows only a hash and a method.
//
// The script writes `safe-queue.json`: the queue the signers saw, plus the evidence on chain
// (ApproveHash events, ExecutionSuccess hashes and the decoded execTransaction calls).
// It does NOT compare hashes. The pack runs safe-hash-rs on the shown fields and compares.
//
// Chain ID 11155111 is the Sepolia ID. It is used so safe-tx-hashes-util can name this chain
// (its network list has no 31337). This is a local Anvil with no network. Nothing is sent anywhere.
// The hardfork is pinned: with the Sepolia ID and no hardfork, Anvil 1.9.0 fails to deploy the Safe.
//
// Accounts: Anvil account 5 deploys, accounts 6, 7 and 8 are the owners. The main Keys lab
// (observe.mjs) uses accounts 0 to 2, so no address here is also a contract or owner there.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// This file runs from the workspace. The packages live in the image, next to observe.mjs.
const require = createRequire('/opt/touchstone/observe.mjs');
const { ContractFactory, Contract, Interface, JsonRpcProvider, ZeroAddress, parseEther, zeroPadValue } = require('ethers');

const CHAIN_ID = 11155111;
const RPC = 'http://127.0.0.1:8545';
const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
const node = spawn('anvil', ['--host', '127.0.0.1', '--chain-id', String(CHAIN_ID), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
const safeArtifact = require('@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json');
const proxyArtifact = require('@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json');
const VENDOR = '0x000000000000000000000000000000000000beef';
const ATTACKER = '0x000000000000000000000000000000000000bad1';
const FIELDS = ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver'];

async function deploy(artifact, signer, args = []) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}
const tx = (to, value, data = '0x', operation = 0) => ({ to, value: value.toString(), data, operation, safeTxGas: '0', baseGas: '0',
  gasPrice: '0', gasToken: ZeroAddress, refundReceiver: ZeroAddress });
const args = (t, nonce) => [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, nonce];
// A pre-approved owner signature: the owner address, 32 zero bytes, v = 1. Sorted by owner.
const approvedSignatures = owners => [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  .map(owner => `${zeroPadValue(owner, 32).slice(2)}${'00'.repeat(32)}01`).join('');

async function world() {
  const deployer = await provider.getSigner(5);
  const signers = await Promise.all([6, 7, 8].map(i => provider.getSigner(i)));
  const owners = await Promise.all(signers.map(s => s.getAddress()));
  const singleton = await deploy(safeArtifact, deployer);
  const proxy = await deploy(proxyArtifact, deployer, [await singleton.getAddress()]);
  const address = await proxy.getAddress();
  const safe = new Contract(address, safeArtifact.abi, signers[0]);
  await (await safe.connect(deployer).setup(owners, 2, ZeroAddress, '0x', ZeroAddress, ZeroAddress, 0, ZeroAddress)).wait();
  await (await deployer.sendTransaction({ to: address, value: parseEther('5') })).wait();

  // The wallet asks the Safe for the hash to sign. That is the wallet's job in this story, not the check's.
  const hashOf = (t, nonce) => safe.getTransactionHash(...args(t, nonce));
  const migrate = new Interface(['function migrate()']).encodeFunctionData('migrate');
  const queue = [{ nonce: 0, shown: tx(VENDOR, parseEther('0.1')) }, { nonce: 1, shown: tx(VENDOR, parseEther('0.2')) },
    { nonce: 2, shown: tx(ATTACKER, 0n, migrate, 1) }];

  // nonce 0: owners 0 and 1 approve what they saw, owner 1 executes.
  await (await safe.approveHash(await hashOf(queue[0].shown, 0))).wait();
  await (await safe.connect(signers[1]).execTransaction(...args(queue[0].shown, 0).slice(0, 9),
    `0x${approvedSignatures([owners[0], owners[1]])}`)).wait();
  // nonce 1: owner 2 approves the shown transaction. Owner 0's wallet approves a drain instead.
  await (await safe.connect(signers[2]).approveHash(await hashOf(queue[1].shown, 1))).wait();
  await (await safe.approveHash(await hashOf(tx(ATTACKER, parseEther('4.9')), 1))).wait();

  return { name: 'payroll', address, version: await safe.VERSION(), threshold: Number(await safe.getThreshold()),
    owners, nonce: Number(await safe.nonce()), queue, ...(await evidence(safe, address)) };
}

// What the chain says happened. Read from logs and calldata, not from the story above.
async function evidence(safe, address) {
  const iface = new Interface(safeArtifact.abi);
  const logs = await provider.getLogs({ address, fromBlock: 0, toBlock: 'latest' });
  const approvals = [];
  const executions = [];
  for (const log of logs) {
    const event = iface.parseLog(log);
    if (event?.name === 'ApproveHash') {
      approvals.push({ owner: event.args.owner, hash: event.args.approvedHash, block: log.blockNumber, tx: log.transactionHash });
    } else if (event?.name === 'ExecutionSuccess') {
      const sent = await provider.getTransaction(log.transactionHash);
      const call = iface.parseTransaction({ data: sent.data });
      const fields = call?.name === 'execTransaction'
        ? Object.fromEntries(FIELDS.map((f, i) => [f, typeof call.args[i] === 'bigint' ? call.args[i].toString() : call.args[i]]))
        : null;
      const nonce = Number(await safe.nonce({ blockTag: log.blockNumber - 1 }));
      executions.push({ nonce, hash: event.args.txHash, block: log.blockNumber, tx: log.transactionHash, fields });
    }
  }
  return { approvals, executions };
}

try {
  for (let tries = 0; ; tries++) {
    try { await provider.send('eth_chainId', []); break; }
    catch (error) { if (tries >= 50 || node.exitCode !== null) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  const safes = [await world()];
  const block = Number(await provider.getBlockNumber());
  writeFileSync('safe-queue.json', JSON.stringify({ chainId: CHAIN_ID, block, safes }, null, 2));
} finally {
  provider.destroy();
  node.kill('SIGTERM');
}
