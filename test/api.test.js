import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { createMemoryStore } from '../server/store.js';
import { buildQuote } from '../shared/contract.js';

async function startTestServer(options = {}) {
  const app = createApp({
    rootDir: path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')),
    store: createMemoryStore(),
    makerWorldScrapeIntervalMs: 0,
    ...options,
  });
  app.promoteToAdmin = async (email) => {
    await app.store.update((nextStore) => {
      nextStore.users = nextStore.users.map((user) =>
        user.email === email ? { ...user, role: 'admin' } : user
      );
      return nextStore;
    });
  };
  return app;
}

async function api(app, pathname, options = {}) {
  const result = await app.inject({
    method: options.method || 'GET',
    path: pathname,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body || null,
  });
  return {
    response: { status: result.statusCode, headers: result.headers },
    json: result.json,
  };
}

async function loginAsNewAdmin(app, email) {
  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Admin', email, password: '12345678' }),
  });
  await app.promoteToAdmin(email);
  return { Authorization: `Bearer ${register.json.accessToken}` };
}

test('buildQuote applies the correct pricing tiers', async () => {
  const product = {
    id: 'demo',
    name: 'Produto Demo',
    productionTime: 60,
    options: [{ name: 'Laranja', weight: 40, productionTime: 90 }],
  };
  const quote = buildQuote(
    [
      { productId: 'demo', optionName: 'Laranja', quantity: 10 },
      { productId: 'demo', optionName: 'Laranja', quantity: 60 },
      { productId: 'demo', optionName: 'Laranja', quantity: 150 },
    ],
    () => product
  );

  assert.equal(quote.items[0].unitPrice, 15);
  assert.equal(quote.items[1].unitPrice, 13);
  assert.equal(quote.items[2].unitPrice, 11);
  assert.equal(quote.items[0].productionTimeMinutes, 90);
  assert.equal(quote.productionEstimateHours, 33);
});

test('register, login and fetch me', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro',
      email: 'PEDRO@example.com',
      password: '12345678',
    }),
  });
  assert.equal(register.response.status, 201);
  assert.equal(register.json.user.email, 'pedro@example.com');

  const me = await api(app, '/api/me', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` },
  });
  assert.equal(me.response.status, 200);
  assert.equal(me.json.user.name, 'Pedro');
  assert.equal(me.json.user.role, 'customer');

  const login = await api(app, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'pedro@example.com',
      password: '12345678',
    }),
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.json.accessToken);
  assert.equal(login.json.user.role, 'customer');
});

test('new users always register as customer, never admin', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Ana',
      email: 'ana-role@example.com',
      password: '12345678',
      role: 'admin',
    }),
  });
  assert.equal(register.json.user.role, 'customer');

  const me = await api(app, '/api/me', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` },
  });
  assert.equal(me.json.user.role, 'customer');
});

test('admin-only routes reject customers and anonymous requests', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const anonymous = await api(app, '/api/admin/users');
  assert.equal(anonymous.response.status, 401);

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bruno', email: 'bruno-role@example.com', password: '12345678' }),
  });
  const asCustomer = await api(app, '/api/admin/users', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` },
  });
  assert.equal(asCustomer.response.status, 403);
  assert.equal(asCustomer.json.error.code, 'FORBIDDEN');
});

test('an admin user can reach admin-only routes', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Carla', email: 'carla-role@example.com', password: '12345678' }),
  });
  await app.promoteToAdmin('carla-role@example.com');

  const asAdmin = await api(app, '/api/admin/users', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` },
  });
  assert.equal(asAdmin.response.status, 200);
});

test('orders require auth and address', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const unauthorizedQuote = await api(app, '/api/orders/quote', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
      ],
    }),
  });
  assert.equal(unauthorizedQuote.response.status, 401);

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pedro',
      email: 'pedro@example.com',
      password: '12345678',
    }),
  });

  const noAddressOrder = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${register.json.accessToken}`, 'Idempotency-Key': 'abc-1' },
    body: JSON.stringify({
      items: [
        { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
      ],
      customer: { name: 'Pedro', email: 'pedro@example.com' },
    }),
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
      password: '12345678',
    }),
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
      state: 'SP',
    }),
  });

  const payload = {
    items: [
      { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
    ],
    addressId: address.json.address.id,
    customer: { name: 'Pedro', email: 'pedro@example.com' },
  };

  const first = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'repeat-me' },
    body: JSON.stringify(payload),
  });
  const second = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'repeat-me' },
    body: JSON.stringify(payload),
  });

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(first.json.order.id, second.json.order.id);

  const orders = await api(app, '/api/me/orders', {
    headers: { Authorization: `Bearer ${token}` },
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
      'Access-Control-Request-Method': 'POST',
    },
  });

  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
  assert.match(preflight.response.headers['Access-Control-Allow-Methods'], /GET/);
});

test("users cannot read or modify another user's addresses", async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const userA = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', password: '12345678' }),
  });
  const userB = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bruno', email: 'bruno@example.com', password: '12345678' }),
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
      state: 'SP',
    }),
  });

  const readAsB = await api(app, '/api/me/addresses', {
    headers: { Authorization: `Bearer ${userB.json.accessToken}` },
  });
  assert.equal(readAsB.json.addresses.length, 0);

  const patchAsB = await api(app, `/api/me/addresses/${addressA.json.address.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${userB.json.accessToken}` },
    body: JSON.stringify({ city: 'Hacked' }),
  });
  assert.equal(patchAsB.response.status, 404);

  const deleteAsB = await api(app, `/api/me/addresses/${addressA.json.address.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userB.json.accessToken}` },
  });
  assert.equal(deleteAsB.response.status, 404);
});

test("users cannot read another user's orders", async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const userA = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ana', email: 'ana2@example.com', password: '12345678' }),
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
      state: 'SP',
    }),
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userA.json.accessToken}`, 'Idempotency-Key': 'order-a-1' },
    body: JSON.stringify({
      items: [
        { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
      ],
      addressId: address.json.address.id,
      customer: { name: 'Ana', email: 'ana2@example.com' },
    }),
  });

  const userB = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bruno', email: 'bruno2@example.com', password: '12345678' }),
  });
  const readAsB = await api(app, `/api/me/orders/${order.json.order.id}`, {
    headers: { Authorization: `Bearer ${userB.json.accessToken}` },
  });
  assert.equal(readAsB.response.status, 404);

  const listAsB = await api(app, '/api/me/orders', {
    headers: { Authorization: `Bearer ${userB.json.accessToken}` },
  });
  assert.equal(listAsB.json.orders.length, 0);
});

test('first address becomes default, and setting a new default clears the previous one', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const user = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Carla', email: 'carla@example.com', password: '12345678' }),
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
      state: 'SP',
    }),
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
      state: 'SP',
    }),
  });
  assert.equal(second.json.address.isDefault, false);

  const setDefault = await api(app, `/api/me/addresses/${second.json.address.id}/default`, {
    method: 'POST',
    headers: auth,
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

  const filtered = await api(
    app,
    `/api/products?category=${encodeURIComponent('Identidade visual')}`
  );
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
        password: '12345678',
      }),
    });
    lastStatus = result.response.status;
  }
  assert.equal(lastStatus, 429);
});

test('admin can create, update, and delete a product; storefront sees the change', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const admin = await loginAsNewAdmin(app, 'admin-products@example.com');

  const create = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      name: 'Vaso Geométrico',
      category: 'Casa',
      summary: 'Um vaso com padrão geométrico.',
      options: [{ name: 'Verde', weight: 120, score: 4 }],
    }),
  });
  assert.equal(create.response.status, 201);
  const productId = create.json.product.id;
  assert.ok(productId);

  const publicList = await api(app, '/api/products?limit=200');
  assert.ok(publicList.json.items.some((item) => item.id === productId));

  const update = await api(app, `/api/admin/products/${productId}`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ name: 'Vaso Geométrico Grande' }),
  });
  assert.equal(update.json.product.name, 'Vaso Geométrico Grande');

  const del = await api(app, `/api/admin/products/${productId}`, {
    method: 'DELETE',
    headers: admin,
  });
  assert.equal(del.response.status, 204);

  const afterDelete = await api(app, `/api/products/${productId}`);
  assert.equal(afterDelete.response.status, 404);
});

test('admin product creation rejects a product with no options or invalid weight', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const admin = await loginAsNewAdmin(app, 'admin-invalid@example.com');

  const noOptions = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: 'Sem opções', options: [] }),
  });
  assert.equal(noOptions.response.status, 422);

  const badWeight = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: 'Peso inválido', options: [{ name: 'Única', weight: 0 }] }),
  });
  assert.equal(badWeight.response.status, 422);
});

test('a customer cannot create, update, or delete products', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cliente',
      email: 'cliente-products@example.com',
      password: '12345678',
    }),
  });
  const customer = { Authorization: `Bearer ${register.json.accessToken}` };

  const create = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: customer,
    body: JSON.stringify({ name: 'x', options: [{ name: 'x', weight: 1 }] }),
  });
  assert.equal(create.response.status, 403);
});

test('admin can trigger a MakerWorld refresh and persist scraped option fields', async (t) => {
  const app = await startTestServer({
    async scrapeMakerWorldModel(url) {
      return {
        url,
        model_id: '2838224',
        name: 'Porta-cartões Airbus A320',
        description: 'Modelo sincronizado do MakerWorld.',
        image_urls: [
          'https://makerworld.bblmw.com/makerworld/user/demo/avatar.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-1.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-2.webp',
          'https://makerworld.bblmw.com/makerworld/static/license.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-3.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-4.webp',
        ],
        best_profile: {
          rating: 4.9,
          rating_count: 37,
          print_time: '2h',
          print_time_seconds: 7200,
          weight_grams: 84,
        },
      };
    },
  });
  t.after(() => app.close());
  const admin = await loginAsNewAdmin(app, 'admin-makerworld@example.com');

  const create = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      name: 'Porta cartões',
      options: [
        {
          name: 'Business Card Holder',
          url: 'https://makerworld.com/en/models/2838224-airplane-business-card-holder-a320-airbus',
          weight: 42,
        },
      ],
    }),
  });
  const productId = create.json.product.id;

  const refresh = await api(app, `/api/admin/products/${productId}/refresh-makerworld`, {
    method: 'POST',
    headers: admin,
  });
  assert.equal(refresh.response.status, 202);
  assert.equal(refresh.json.job.status, 'queued');

  let detail = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    detail = await api(app, `/api/admin/products/${productId}`, { headers: admin });
    if (!['queued', 'running'].includes(detail.json.product.makerworldRefresh?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(detail.json.product.makerworldRefresh.status, 'succeeded');
  assert.equal(detail.json.product.name, 'Porta-cartões Airbus A320');
  assert.equal(detail.json.product.options[0].name, 'Porta-cartões Airbus A320');
  assert.equal(
    detail.json.product.options[0].url,
    'https://makerworld.com/pt/models/2838224-airplane-business-card-holder-a320-airbus'
  );
  assert.equal(
    detail.json.product.options[0].imageUrl,
    'https://makerworld.bblmw.com/makerworld/model/demo/design/example-1.webp'
  );
  assert.deepEqual(detail.json.product.options[0].imageGallery, [
    'https://makerworld.bblmw.com/makerworld/model/demo/design/example-1.webp',
    'https://makerworld.bblmw.com/makerworld/model/demo/design/example-2.webp',
    'https://makerworld.bblmw.com/makerworld/model/demo/design/example-3.webp',
  ]);
  assert.equal(detail.json.product.options[0].time, '2h');
  assert.equal(detail.json.product.options[0].rating, 4.9);
  assert.equal(detail.json.product.options[0].ratingCount, 37);
  assert.equal(detail.json.product.options[0].weight, 84);
  assert.equal(detail.json.product.options[0].thumb, detail.json.product.options[0].imageUrl);
  assert.equal(detail.json.product.options[0].makerworldModelId, '2838224');
  assert.equal(detail.json.product.options[0].makerworldLastError, '');
  assert.equal(detail.json.product.summary, '');
  assert.equal(detail.json.product.options[0].productionTime, 120);
  assert.equal(detail.json.product.productionTime, 120);
});

test('admin can create a product from only a MakerWorld URL', async (t) => {
  const app = await startTestServer({
    async scrapeMakerWorldModel(url) {
      return {
        url,
        model_id: '1820511',
        name: 'Organizador Poly-Desk',
        image_urls: [
          'https://makerworld.bblmw.com/makerworld/user/demo/avatar.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/desk-1.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/desk-2.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/desk-3.webp',
        ],
        best_profile: {
          rating: 4.9,
          rating_count: 93,
          print_time: '16h 58m',
          print_time_seconds: 61087,
          weight_grams: 752,
        },
      };
    },
  });
  t.after(() => app.close());
  const admin = await loginAsNewAdmin(app, 'admin-makerworld-import@example.com');

  const create = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      options: [{ url: 'https://makerworld.com/en/models/1820511-poly-desk-organizer' }],
    }),
  });

  assert.equal(create.response.status, 201);
  assert.equal(create.json.product.name, 'Organizador Poly-Desk');
  assert.equal(create.json.product.options[0].name, 'Organizador Poly-Desk');
  assert.equal(
    create.json.product.options[0].url,
    'https://makerworld.com/pt/models/1820511-poly-desk-organizer'
  );
  assert.equal(create.json.product.options[0].makerworldModelId, '1820511');
  assert.equal(create.json.product.options[0].rating, 4.9);
  assert.equal(create.json.product.options[0].ratingCount, 93);
  assert.equal(create.json.product.options[0].weight, 752);
  assert.equal(create.json.product.options[0].productionTime, 1018);
  assert.equal(create.json.product.productionTime, 1018);
  assert.deepEqual(create.json.product.options[0].imageGallery, [
    'https://makerworld.bblmw.com/makerworld/model/demo/design/desk-1.webp',
    'https://makerworld.bblmw.com/makerworld/model/demo/design/desk-2.webp',
    'https://makerworld.bblmw.com/makerworld/model/demo/design/desk-3.webp',
  ]);
});

test('MakerWorld refreshes are queued with a minimum interval between scrapes', async (t) => {
  const scrapeStarts = [];
  const app = await startTestServer({
    makerWorldScrapeIntervalMs: 25,
    async scrapeMakerWorldModel(url) {
      scrapeStarts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        url,
        model_id: url.includes('organizer') ? '1820511' : '2838224',
        name: url.includes('organizer') ? 'Organizador Poly-Desk' : 'Porta-cartões Airbus A320',
        image_urls: [
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-1.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-2.webp',
          'https://makerworld.bblmw.com/makerworld/model/demo/design/example-3.webp',
        ],
        best_profile: {
          rating: 4.9,
          rating_count: 10,
          print_time: '2h',
          print_time_seconds: 7200,
          weight_grams: 84,
        },
      };
    },
  });
  t.after(() => app.close());
  const admin = await loginAsNewAdmin(app, 'admin-makerworld-queue@example.com');

  const first = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      options: [{ url: 'https://makerworld.com/en/models/1820511-poly-desk-organizer' }],
    }),
  });
  const second = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      options: [
        {
          url: 'https://makerworld.com/en/models/2838224-airplane-business-card-holder-a320-airbus',
        },
      ],
    }),
  });

  const refreshFirst = await api(
    app,
    `/api/admin/products/${first.json.product.id}/refresh-makerworld`,
    { method: 'POST', headers: admin }
  );
  const refreshSecond = await api(
    app,
    `/api/admin/products/${second.json.product.id}/refresh-makerworld`,
    { method: 'POST', headers: admin }
  );
  assert.equal(refreshFirst.response.status, 202);
  assert.equal(refreshSecond.response.status, 202);
  assert.equal(refreshSecond.json.job.status, 'queued');

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [firstDetail, secondDetail] = await Promise.all([
      api(app, `/api/admin/products/${first.json.product.id}`, { headers: admin }),
      api(app, `/api/admin/products/${second.json.product.id}`, { headers: admin }),
    ]);
    if (
      firstDetail.json.product.makerworldRefresh?.status === 'succeeded' &&
      secondDetail.json.product.makerworldRefresh?.status === 'succeeded'
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(scrapeStarts.length, 4);
  assert.ok(
    scrapeStarts[3] - scrapeStarts[2] >= 20,
    `expected queued scrapes to be spaced, got ${scrapeStarts[3] - scrapeStarts[2]}ms`
  );
});

test('admin MakerWorld refresh rejects products without a MakerWorld URL', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const admin = await loginAsNewAdmin(app, 'admin-makerworld-missing@example.com');

  const create = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      name: 'Produto local',
      options: [{ name: 'Única', weight: 10 }],
    }),
  });

  const refresh = await api(
    app,
    `/api/admin/products/${create.json.product.id}/refresh-makerworld`,
    {
      method: 'POST',
      headers: admin,
    }
  );
  assert.equal(refresh.response.status, 422);
  assert.equal(refresh.json.error.code, 'NO_MAKERWORLD_SOURCE');
});

test('admin can list every order across all customers and view one in detail', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Dora', email: 'dora-orders@example.com', password: '12345678' }),
  });
  const customerAuth = { Authorization: `Bearer ${customer.json.accessToken}` };
  const address = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: customerAuth,
    body: JSON.stringify({
      recipientName: 'Dora',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP',
    }),
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { ...customerAuth, 'Idempotency-Key': 'admin-orders-1' },
    body: JSON.stringify({
      items: [
        { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
      ],
      addressId: address.json.address.id,
      customer: { name: 'Dora', email: 'dora-orders@example.com' },
    }),
  });

  const admin = await loginAsNewAdmin(app, 'admin-orders@example.com');
  const list = await api(app, '/api/admin/orders', { headers: admin });
  assert.equal(list.response.status, 200);
  assert.ok(list.json.orders.some((entry) => entry.id === order.json.order.id));

  const detail = await api(app, `/api/admin/orders/${order.json.order.id}`, { headers: admin });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.json.order.customerEmail, 'dora-orders@example.com');
  assert.ok(detail.json.order.addressSnapshot);
});

test('admin can update an order status but not to an invalid value', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Elis', email: 'elis-orders@example.com', password: '12345678' }),
  });
  const customerAuth = { Authorization: `Bearer ${customer.json.accessToken}` };
  const address = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: customerAuth,
    body: JSON.stringify({
      recipientName: 'Elis',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP',
    }),
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { ...customerAuth, 'Idempotency-Key': 'admin-orders-2' },
    body: JSON.stringify({
      items: [
        { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
      ],
      addressId: address.json.address.id,
      customer: { name: 'Elis', email: 'elis-orders@example.com' },
    }),
  });

  const admin = await loginAsNewAdmin(app, 'admin-orders-2@example.com');
  const invalid = await api(app, `/api/admin/orders/${order.json.order.id}`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ status: 'not-a-real-status' }),
  });
  assert.equal(invalid.response.status, 422);

  const valid = await api(app, `/api/admin/orders/${order.json.order.id}`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ status: 'confirmed' }),
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.json.order.status, 'confirmed');

  const asCustomerAgain = await api(app, `/api/me/orders/${order.json.order.id}`, {
    headers: customerAuth,
  });
  assert.equal(asCustomerAgain.json.order.status, 'confirmed');
});

test('a customer cannot list all orders or change order status', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Fabio',
      email: 'fabio-orders@example.com',
      password: '12345678',
    }),
  });
  const customer = { Authorization: `Bearer ${register.json.accessToken}` };

  const list = await api(app, '/api/admin/orders', { headers: customer });
  assert.equal(list.response.status, 403);
});

test('admin can list users and see one user detail with addresses', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Gil', email: 'gil-users@example.com', password: '12345678' }),
  });
  await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${customer.json.accessToken}` },
    body: JSON.stringify({
      recipientName: 'Gil',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP',
    }),
  });

  const admin = await loginAsNewAdmin(app, 'admin-users@example.com');
  const list = await api(app, '/api/admin/users', { headers: admin });
  assert.equal(list.response.status, 200);
  assert.ok(list.json.users.some((entry) => entry.email === 'gil-users@example.com'));
  assert.equal(
    list.json.users.every((entry) => !('passwordHash' in entry)),
    true
  );

  const detail = await api(app, `/api/admin/users/${customer.json.user.id}`, { headers: admin });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.json.user.email, 'gil-users@example.com');
  assert.equal(detail.json.addresses.length, 1);
});

test('admin can promote a user to admin, but cannot change their own role', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Hugo', email: 'hugo-users@example.com', password: '12345678' }),
  });
  const adminEmail = 'admin-promote@example.com';
  const adminRegister = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Admin', email: adminEmail, password: '12345678' }),
  });
  await app.promoteToAdmin(adminEmail);
  const admin = { Authorization: `Bearer ${adminRegister.json.accessToken}` };

  const promote = await api(app, `/api/admin/users/${customer.json.user.id}`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(promote.response.status, 200);
  assert.equal(promote.json.user.role, 'admin');

  const selfDemote = await api(app, `/api/admin/users/${adminRegister.json.user.id}`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ role: 'customer' }),
  });
  assert.equal(selfDemote.response.status, 422);
  assert.equal(selfDemote.json.error.code, 'CANNOT_CHANGE_OWN_ROLE');
});

test('deleting a user cannot target yourself, and preserves the deleted user orders with a null owner', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ines', email: 'ines-users@example.com', password: '12345678' }),
  });
  const customerAuth = { Authorization: `Bearer ${customer.json.accessToken}` };
  const address = await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: customerAuth,
    body: JSON.stringify({
      recipientName: 'Ines',
      postalCode: '13010111',
      street: 'Rua A',
      number: '1',
      city: 'Campinas',
      state: 'SP',
    }),
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { ...customerAuth, 'Idempotency-Key': 'delete-user-1' },
    body: JSON.stringify({
      items: [
        { productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 },
      ],
      addressId: address.json.address.id,
      customer: { name: 'Ines', email: 'ines-users@example.com' },
    }),
  });

  const admin = await loginAsNewAdmin(app, 'admin-delete@example.com');
  const me = await api(app, '/api/me', { headers: admin });
  const selfDelete = await api(app, `/api/admin/users/${me.json.user.id}`, {
    method: 'DELETE',
    headers: admin,
  });
  assert.equal(selfDelete.response.status, 422);

  const del = await api(app, `/api/admin/users/${customer.json.user.id}`, {
    method: 'DELETE',
    headers: admin,
  });
  assert.equal(del.response.status, 204);

  const store = await app.store.read();
  const survivingOrder = store.orders.find((entry) => entry.id === order.json.order.id);
  assert.ok(survivingOrder);
  assert.equal(survivingOrder.userId, undefined);
});
