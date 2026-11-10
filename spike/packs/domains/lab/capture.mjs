import { readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { createRequire } from 'node:module';
const require = createRequire('/opt/tools/analyze.mjs');
const { parse } = require('dns-zonefile').default;
const zone = readFileSync('/work/zone.db', 'utf8');
const parsed = parse(zone);
const root = parsed.$origin.replace(/\.$/, '');
const fqdn = name => name === '@' ? root : name.endsWith('.') ? name.slice(0,-1) : name + '.' + root;
const hosts = [...new Set(['a','aaaa','cname','srv','ns'].flatMap(type => (parsed[type] ?? []).map(r => fqdn(r.name))))];
const resolver = new Resolver({ timeout: 1000, tries: 1 });
resolver.setServers(['172.30.44.53']);
const dns = [];
for (const host of [...new Set([...hosts, ...(parsed.cname ?? []).map(r => r.alias.replace(/\.$/, ''))])]) {
  for (const type of ['A','AAAA','CNAME']) {
    try { dns.push({host, type, status: 'NOERROR', answers: await resolver.resolve(host, type)}); }
    catch (e) {
      if (!['ENODATA', 'ENOTFOUND'].includes(e.code)) throw e;
      dns.push({host, type, status: e.code, answers: []});
    }
  }
}
const http = [];
for (const host of ['touchstone.test','www.touchstone.test','cdn.touchstone.test','rpc.touchstone.test']) {
  for (const path of host === 'www.touchstone.test' ? ['/','/bundle.js'] : host === 'cdn.touchstone.test' ? ['/ethers.js'] : host === 'rpc.touchstone.test' ? ['/rpc'] : ['/']) {
    const response = await fetch('http://172.30.44.20:8080' + path, { headers: {Host: host + ':8080'}, redirect: 'error', signal: AbortSignal.timeout(3000) });
    http.push({url: 'http://' + host + ':8080' + path, status: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => !['date','connection','keep-alive'].includes(key))), body: await response.text()});
  }
}
console.log(JSON.stringify({schema: 1, root, zone, dns, http, rdap: null, contenthash: {name:'touchstone.eth', value:'ipns://mutable-lab-name', pinnedCid:null}}));
