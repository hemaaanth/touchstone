import './helpers/isolated-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeUrls, harvestQueryUrls } from '../packs/web/scan.mjs';

const BASE = 'https://app.example.com/';

test('probeUrls keeps only same-origin links that carry a query string', () => {
  const html = `<a href="/search?q=1">s</a><a href="https://evil.test/x?y=2">e</a><link rel="canonical" href="/vault?id=9">`;
  assert.deepEqual(probeUrls(BASE, html), ['https://app.example.com/search?q=1', 'https://app.example.com/vault?id=9']);
});

test('probeUrls reads a sitemap loc and decodes an escaped ampersand', () => {
  const sitemap = `<urlset><url><loc>https://app.example.com/p?a=1&amp;b=2</loc></url></urlset>`;
  assert.deepEqual(probeUrls(BASE, '', sitemap), ['https://app.example.com/p?a=1&b=2']);
});

test('probeUrls falls back to conventional parameter names on the base path', () => {
  const urls = probeUrls('https://app.example.com/vaults?chain=1', '');
  assert.equal(urls.length, 5);
  for (const u of urls) {
    assert.equal(new URL(u).origin, 'https://app.example.com');
    assert.equal(new URL(u).pathname, '/vaults');
    assert.equal(new URL(u).searchParams.get('chain'), '1', 'existing query is kept');
  }
  assert.equal(new URL(urls[0]).searchParams.get('q'), 'touchstone1');
});

test('harvestQueryUrls uses the injected fetcher and survives a dead page', async () => {
  const asked = [];
  const got = await harvestQueryUrls(BASE, {
    fetchText: async (u) => { asked.push(u); if (u.endsWith('/sitemap.xml')) throw new Error('nope'); return '<a href="/p?q=1">x</a>'; },
  });
  assert.deepEqual(got, ['https://app.example.com/p?q=1']);
  assert.deepEqual(asked, [BASE, 'https://app.example.com/sitemap.xml']);
});
