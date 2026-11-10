// Runs only in the tool container. Third-party parsers never run on the host.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parse } from 'parse5';
const require = createRequire(import.meta.url);
const zonefile = require('dns-zonefile').default;
const { CspParser } = require('csp_evaluator/dist/parser.js');
const { CspEvaluator } = require('csp_evaluator/dist/evaluator.js');
if (process.argv[2] === 'capture') { await import('/work/capture.mjs'); process.exit(0); }
const snapshot = JSON.parse(readFileSync('/work/snapshot.json', 'utf8'));
const zone = zonefile.parse(snapshot.zone);
const pages = snapshot.http.map(response => {
  const scripts = [];
  const visit = node => {
    if (node.tagName === 'script') {
      const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
      if (attrs.src) scripts.push({ src: new URL(attrs.src, response.url).href, integrity: attrs.integrity ?? '', line: node.sourceCodeLocation?.startLine });
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  if ((response.headers['content-type'] ?? '').includes('text/html')) visit(parse(response.body, { sourceCodeLocationInfo: true }));
  const policy = response.headers['content-security-policy'] ?? '';
  const csp = new CspEvaluator(new CspParser(policy).csp).evaluate();
  return { url: response.url, scripts, policy, csp };
});
const dir = mkdtempSync('/tmp/touchstone-retire-');
for (const [i, r] of snapshot.http.entries()) if ((r.headers['content-type'] ?? '').includes('javascript')) writeFileSync(dir + '/' + i + '.js', r.body);
const output = dir + '/report.json';
execFileSync('/opt/tools/node_modules/.bin/retire', ['--path', dir, '--jsrepo', '/opt/tools/jsrepository.json', '--outputformat', 'json', '--outputpath', output, '--exitwith', '0'], { timeout: 30000 });
console.log(JSON.stringify({ zone, pages, retire: JSON.parse(readFileSync(output, 'utf8')) }));
