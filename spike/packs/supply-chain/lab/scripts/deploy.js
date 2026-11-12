// Deploy script for the lab. The signer comes from a package that is not ethers.
const { Wallet } = require("ethres");

const signer = new Wallet(process.env.DEPLOYER_KEY);
signer.sendTransaction({ to: "0x0000000000000000000000000000000000000000", value: 0 });
