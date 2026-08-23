import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { createMemoryStore } from '../server/store.js';
import { buildQuote } from '../shared/contract.js';

async function startTestServer() {
  return createApp({
    rootDir: path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')),
    store: createMemoryStore()
  });
}

async function api(app, pathname, options = {}) {
  const result = await app.inject({
    method: options.method || 'GET',
    path: pathname,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body || null
  });
  return {
    response: { status: result.statusCode, headers: result.headers },
    json: result.json
  };
}

test('buildQuote applies the correct pricing tiers', async () => {
  const product = {
    id: 'demo',
    name: 'Produto Demo',
    productionTime: 60,
    options: [{ name: 'Laranja', weight: 40 }]
  };
  const quote = buildQuote([
    { productId: 'demo', optionName: 'Laranja', quantity: 10 },
    { productId: 'demo', optionName: 'Laranja', quantity: 60 },
    { productId: 'demo', optionName: 'Laranja', quantity: 150 }
  ], () => product);

  assert.equal(quote.items[0].unitPrice, 15);
  assert.equal(quote.items[1].unitPrice, 13);
  assert.equal(quote.items[2].unitPrice, 11);
  assert.equal(quote.productionEstimateHours, 22);
});

test('register, login and fetch me', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro',
      email: 'PEDRO@example.com',
      password: '12345678'
    })
  });
  assert.equal(register.response.status, 201);
  assert.equal(register.json.user.email, 'pedro@example.com');

  const me = await api(app, '/api/me', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` }
  });
  assert.equal(me.response.status, 200);
  assert.equal(me.json.user.name, 'Pedro');

  const login = await api(app, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'pedro@example.com',
      password: '12345678'
    })
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.json.accessToken);
});

test('orders require auth and address', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const unauthorizedQuote = await api(app, '/api/orders/quote', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }]
    })
  });
  assert.equal(unauthorizedQuote.response.status, 401);

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro',
      email: 'pedro@example.com',
      password: '12345678'
    })
  });

  const noAddressOrder = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${register.json.accessToken}`, 'Idempotency-Key': 'abc-1' },
    body: JSON.stringify({
      items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }],
      customer: { name: 'Pedro', email: 'pedro@example.com' }
    })
  });
  assert.equal(noAddressOrder.response.status, 422);
  assert.equal(noAddressOrder.json.error.code, 'ADDRESS_REQUIRED');
});

test('idempotency returns the same order without duplicating it', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro',
      email: 'pedro@example.com',
      password: '12345678'
    })
  });
  const token = register.json.accessToken;

  const address = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      recipientName: 'Pedro',
      postalCode: '13010111',
      street: 'Rua A',
      number: '12',
      city: 'Campinas',
      state: 'SP'
    })
  });

  const payload = {
    items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }],
    addressId: address.json.address.id,
    customer: { name: 'Pedro', email: 'pedro@example.com' }
  };

  const first = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'repeat-me' },
    body: JSON.stringify(payload)
  });
  const second = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'repeat-me' },
    body: JSON.stringify(payload)
  });

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(first.json.order.id, second.json.order.id);

  const orders = await api(app, '/api/me/orders', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(orders.response.status, 200);
  assert.equal(orders.json.orders.length, 1);
});

test('api server does not serve frontend assets and exposes CORS for separate frontend origin', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const root = await api(app, '/', {});
  assert.equal(root.response.status, 404);

  const preflight = await api(app, '/api/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST'
    }
  });

  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
  assert.match(preflight.response.headers['Access-Control-Allow-Methods'], /GET/);
});

test('users cannot read or modify another user\'s addresses', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const userA = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: '12345678' })
  });
  const userB = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bruno', email: 'bruno@example.com', password: '12345678' })
  });

  const addressA = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userA.json.accessToken}` },
    body: JSON.stringify({
      recipientName: 'Ana',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP'
    })
  });

  const readAsB = await api(app, '/api/me/addresses', {
    headers: { Authorization: `Bearer ${userB.json.accessToken}` }
  });
  assert.equal(readAsB.json.addresses.length, 0);

  const patchAsB = await api(app, `/api/me/addresses/${addressA.json.address.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${userB.json.accessToken}` },
    body: JSON.stringify({ city: 'Hacked' })
  });
  assert.equal(patchAsB.response.status, 404);

  const deleteAsB = await api(app, `/api/me/addresses/${addressA.json.address.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userB.json.accessToken}` }
  });
  assert.equal(deleteAsB.response.status, 404);
});

test('users cannot read another user\'s orders', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const userA = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ana', email: 'ana2@example.com', password: '12345678' })
  });
  const address = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userA.json.accessToken}` },
    body: JSON.stringify({
      recipientName: 'Ana',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP'
    })
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userA.json.accessToken}`, 'Idempotency-Key': 'order-a-1' },
    body: JSON.stringify({
      items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }],
      addressId: address.json.address.id,
      customer: { name: 'Ana', email: 'ana2@example.com' }
    })
  });

  const userB = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bruno', email: 'bruno2@example.com', password: '12345678' })
  });
  const readAsB = await api(app, `/api/me/orders/${order.json.order.id}`, {
    headers: { Authorization: `Bearer ${userB.json.accessToken}` }
  });
  assert.equal(readAsB.response.status, 404);

  const listAsB = await api(app, '/api/me/orders', {
    headers: { Authorization: `Bearer ${userB.json.accessToken}` }
  });
  assert.equal(listAsB.json.orders.length, 0);
});

test('first address becomes default, and setting a new default clears the previous one', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const user = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Carla', email: 'carla@example.com', password: '12345678' })
  });
  const auth = { Authorization: `Bearer ${user.json.accessToken}` };

  const first = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      recipientName: 'Carla',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP'
    })
  });
  assert.equal(first.json.address.isDefault, true);

  const second = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      recipientName: 'Carla',
      postalCode: '13010222',
      street: 'Rua B',
      number: '2',
      city: 'Campinas',
      state: 'SP'
    })
  });
  assert.equal(second.json.address.isDefault, false);

  const setDefault = await api(app, `/api/me/addresses/${second.json.address.id}/default`, {
    method: 'POST',
    headers: auth
  });
  assert.equal(setDefault.json.address.isDefault, true);

  const list = await api(app, '/api/me/addresses', { headers: auth });
  const firstAfter = list.json.addresses.find((entry) => entry.id === first.json.address.id);
  assert.equal(firstAfter.isDefault, false);
});

test('GET /api/products filters by category and paginates', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const page1 = await api(app, '/api/products?limit=2&page=1');
  assert.equal(page1.response.status, 200);
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.pagination.page, 1);

  const filtered = await api(app, `/api/products?category=${encodeURIComponent('Identidade visual')}`);
  assert.ok(filtered.json.items.every((item) => item.category === 'Identidade visual'));
});

test('register enforces a rate limit per IP', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  let lastStatus = 200;
  for (let index = 0; index < 11; index += 1) {
    const result = await api(app, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: `User ${index}`,
        email: `user${index}@example.com`,
        password: '12345678'
      })
    });
    lastStatus = result.response.status;
  }
  assert.equal(lastStatus, 429);
});
