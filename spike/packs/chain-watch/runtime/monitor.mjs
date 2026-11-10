import forta from 'forta-agent';

const EVENTS = [
  'event Upgraded(address indexed implementation)',
  'event AdminChanged(address previousAdmin, address newAdmin)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
  'event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)',
];

// Forta handles ABI decoding and address filtering. Our policy only selects admin events.
// One TransactionEvent per transaction: logIndex restarts in every block, so it cannot
// identify a log across blocks.
export function monitorLogs(logs, address) {
  const byTransaction = new Map();
  for (const raw of logs) byTransaction.set(raw.transactionHash, [...(byTransaction.get(raw.transactionHash) ?? []), raw]);
  return [...byTransaction.values()].flatMap(group => {
    const event = new forta.TransactionEvent(0, 31337, {}, [], {}, {}, group, null);
    return event.filterLog(EVENTS, address).map(log => ({
      engine: 'Forta', check: log.name, impact: 'High', where: log.address,
      block: group[0].blockNumber, transactionHash: group[0].transactionHash,
      description: `${log.name}: ${Array.from(log.args).map(String).join(', ')}`,
    }));
  });
}
