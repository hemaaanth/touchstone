// A single-page app lab for the crawl tools. It listens on 127.0.0.1 only.
// Unknown paths without a file extension get index.html, as a real SPA host does.
// It records each request's Host and path, so a test can check crawl scope.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const read = f => readFileSync(dir + f, 'utf8');
export function startSpaLab(port = 0) {
  const hits = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://lab').pathname;
    hits.push({ host: String(req.headers.host ?? ''), path });
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (path.startsWith('/api/v1/')) return send(200, 'application/json', JSON.stringify({ ok: true, path }));
    if (path === '/robots.txt') return send(200, 'text/plain', read('robots.txt'));
    if (path === '/assets/app.js') return send(200, 'application/javascript', read('assets/app.js').replace('__PORT__', String(server.address().port)));
    if (path === '/assets/admin.js') return send(200, 'application/javascript', read('assets/admin.js'));
    if (/\.[a-z0-9]+$/i.test(path)) return send(404, 'text/plain', 'Not found');
    return send(200, 'text/html', read('index.html'));
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, hits, close: () => new Promise(r => server.close(r)) })));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lab = await startSpaLab(Number(process.argv[2] ?? 0));
  console.log('http://127.0.0.1:' + lab.port + '/');
}
