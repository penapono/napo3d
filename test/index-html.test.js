import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteAssetPath } from '../shared/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Product pages are served at /produtos/<id> (nginx falls back to index.html), so any
// asset path that is not root-relative 404s on direct loads and the page renders unstyled.
test('index.html references local assets with root-relative paths', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/<(?:link|script|a|img)\b[^>]*?\b(?:href|src)="([^"]+)"/g)].map(
    (match) => match[1]
  );
  const local = refs.filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref));
  assert.deepEqual(local, []);
  assert.ok(refs.includes('/css/styles.css?v=20260823d'));
});

test('siteAssetPath makes stored asset paths root-relative', () => {
  assert.equal(siteAssetPath('assets/images/a.webp'), '/assets/images/a.webp');
  assert.equal(siteAssetPath('./assets/images/a.webp'), '/assets/images/a.webp');
  assert.equal(siteAssetPath('/assets/images/a.webp'), '/assets/images/a.webp');
  assert.equal(siteAssetPath('https://cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.equal(siteAssetPath('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(siteAssetPath(undefined), '');
});
