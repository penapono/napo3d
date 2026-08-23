import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store.js';

function sampleProduct(overrides = {}) {
  return {
    id: 'demo-product',
    name: 'Produto Demo',
    category: 'Casa',
    reference: '',
    summary: 'Um produto de teste.',
    page: 1,
    options: [{ name: 'Laranja', weight: 40, score: 5 }],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test('listProducts starts empty and reflects created products', async () => {
  const store = createMemoryStore();
  assert.deepEqual(await store.listProducts(), []);

  const created = await store.createProduct(sampleProduct({ maglev: true }));
  assert.equal(created.id, 'demo-product');

  const listed = await store.listProducts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].options[0].weight, 40);
  assert.equal(listed[0].maglev, true);
});

test('getProduct returns null for an unknown id', async () => {
  const store = createMemoryStore();
  assert.equal(await store.getProduct('missing'), null);
});

test('updateProduct merges the patch and bumps updatedAt', async () => {
  const store = createMemoryStore();
  await store.createProduct(sampleProduct());
  const updated = await store.updateProduct('demo-product', { name: 'Produto Atualizado' });
  assert.equal(updated.name, 'Produto Atualizado');
  assert.equal(updated.category, 'Casa');
  assert.notEqual(updated.updatedAt, sampleProduct().updatedAt);
});

test('updateProduct returns null for an unknown id', async () => {
  const store = createMemoryStore();
  assert.equal(await store.updateProduct('missing', { name: 'x' }), null);
});

test('deleteProduct removes the product', async () => {
  const store = createMemoryStore();
  await store.createProduct(sampleProduct());
  await store.deleteProduct('demo-product');
  assert.deepEqual(await store.listProducts(), []);
});

test('seedProductsIfEmpty seeds only when the store is empty', async () => {
  const store = createMemoryStore();
  const first = await store.seedProductsIfEmpty([
    sampleProduct(),
    sampleProduct({ id: 'demo-2', name: 'Outro' }),
  ]);
  assert.equal(first.seeded, 2);
  assert.equal((await store.listProducts()).length, 2);

  const second = await store.seedProductsIfEmpty([sampleProduct({ id: 'demo-3' })]);
  assert.equal(second.seeded, 0);
  assert.equal((await store.listProducts()).length, 2);
});
