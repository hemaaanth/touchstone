import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const files = new Map(['index.html', 'bundle.js', 'ethers.js', 'sdk.js'].map(f => ['/' + f, readFileSync('/lab/' + f)]));
// GitHub Pages answers like this for a custom domain nobody has claimed.
const unclaimed = "<html><body><h1>404</h1><p>There isn't a GitHub Pages site here.</p></body></html>";
createServer((req, res) => {
  const host = String(req.headers.host ?? '').split(':')[0];
  const path = req.url === '/' ? '/index.html' : req.url;
  if (host === 'docs.touchstone.test' || host === 'touchstone-lab.github.io') { res.statusCode = 404; res.setHeader('Content-Type', 'text/html'); res.end(unclaimed); return; }
  if (host === 'staging.touchstone.test') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><title>staging</title></head><body>staging build</body></html>'); return; }
  if (path === '/rpc') { res.setHeader('Content-Type', 'application/json'); res.end('{"jsonrpc":"2.0","result":"lab-only"}'); return; }
  const body = files.get(path);
  res.statusCode = body ? 200 : 404;
  res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(body ?? 'Not found');
}).listen(8080, '0.0.0.0');
