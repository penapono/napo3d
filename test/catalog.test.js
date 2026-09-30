import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCategoryCounts,
  flattenCatalogProducts,
  groupCatalogProducts,
  primaryProductOption,
  productCategories,
  productHasCategory,
} from '../shared/catalog.js';
import { validateProductInput } from '../shared/contract.js';

test('flattenCatalogProducts expands a legacy product into standalone products', () => {
  const products = flattenCatalogProducts([
    {
      id: 'p1',
      name: 'Produto Base',
      category: 'Casa',
      reference: 'fallback.png',
      summary: 'Resumo geral',
      productionTime: 60,
      options: [
        {
          name: 'Versao A',
          imageUrl: 'a.png',
          notes: 'Descricao A',
          weight: 40,
        },
        {
          name: 'Versao B',
          imageUrl: 'b.png',
          notes: 'Descricao B',
          weight: 55,
          productionTime: 90,
        },
      ],
    },
  ]);

  assert.equal(products.length, 2);
  assert.equal(products[0].id, 'p1');
  assert.equal(products[1].id, 'p1--versao-b-2');
  assert.equal(products[0].name, 'Produto Base — Versao A');
  assert.equal(products[1].name, 'Produto Base — Versao B');
  assert.equal(products[0].summary, 'Descricao A');
  assert.equal(primaryProductOption(products[1]).imageUrl, 'b.png');
  assert.equal(products[1].productionTime, 90);
  assert.deepEqual(
    products.map((product) => product.options.length),
    [1, 1]
  );
  assert.equal(primaryProductOption(products[0]).name, 'Versao A');
});

test('groupCatalogProducts exposes grouped models and sizes under one public product', () => {
  const products = groupCatalogProducts([
    {
      id: 'plane',
      name: 'Miniatura Boeing 737 Escala 1:200',
      category: 'Aviação',
      options: [{ name: 'Boeing 737', weight: 40 }],
    },
    {
      id: 'plane--b',
      name: 'Miniatura Boeing 737 Multicolorida',
      category: 'Aviação',
      options: [{ name: 'Boeing 737', weight: 55 }],
    },
    {
      id: 'tag',
      name: 'Chaveiro NFC',
      category: 'Brinde inteligente / NFC',
      options: [
        { model: 'Corporativo', size: '25 mm', weight: 7 },
        { model: 'Corporativo', size: '35 mm', weight: 9 },
      ],
    },
  ]);

  assert.equal(products.length, 2);
  const plane = products.find((product) => product.id === 'plane');
  assert.equal(plane.name, 'Miniatura Boeing 737');
  assert.deepEqual(
    plane.options.map((option) => option.name),
    ['Escala 1:200', 'Multicolorida']
  );
  const tag = products.find((product) => product.id === 'tag');
  assert.deepEqual(
    tag.options.map((option) => option.name),
    ['Corporativo · 25 mm', 'Corporativo · 35 mm']
  );
  assert.equal(tag.options[0].model, 'Corporativo');
  assert.equal(tag.options[0].size, '25 mm');
});

test('groupCatalogProducts preserves legacy source aliases after raw-record consolidation', () => {
  const [product] = groupCatalogProducts([
    {
      id: 'plane',
      name: 'Miniatura Boeing 737',
      manualCuration: {
        legacySourceProductIds: ['plane', 'plane--multicolor', 'plane--print-in-place'],
      },
      options: [{ model: 'Escala 1:200', weight: 40 }],
    },
  ]);

  assert.deepEqual(product.sourceProductIds, [
    'plane',
    'plane--multicolor',
    'plane--print-in-place',
  ]);
});

test('productCategories lists the primary first and drops duplicates', () => {
  assert.deepEqual(
    productCategories({ category: 'Religioso', categories: ['natal', 'Natal', 'Religioso', ' '] }),
    ['Religioso', 'natal']
  );
  assert.deepEqual(productCategories({ categories: ['Natal'] }), ['Natal']);
  assert.deepEqual(productCategories({}), []);
});

test('buildCategoryCounts counts a product in each of its categories', () => {
  const counts = buildCategoryCounts([
    { category: 'Religioso', categories: ['Religioso', 'Natal'] },
    { category: 'Natal' },
    { category: 'Casa' },
    {},
  ]);
  assert.deepEqual(counts, [
    { name: 'Casa', count: 1 },
    { name: 'Natal', count: 2 },
    { name: 'Religioso', count: 1 },
  ]);
});

test('productHasCategory matches any category case-insensitively', () => {
  const product = { category: 'Religioso', categories: ['Natal'] };
  assert.equal(productHasCategory(product, 'natal'), true);
  assert.equal(productHasCategory(product, 'Casa'), false);
});

test('groupCatalogProducts merges the categories of family members', () => {
  const [family] = groupCatalogProducts([
    { id: 'a', name: 'Anjo', category: 'Religioso', options: [{ name: 'x', weight: 1 }] },
    { id: 'a--b', name: 'Anjo B', category: 'Natal', options: [{ name: 'y', weight: 1 }] },
  ]);
  assert.deepEqual(family.categories, ['Religioso', 'Natal']);
  assert.equal(family.category, 'Religioso');
});

test('validateProductInput normalizes category and categories together', () => {
  const base = { name: 'Presépio', options: [{ name: 'Único', weight: 10 }] };
  const multi = validateProductInput({ ...base, category: 'Religioso', categories: ['Natal'] });
  assert.deepEqual(multi.product.categories, ['Religioso', 'Natal']);
  assert.equal(multi.product.category, 'Religioso');
  const legacy = validateProductInput({ ...base, category: 'Casa' });
  assert.deepEqual(legacy.product.categories, ['Casa']);
  const none = validateProductInput(base);
  assert.deepEqual([none.product.category, none.product.categories], ['', []]);
});
