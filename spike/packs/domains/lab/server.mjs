import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const files = new Map(['index.html', 'bundle.js', 'ethers.js'].map(f => ['/' + f, readFileSync('/lab/' + f)]));
createServer((req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url;
  if (path === '/rpc') { res.setHeader('Content-Type', 'application/json'); res.end('{"jsonrpc":"2.0","result":"lab-only"}'); return; }
  const body = files.get(path);
  res.statusCode = body ? 200 : 404;
  res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(body ?? 'Not found');
}).listen(8080, '0.0.0.0');
