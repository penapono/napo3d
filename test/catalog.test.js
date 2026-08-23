import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenCatalogProducts, primaryProductOption } from '../shared/catalog.js';

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
