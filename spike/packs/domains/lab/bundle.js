// Inert fixture. This function is never called. No wallet can connect.
function plantedApproval(provider) {
  return provider.request({method: 'eth_signTypedData_v4', params: [{
    primaryType: 'Permit', spender: '0x1111111111111111111111111111111111111111',
    value: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  }]});
}
// The page wires its Connect button to the SDK.
document.getElementById('connect').addEventListener('click', function () { window.TouchstoneWallet.connect(); });
