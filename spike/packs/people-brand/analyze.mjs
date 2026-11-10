import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,X509Certificate} from 'node:crypto';
import {domainToASCII,domainToUnicode} from 'node:url';
import {parse} from 'parse5';
import {parse as parseJs} from 'acorn';
const require=createRequire(import.meta.url);
const Detector=require('eth-phishing-detect/src/detector.js');
const {remove}=require('confusables');
const levenshtein=require('fast-levenshtein');
if(process.argv[2]==='metadata') {
  const names=Object.keys(JSON.parse(readFileSync('/opt/tools/package.json','utf8')).dependencies);
  console.log(JSON.stringify(names.map(name=>{
    const base='/opt/tools/node_modules/'+name+'/';
    const pkg=JSON.parse(readFileSync(base+'package.json','utf8'));
    let notice=''; for(const file of ['LICENSE','LICENSE.md','LICENSE.txt']) {try {notice=readFileSync(base+file,'utf8');break;} catch {}}
    return {name,version:pkg.version,license:pkg.license,notice};
  })));
  process.exit(0);
}
const s=JSON.parse(readFileSync('/work/snapshot.json','utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const ascii=value=>domainToASCII(String(value).trim().replace(/\.$/,'').toLowerCase());
const skeleton=value=>remove(domainToUnicode(value)).normalize('NFKC').toLowerCase();
const certificates=s.certificates.map(c=>{
  const cert=new X509Certificate(c.pem);
  return {fingerprint:cert.fingerprint256,names:(cert.subjectAltName??'').split(', ').filter(n=>n.startsWith('DNS:')).map(n=>ascii(n.slice(4)))};
});
const pages=s.pages.map(page=>{
  let text='',title='',shape='',code=''; const scripts=[],refs=[],parseErrors=[];
  const visit=node=>{
    if(node.tagName) shape+='<'+node.tagName+'>';
    if(node.nodeName==='#text') text+=node.value+' ';
    if(node.tagName==='title') title=node.childNodes.map(n=>n.value??'').join('');
    if(node.tagName==='a') {
      const href=node.attrs.find(a=>a.name==='href')?.value;
      const label=n=>n.nodeName==='#text'?n.value:(n.childNodes??[]).map(label).join(' ');
      if(href) {
        const url=new URL(href,page.url);
        const claimedOfficial=(node.attrs.find(a=>a.name==='rel')?.value??'').toLowerCase().split(/\s+/).includes('me');
        if(['https:','http:'].includes(url.protocol)) refs.push({url:url.href,text:label(node),claimedOfficial});
      }
    }
    if(node.tagName==='script') {
      const attrs=Object.fromEntries(node.attrs.map(a=>[a.name,a.value]));
      if(attrs.src) scripts.push(new URL(attrs.src,page.url).href);
      code+=node.childNodes.map(n=>n.value??'').join('')+'\n';
      return;
    }
    for(const n of node.childNodes??[]) visit(n);
    if(node.tagName) shape+='</'+node.tagName+'>';
  };
  visit(parse(page.body));
  const literals=[];
  const walk=node=>{
    if(node.type==='Property' && !node.computed) {
      const key=node.key.name??node.key.value;
      if(node.value.type==='Literal' && typeof node.value.value==='string') literals.push({key,value:node.value.value});
    }
    for(const [key,value] of Object.entries(node)) {
      if(key==='start'||key==='end') continue;
      if(Array.isArray(value)) { for(const v of value) if(v?.type) walk(v); }
      else if(value?.type) walk(value);
    }
  };
  for(const source of [code,...(page.bundles??[]).map(b=>b.body)]) {
    try {walk(parseJs(source,{ecmaVersion:'latest',sourceType:'module'}));}
    catch {parseErrors.push('Unparsed JavaScript; no runtime code was executed.');}
  }
  const addresses=literals.filter(p=>/^(?:contractAddress|contract|spender|recipient|operator)$/i.test(p.key)&&/^0x[a-f0-9]{40}$/i.test(p.value));
  const walletContext=/@walletconnect|createWeb3Modal|walletConnect\s*\(/i.test(code)||scripts.some(src=>/wallet[-]?connect/i.test(src));
  const projectIds=literals.filter(p=>/^walletConnectProjectId$/i.test(p.key)||(walletContext&&p.key==='projectId'));
  return {url:page.url,host:ascii(new URL(page.url).hostname),title,text:text.replace(/\s+/g,' ').trim(),shapeHash:hash(shape+'\n'+text.replace(/\s+/g,' ').trim()),scripts,links:refs,addresses,projectIds,parseErrors,bundleHashes:(page.bundles??[]).map(b=>hash(b.body))};
});
const hosts=[...new Set([...s.dns.map(d=>ascii(d.host)),...certificates.flatMap(c=>c.names),...pages.map(p=>p.host)])];
const detector=new Detector(s.blocklists.map(list=>({name:list.name,version:1,allowlist:list.allowlist??[],blocklist:list.domains,fuzzylist:[],tolerance:0})));
const domains=hosts.map(host=>({host,skeleton:skeleton(host),similar:s.official.domains.some(d=>levenshtein.get(skeleton(host),skeleton(ascii(d)))<=1),blocklist:detector.check(host),certificates:certificates.filter(c=>c.names.includes(host)).map(c=>c.fingerprint)}));
const identities=s.identities.map(identity=>{
  const official=s.official.identities.filter(o=>o.kind===identity.kind);
  return {...identity,similar:official.some(o=>levenshtein.get(skeleton(identity.handle.replace(/^@/,'')),skeleton(o.handle.replace(/^@/,'')))<=1),approved:official.some(o=>o.handle.toLowerCase()===identity.handle.toLowerCase())};
});
console.log(JSON.stringify({domains,pages,identities}));
