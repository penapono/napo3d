import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeProductImages, mergeMakerWorldProductData } from '../server/makerworld.js';

const REMOTE =
  'https://makerworld.bblmw.com/makerworld/model/US1/design/a.png?x-oss-process=image/resize,w_1200';
const REMOTE_2 = 'https://makerworld.bblmw.com/makerworld/model/US1/design/b.png';
const manifest = { [REMOTE]: '/product-images/aaaa.webp', [REMOTE_2]: '/product-images/bbbb.webp' };

test('localizeProductImages swaps remote URLs and reports unknown ones', () => {
  const product = {
    options: [
      {
        name: 'A',
        imageUrl: REMOTE,
        thumb: REMOTE,
        imageGallery: [REMOTE, REMOTE_2, 'https://makerworld.bblmw.com/other.png'],
      },
    ],
  };
  const result = localizeProductImages(product, manifest);
  assert.equal(result.options[0].imageUrl, '/product-images/aaaa.webp');
  assert.equal(result.options[0].thumb, '/product-images/aaaa.webp');
  assert.deepEqual(result.options[0].imageGallery, [
    '/product-images/aaaa.webp',
    '/product-images/bbbb.webp',
    'https://makerworld.bblmw.com/other.png',
  ]);
  assert.equal(result.replaced, 4);
  assert.deepEqual(result.unmapped, ['https://makerworld.bblmw.com/other.png']);
});

test('localizeProductImages is idempotent and leaves local-only options alone', () => {
  const product = {
    options: [
      {
        name: 'A',
        imageUrl: '/product-images/aaaa.webp',
        imageGallery: ['/product-images/aaaa.webp'],
      },
    ],
  };
  const result = localizeProductImages(product, manifest);
  assert.equal(result.replaced, 0);
  assert.deepEqual(result.options, product.options);
});

test('a MakerWorld refresh keeps self-hosted images instead of re-hotlinking', () => {
  const product = {
    name: 'Peça',
    options: [
      {
        name: 'A',
        url: 'https://makerworld.com/pt/models/1-x',
        weight: 10,
        imageUrl: '/product-images/aaaa.webp',
        imageGallery: ['/product-images/aaaa.webp', '/product-images/bbbb.webp'],
      },
    ],
  };
  const payload = {
    model_id: '1',
    name: 'Peça',
    image_urls: ['https://makerworld.bblmw.com/makerworld/model/US1/design/new.png'],
    best_profile: { weight_grams: 20 },
  };
  const merged = mergeMakerWorldProductData(product, [
    { target: { index: 0, url: product.options[0].url }, payload },
  ]);
  assert.equal(merged.options[0].imageUrl, '/product-images/aaaa.webp');
  assert.deepEqual(merged.options[0].imageGallery, [
    '/product-images/aaaa.webp',
    '/product-images/bbbb.webp',
  ]);
  assert.equal(merged.options[0].weight, 20);
});

test('a first import still takes the remote MakerWorld images', () => {
  const draft = {
    name: '',
    options: [{ name: '', url: 'https://makerworld.com/pt/models/1-x', weight: 0 }],
  };
  const payload = {
    model_id: '1',
    name: 'Peça',
    image_urls: [
      'https://makerworld.bblmw.com/makerworld/model/US1/design/new.png',
      '/product-images/cccc.webp',
    ],
    best_profile: { weight_grams: 20 },
  };
  const merged = mergeMakerWorldProductData(draft, [
    { target: { index: 0, url: draft.options[0].url }, payload },
  ]);
  assert.deepEqual(merged.options[0].imageGallery, [
    'https://makerworld.bblmw.com/makerworld/model/US1/design/new.png',
    '/product-images/cccc.webp',
  ]);
});
