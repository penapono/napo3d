# Admin Panel (Models, Orders, Users, Roles) Implementation Plan

> **For agentic workers:** This plan is written for an external coding
> agent (Codex) to execute directly, task by task, in order. Every task
> is a pure repo change (code, tests, no production credentials needed) —
> safe to execute autonomously. Steps use checkbox (`- [ ]`) syntax for
> tracking. Run `node --test` after every backend task and keep it green
> before moving to the next task.

**Goal:** Add an admin-only back office to napo3d: full CRUD for the
product catalog (currently a static JSON file — migrate it into
Postgres), read+status-update for orders, read+role-update+delete for
users (with their addresses visible), and a two-role permission system
(`admin` / `customer`) that the store owner assigns manually to their own
account via a documented SQL command.

**Architecture:** Backend stays a single `node:http` process, no
framework, following every convention already in `server/index.js` /
`server/store.js` / `shared/contract.js`. The product catalog moves from
`data/models.json` (read at request time) into a new `products` table,
seeded once from that same file so nothing existing is lost. Admin
endpoints live under `/api/admin/*`, gated by a new `requireAdmin` helper
built on top of the existing `requireUser`. The front-end gets a **new,
separate** `admin.html` + `js/admin.js` (not folded into the existing
`index.html`/`js/app.js`) so regular shoppers never download admin code,
reusing the exact same CSS classes/design tokens as the storefront
(`.info-section`, `.info-card`, `.segmented-controls`, `.button-primary`/
`.button-secondary`, `.inline-badge`, `.form-status`) so it visually
matches the existing site rather than looking like a bolted-on dashboard.

**Tech Stack:** Same as the rest of the repo — Node 22 (`node:http`,
native `fetch`), PostgreSQL 16 via `pg`, plain HTML/CSS/JS with no
bundler, Node's built-in test runner (`node --test`).

**Spec:** `BACKEND_CONTRACT.md` (repo root) for the existing data shapes
this plan extends — this document only covers the *delta* (roles,
products-as-a-table, admin endpoints/UI). Executors should keep both open.

## Global Constraints

- Never trust client input for authorization: every `/api/admin/*` route
  must call the new `requireAdmin` helper before doing anything else —
  never infer admin rights from anything in the request body.
- `role` is never client-settable at registration — `POST
  /api/auth/register` always creates `role: 'customer'`, no exceptions.
- Product `id`s that already exist (seeded from `data/models.json`) must
  never change — order history (`order_items.product_id`) references
  them by string value with **no foreign key** (deliberate — see Task 2),
  so deleting or renaming a seeded product must never break past orders.
- Reuse `shared/contract.js` for every piece of validation/formatting
  logic the front-end and back-end both need (mirrors the existing
  pattern: `normalizeAddressInput`/`validateAddressInput` are already
  shared this way).
- Follow the existing CSS design tokens exactly — `--ink:#1c2420`,
  `--muted:#68716c`, `--paper:#f8f8f5`, `--surface:#fff`,
  `--line:#dfe4df`, `--accent:#ff5a36`, `--accent-dark:#d83f22`,
  `--soft:#fff0e9` — and the existing component classes (`.button
  .button-primary`, `.button .button-secondary`, `.info-section`,
  `.info-list`, `.info-card`, `.segmented-controls`/`.segmented-button`,
  `.inline-badge`, `.form-status`, `.store-page`/`.store-page-inner`).
  Add new admin-only classes only for what genuinely doesn't exist yet
  (a compact list-row layout, a repeatable option-row editor, a "danger"
  button variant) — never invent a parallel design language.

## Decisions made for this plan (do not re-litigate)

- **Products storage:** one `products` table with `options` as a single
  `jsonb` column holding the exact same array shape `data/models.json`
  already uses (name/url/imageUrl/colors/weight/score/etc.) — not a
  normalized `product_options` table. This means `shared/contract.js`'s
  `buildQuote`/`sortProducts`/`unitPriceFromWeight` need **zero changes**
  — they already just consume a `{ options: [...] }` shaped object,
  regardless of whether it came from a JSON file or a database row.
- **Orders "CRUD"**: read (list all + detail) and status-update are
  implemented. Create is customer-only (via checkout, unchanged) and
  delete is intentionally **not** exposed — admins cancel an order by
  setting `status: 'cancelled'`, they don't delete financial records.
  Flagged here explicitly in case you actually want hard delete too.
- **Deleting a user** cascades their sessions/addresses (already existed
  before this plan) but their **orders are preserved** with `user_id`
  set to `NULL` instead of being cascade-deleted — `BACKEND_CONTRACT.md`
  already types `Order.userId` as optional (`userId?: string`), the SQL
  schema just hadn't caught up to that yet. Task 5 fixes this.
- **First admin**: bootstrapped by hand with one SQL `UPDATE` statement
  (Task 1 documents the exact command) — there's no "make me admin" UI,
  since no admin exists yet to grant it. After that, promoting/demoting
  anyone else is a normal field on the Users admin screen.
- **New product IDs** are `crypto.randomUUID()`-generated on create —
  seeded legacy products keep their original slug-style ids (`p3-logo`)
  unchanged forever; no slug-collision logic needed for new ones.
- Admin API calls always hit the live backend directly (bypass the
  mock-backend/live auto-fallback in `api-client.js`) — the admin panel
  is a production/live-backend-only feature, by design.

## Unrelated production bug found and fixed while starting this plan

While investigating this feature request, "Minha conta" and "Carrinho"
were reported as dead on `https://napo3d.shop`. This turned out to be
completely unrelated to the admin panel, but critical enough to fix
immediately rather than leave broken while this plan is implemented:

**Root cause:** `Dockerfile.frontend` copies `index.html`, `css/`, `js/`,
`data/`, and `assets/` into the nginx image, but never copied `shared/`.
`js/app.js` has a static `import ... from '../shared/contract.js'`, so
that request 404'd — and because `nginx.frontend.conf` has `try_files
$uri $uri/ /index.html;` (the SPA fallback), the 404 silently became a
200 response containing `index.html`'s HTML instead of JavaScript. A
browser trying to load that as an ES module fails immediately, which
aborts the entire `js/app.js` module — meaning `bindEvents()` never ran,
so **every** button on the storefront was dead (not just those two).

**Fix already applied and deployed** (commit `e3024e9`, pushed to `main`,
auto-deployed via the existing GitHub Actions workflow): added `COPY
shared /usr/share/nginx/html/shared` to `Dockerfile.frontend`, verified
locally first (`docker compose build front` → `curl
http://127.0.0.1:3000/shared/contract.js` now returns real JS, not HTML),
then pushed and re-verified against `https://napo3d.shop` and
`https://napo3d.store` directly. A full register → address → order flow
was placed and confirmed successful against production immediately
after that deploy, then cleaned up from the database. No task in this
plan needs to touch this again — it's listed here only so the fix has a
paper trail alongside the feature it was found next to.

---

## Task 1: Roles — schema, sanitization, `requireAdmin`, bootstrap

**Files:**
- Modify: `server/store.js` (schema: add `role` column)
- Modify: `shared/contract.js` (add `USER_ROLES` constant)
- Modify: `server/index.js` (`sanitizeUser`, register handler, new
  `requireAdmin` helper, temporary `/api/admin/users` auth stub)
- Test: `test/api.test.js` (append)

**Interfaces:**
- Produces: `requireAdmin(request, response) -> Promise<SessionUser|null>`
  (same shape as the existing `requireUser`'s return value — `{ token,
  session, user, store }` — used by every admin route added in later
  tasks). `sanitizeUser(user)` now includes `role`.
- Consumes: existing `requireUser`, `getSessionUser`, `errorResponse` from
  `server/index.js` (unchanged signatures).

- [ ] **Step 1: Write the failing tests**

Append to `test/api.test.js`:

```js
test('new users always register as customer, never admin', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ana', email: 'ana-role@example.com', password: '12345678', role: 'admin' })
  });
  assert.equal(register.json.user.role, 'customer');

  const me = await api(app, '/api/me', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` }
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
    body: JSON.stringify({ name: 'Bruno', email: 'bruno-role@example.com', password: '12345678' })
  });
  const asCustomer = await api(app, '/api/admin/users', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` }
  });
  assert.equal(asCustomer.response.status, 403);
  assert.equal(asCustomer.json.error.code, 'FORBIDDEN');
});

test('an admin user can reach admin-only routes', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Carla', email: 'carla-role@example.com', password: '12345678' })
  });
  await app.promoteToAdmin('carla-role@example.com');

  const asAdmin = await api(app, '/api/admin/users', {
    headers: { Authorization: `Bearer ${register.json.accessToken}` }
  });
  assert.equal(asAdmin.response.status, 200);
});
```

This test needs a test-only way to flip a user to `admin` without going
through the (not-yet-written) admin API. Add a small test helper to
`startTestServer()` at the top of `test/api.test.js` — modify:

```js
async function startTestServer() {
  return createApp({
    rootDir: path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')),
    store: createMemoryStore()
  });
}
```

to:

```js
async function startTestServer() {
  const app = createApp({
    rootDir: path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')),
    store: createMemoryStore()
  });
  app.promoteToAdmin = async (email) => {
    await app.store.update((nextStore) => {
      nextStore.users = nextStore.users.map((user) => user.email === email ? { ...user, role: 'admin' } : user);
      return nextStore;
    });
  };
  return app;
}
```

This requires `createApp()` to expose its `store` on the returned server
object — add `server.store = store;` right before `return server;` in
`server/index.js` (test-only convenience, harmless in production).

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/api.test.js`
Expected: FAIL — `/api/admin/users` doesn't exist yet (404), `role` is
`undefined` on registered users, `app.store` is `undefined`.

- [ ] **Step 3: Add the `role` column and reusable role constants**

In `shared/contract.js`, add near the top (after `DEFAULT_MAX_ITEM_QUANTITY`):

```js
export const USER_ROLES = ['customer', 'admin'];
export const DEFAULT_USER_ROLE = 'customer';

export function normalizeUserRole(value) {
  return USER_ROLES.includes(value) ? value : DEFAULT_USER_ROLE;
}
```

In `server/store.js`, in `SCHEMA_SQL` (right after the `users` table's
closing `);`), add:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'customer';
```

In `readStore` (`server/store.js`), update the `users` mapping to include
`role: row.role`:

```js
    users: usersResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: undefinedIfNull(row.phone),
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: asIsoString(row.created_at),
      updatedAt: asIsoString(row.updated_at)
    })),
```

In `replaceStore` (`server/store.js`), update the `users` insert:

```js
  for (const user of nextStore.users) {
    await client.query(
      `INSERT INTO users (id, name, email, phone, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id,
        user.name,
        user.email,
        nullIfEmpty(user.phone),
        user.passwordHash,
        user.role || 'customer',
        asTimestamp(user.createdAt),
        asTimestamp(user.updatedAt)
      ]
    );
  }
```

- [ ] **Step 4: Wire roles into `server/index.js`**

Add the import (alongside the existing `shared/contract.js` import list):

```js
import {
  buildQuote,
  normalizeAddressInput,
  normalizeEmail,
  normalizeUserRole,
  productionTimeMinutes,
  sortProducts,
  validateAddressInput
} from '../shared/contract.js';
```

Update `sanitizeUser` (`server/index.js`):

```js
  function sanitizeUser(user) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: normalizeUserRole(user.role),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }
```

In the register handler, force the role when building the new user object
(find the `const user = { id: crypto.randomUUID(), ... }` block inside
`POST /api/auth/register` and add `role: 'customer',` to it — right after
`passwordHash: passwordHash(password),`):

```js
      const user = {
        id: crypto.randomUUID(),
        name: String(body.name).trim(),
        email,
        phone: String(body.phone || '').trim() || undefined,
        passwordHash: passwordHash(password),
        role: 'customer',
        createdAt,
        updatedAt: createdAt
      };
```

Add `requireAdmin` right after the existing `requireUser` function:

```js
  async function requireAdmin(request, response) {
    const sessionUser = await requireUser(request, response);
    if (!sessionUser) return null;
    if (sessionUser.user.role !== 'admin') {
      errorResponse(request, response, 403, 'FORBIDDEN', 'Acesso restrito a administradores.');
      return null;
    }
    return sessionUser;
  }
```

Add a temporary exact-match `GET /api/admin/users` route right before the
existing `POST /api/auth/register` block:

```js
    if (request.method === 'GET' && pathname === '/api/admin/users') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      writeJson(response, 200, { users: [] });
      return;
    }
```

This is an intentional bootstrap stub so Task 1 can verify the new auth
gate with real 401/403/200 behavior on the same route family the later
admin work will use. Task 5 replaces this stubbed collection response
with the real users listing implementation.

Expose the store for tests — right before `return server;` at the end of
`createApp`, add:

```js
  server.store = store;
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test test/api.test.js`
Expected: PASS. The temporary `GET /api/admin/users` stub added in Step 4
exists only to exercise `requireAdmin`; keep the `asAdmin` `200`
assertion live now.

- [ ] **Step 6: Commit**

```bash
git add server/store.js server/index.js shared/contract.js test/api.test.js
git commit -m "feat: add admin/customer roles, requireAdmin guard, and bootstrap hook"
```

- [ ] **Step 7: Document the manual first-admin bootstrap**

This is an operational step, not code — write it down for whoever deploys
this (you, per your own account). After deploying this plan's backend
changes and registering your own account normally through the storefront:

```bash
docker exec corus-production-db-1 psql -U napo3d -d napo3d_production \
  -c "UPDATE users SET role = 'admin' WHERE email = 'your-email@example.com';"
```

Replace the email with whatever address you registered with. This is the
**only** manual step in the whole plan — every other admin can be
promoted afterward from the Users tab in the admin panel (Task 9).

---

## Task 2: Products table + seed migration from `data/models.json`

**Files:**
- Modify: `server/store.js` (schema + `listProducts`/`getProduct`/
  `createProduct`/`updateProduct`/`deleteProduct`/`seedProductsIfEmpty` on
  both `createPostgresStore` and `createMemoryStore`)
- Test: `test/store.test.js` (new file)

**Interfaces:**
- Produces (consumed by Task 3's admin routes and by `loadCatalog` in
  `server/index.js`, Task 3 Step 6): `store.listProducts() ->
  Promise<Product[]>`, `store.getProduct(id) -> Promise<Product|null>`,
  `store.createProduct(product) -> Promise<Product>`,
  `store.updateProduct(id, patch) -> Promise<Product|null>`,
  `store.deleteProduct(id) -> Promise<void>`, `store.seedProductsIfEmpty(products)
  -> Promise<{ seeded: number }>`, where `Product = { id, name, category,
  reference, summary, page, options, createdAt, updatedAt }`.
- Consumes: nothing new — these are additive methods on the objects
  already returned by `createPostgresStore()`/`createMemoryStore()`.

- [ ] **Step 1: Write the failing tests**

Create `test/store.test.js`:

```js
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
    ...overrides
  };
}

test('listProducts starts empty and reflects created products', async () => {
  const store = createMemoryStore();
  assert.deepEqual(await store.listProducts(), []);

  const created = await store.createProduct(sampleProduct());
  assert.equal(created.id, 'demo-product');

  const listed = await store.listProducts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].options[0].weight, 40);
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

test('seedProductsIfEmpty seeds only when the table is empty', async () => {
  const store = createMemoryStore();
  const first = await store.seedProductsIfEmpty([sampleProduct(), sampleProduct({ id: 'demo-2', name: 'Outro' })]);
  assert.equal(first.seeded, 2);
  assert.equal((await store.listProducts()).length, 2);

  const second = await store.seedProductsIfEmpty([sampleProduct({ id: 'demo-3' })]);
  assert.equal(second.seeded, 0);
  assert.equal((await store.listProducts()).length, 2);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `store.listProducts is not a function`.

- [ ] **Step 3: Add the `products` table to the schema**

In `server/store.js`, add to `SCHEMA_SQL` (after the `emails` table and
its `ALTER TABLE` lines from the mailer work):

```sql
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text,
  reference text,
  summary text,
  page integer,
  options jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
```

Note deliberately no foreign key from anything to `products.id` —
`order_items.product_id` stays a plain, unconstrained text column exactly
as it is today, so deleting a product never blocks or cascades into past
orders (see Global Constraints).

- [ ] **Step 4: Implement the memory store's product methods**

In `server/store.js`, `createMemoryStore` currently looks like this:

```js
export function createMemoryStore(initialState = EMPTY_STORE) {
  let state = structuredClone({ ...EMPTY_STORE, ...initialState });
  let pending = Promise.resolve();

  function runExclusive(task) {
    const result = pending.then(task, task);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async init() {},
    async read() {
      await pending;
      return structuredClone(state);
    },
    async write(nextStore) {
      return runExclusive(async () => {
        state = structuredClone(withStoreDefaults(nextStore));
        return structuredClone(state);
      });
    },
    async update(mutator) {
      return runExclusive(async () => {
        const nextStore = await mutator(structuredClone(state));
        state = structuredClone(withStoreDefaults(nextStore));
        return structuredClone(state);
      });
    },
    async close() {}
  };
}
```

Replace it with (adds an independent `products` array alongside the
existing big-state object — products are a separate concern from the
users/orders ledger, so they get their own storage, not another field
inside `EMPTY_STORE`/`withStoreDefaults`):

```js
export function createMemoryStore(initialState = EMPTY_STORE) {
  let state = structuredClone({ ...EMPTY_STORE, ...initialState });
  let products = structuredClone(initialState.products || []);
  let pending = Promise.resolve();

  function runExclusive(task) {
    const result = pending.then(task, task);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async init() {},
    async read() {
      await pending;
      return structuredClone(state);
    },
    async write(nextStore) {
      return runExclusive(async () => {
        state = structuredClone(withStoreDefaults(nextStore));
        return structuredClone(state);
      });
    },
    async update(mutator) {
      return runExclusive(async () => {
        const nextStore = await mutator(structuredClone(state));
        state = structuredClone(withStoreDefaults(nextStore));
        return structuredClone(state);
      });
    },
    async close() {},

    async listProducts() {
      await pending;
      return structuredClone(products).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    },
    async getProduct(id) {
      await pending;
      const found = products.find((product) => product.id === id);
      return found ? structuredClone(found) : null;
    },
    async createProduct(product) {
      return runExclusive(async () => {
        products.push(structuredClone(product));
        return structuredClone(product);
      });
    },
    async updateProduct(id, patch) {
      return runExclusive(async () => {
        const index = products.findIndex((product) => product.id === id);
        if (index === -1) return null;
        const next = { ...products[index], ...patch, id, updatedAt: new Date().toISOString() };
        products[index] = next;
        return structuredClone(next);
      });
    },
    async deleteProduct(id) {
      return runExclusive(async () => {
        products = products.filter((product) => product.id !== id);
      });
    },
    async seedProductsIfEmpty(seedList) {
      return runExclusive(async () => {
        if (products.length) return { seeded: 0 };
        products = structuredClone(seedList);
        return { seeded: seedList.length };
      });
    }
  };
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test test/store.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Implement the Postgres store's product methods**

In `server/store.js`, add a mapper function near the other row-mapping
helpers (next to `readStore`):

```js
function mapProductRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: undefinedIfNull(row.category),
    reference: undefinedIfNull(row.reference),
    summary: undefinedIfNull(row.summary),
    page: row.page == null ? undefined : Number(row.page),
    options: row.options || [],
    createdAt: asIsoString(row.created_at),
    updatedAt: asIsoString(row.updated_at)
  };
}
```

In `createPostgresStore`'s returned object (`server/store.js`), add these
methods alongside the existing `init`/`read`/`write`/`update`/`close`:

```js
    async listProducts() {
      return withClient(async (client) => {
        const result = await client.query('SELECT * FROM products ORDER BY created_at ASC, id ASC');
        return result.rows.map(mapProductRow);
      });
    },
    async getProduct(id) {
      return withClient(async (client) => {
        const result = await client.query('SELECT * FROM products WHERE id = $1', [id]);
        return result.rows[0] ? mapProductRow(result.rows[0]) : null;
      });
    },
    async createProduct(product) {
      return withClient(async (client) => {
        await client.query(
          `INSERT INTO products (id, name, category, reference, summary, page, options, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [
            product.id,
            product.name,
            nullIfEmpty(product.category),
            nullIfEmpty(product.reference),
            nullIfEmpty(product.summary),
            product.page ?? null,
            JSON.stringify(product.options || []),
            asTimestamp(product.createdAt),
            asTimestamp(product.updatedAt)
          ]
        );
        return product;
      });
    },
    async updateProduct(id, patch) {
      return withClient(async (client) => {
        const existing = await client.query('SELECT * FROM products WHERE id = $1', [id]);
        if (!existing.rows[0]) return null;
        const next = { ...mapProductRow(existing.rows[0]), ...patch, id, updatedAt: new Date().toISOString() };
        await client.query(
          `UPDATE products SET name = $2, category = $3, reference = $4, summary = $5, page = $6, options = $7::jsonb, updated_at = $8
           WHERE id = $1`,
          [
            id,
            next.name,
            nullIfEmpty(next.category),
            nullIfEmpty(next.reference),
            nullIfEmpty(next.summary),
            next.page ?? null,
            JSON.stringify(next.options || []),
            asTimestamp(next.updatedAt)
          ]
        );
        return next;
      });
    },
    async deleteProduct(id) {
      return withClient(async (client) => {
        await client.query('DELETE FROM products WHERE id = $1', [id]);
      });
    },
    async seedProductsIfEmpty(seedList) {
      return withClient(async (client) => {
        const existing = await client.query('SELECT count(*)::int AS count FROM products');
        if (existing.rows[0].count > 0) return { seeded: 0 };
        for (const product of seedList) {
          await client.query(
            `INSERT INTO products (id, name, category, reference, summary, page, options, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
             ON CONFLICT (id) DO NOTHING`,
            [
              product.id,
              product.name,
              nullIfEmpty(product.category),
              nullIfEmpty(product.reference),
              nullIfEmpty(product.summary),
              product.page ?? null,
              JSON.stringify(product.options || []),
              new Date(),
              new Date()
            ]
          );
        }
        return { seeded: seedList.length };
      });
    }
```

(Tests only exercise `createMemoryStore`'s versions, matching this
repo's existing convention where `test/api.test.js`/`test/mailer.test.js`
never touch `createPostgresStore` directly either — the Postgres path is
verified manually against the real database in Task 3's final step.)

- [ ] **Step 7: Commit**

```bash
git add server/store.js test/store.test.js
git commit -m "feat: add a products table with create/read/update/delete/seed methods"
```

---

## Task 3: Wire the catalog to the database + admin Products API

**Files:**
- Modify: `server/index.js` (`loadCatalog`, seed-on-boot, new
  `/api/admin/products*` routes)
- Modify: `shared/contract.js` (product input validation)
- Test: `test/api.test.js` (append)

**Interfaces:**
- Produces: `validateProductInput(product) -> { ok: true, product:
  NormalizedProduct } | { ok: false, code, message }` in
  `shared/contract.js`, reused by both the admin API here and the admin
  front-end in Task 8 for the same client-side validation.
- Consumes: `store.listProducts/getProduct/createProduct/updateProduct/
  deleteProduct/seedProductsIfEmpty` from Task 2; `requireAdmin` from
  Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `test/api.test.js`:

```js
async function loginAsNewAdmin(app, email) {
  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Admin', email, password: '12345678' })
  });
  await app.promoteToAdmin(email);
  return { Authorization: `Bearer ${register.json.accessToken}` };
}

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
      options: [{ name: 'Verde', weight: 120, score: 4 }]
    })
  });
  assert.equal(create.response.status, 201);
  const productId = create.json.product.id;
  assert.ok(productId);

  const publicList = await api(app, '/api/products?limit=200');
  assert.ok(publicList.json.items.some((item) => item.id === productId));

  const update = await api(app, `/api/admin/products/${productId}`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ name: 'Vaso Geométrico Grande' })
  });
  assert.equal(update.json.product.name, 'Vaso Geométrico Grande');

  const del = await api(app, `/api/admin/products/${productId}`, { method: 'DELETE', headers: admin });
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
    body: JSON.stringify({ name: 'Sem opções', options: [] })
  });
  assert.equal(noOptions.response.status, 422);

  const badWeight = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: 'Peso inválido', options: [{ name: 'Única', weight: 0 }] })
  });
  assert.equal(badWeight.response.status, 422);
});

test('a customer cannot create, update, or delete products', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cliente', email: 'cliente-products@example.com', password: '12345678' })
  });
  const customer = { Authorization: `Bearer ${register.json.accessToken}` };

  const create = await api(app, '/api/admin/products', {
    method: 'POST',
    headers: customer,
    body: JSON.stringify({ name: 'x', options: [{ name: 'x', weight: 1 }] })
  });
  assert.equal(create.response.status, 403);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/api.test.js`
Expected: FAIL — `/api/admin/products` routes don't exist (404s where
201/422/403 are expected).

- [ ] **Step 3: Add product validation to `shared/contract.js`**

Add near `validateAddressInput`:

```js
export function normalizeProductOptionInput(option = {}) {
  return {
    name: normalizeRequiredText(option.name),
    url: normalizeOptionalText(option.url),
    imageUrl: normalizeOptionalText(option.imageUrl),
    source: normalizeOptionalText(option.source),
    dims: normalizeOptionalText(option.dims),
    time: normalizeOptionalText(option.time),
    rating: normalizeOptionalText(option.rating),
    material: normalizeOptionalText(option.material),
    colors: normalizeOptionalText(option.colors),
    ams: normalizeOptionalText(option.ams),
    support: normalizeOptionalText(option.support),
    weight: Number(option.weight),
    weight_kind: normalizeOptionalText(option.weight_kind),
    license: normalizeOptionalText(option.license),
    notes: normalizeOptionalText(option.notes),
    score: Number.isFinite(Number(option.score)) ? Number(option.score) : 0,
    cost: Number.isFinite(Number(option.cost)) ? Number(option.cost) : undefined,
    thumb: normalizeOptionalText(option.thumb),
    free: Boolean(option.free)
  };
}

export function validateProductInput(product = {}) {
  const name = normalizeRequiredText(product.name);
  if (!name) {
    return { ok: false, code: 'INVALID_PRODUCT', message: 'Nome do produto é obrigatório.' };
  }
  const rawOptions = Array.isArray(product.options) ? product.options : [];
  if (!rawOptions.length) {
    return { ok: false, code: 'INVALID_PRODUCT', message: 'Cadastre ao menos uma variação (opção).' };
  }
  const options = rawOptions.map(normalizeProductOptionInput);
  for (const option of options) {
    if (!option.name) {
      return { ok: false, code: 'INVALID_PRODUCT', message: 'Toda variação precisa de um nome.' };
    }
    if (!Number.isFinite(option.weight) || option.weight <= 0) {
      return { ok: false, code: 'INVALID_PRODUCT', message: `Peso inválido para a variação "${option.name}".` };
    }
  }
  return {
    ok: true,
    product: {
      name,
      category: normalizeOptionalText(product.category) || '',
      reference: normalizeOptionalText(product.reference) || '',
      summary: normalizeOptionalText(product.summary) || '',
      page: Number.isFinite(Number(product.page)) ? Number(product.page) : undefined,
      options
    }
  };
}
```

- [ ] **Step 4: Switch `loadCatalog` to read from the store, and seed once on boot**

In `server/index.js`, replace the whole `loadCatalog` function and the
`catalogPath` line:

```js
  const catalogPath = path.join(rootDir, 'data', 'models.json');
  const corsOrigins = resolveCorsOrigins(options.corsOrigins);
  const rateLimits = new Map();

  const catalogState = {
    loadedAt: 0,
    items: []
  };

  async function loadCatalog() {
    if (catalogState.items.length && Date.now() - catalogState.loadedAt < 5_000) {
      return catalogState.items;
    }
    const raw = await readFile(catalogPath, 'utf8');
    catalogState.items = JSON.parse(raw);
    catalogState.loadedAt = Date.now();
    return catalogState.items;
  }
```

with:

```js
  const catalogSeedPath = path.join(rootDir, 'data', 'models.json');
  const corsOrigins = resolveCorsOrigins(options.corsOrigins);
  const rateLimits = new Map();

  const catalogState = {
    loadedAt: 0,
    items: []
  };

  let seedCatalogPromise = null;

  async function seedCatalogIfNeeded() {
    const raw = await readFile(catalogSeedPath, 'utf8');
    const seedProducts = JSON.parse(raw).map((product) => ({
      ...product,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    const result = await store.seedProductsIfEmpty(seedProducts);
    if (result.seeded) console.log(`[catalog] seeded ${result.seeded} products from data/models.json`);
  }

  function invalidateCatalogCache() {
    catalogState.loadedAt = 0;
  }

  async function loadCatalog() {
    if (catalogState.items.length && Date.now() - catalogState.loadedAt < 5_000) {
      return catalogState.items;
    }
    catalogState.items = await store.listProducts();
    catalogState.loadedAt = Date.now();
    return catalogState.items;
  }
```

`readFile`/`path` stay imported (still used for the one-time seed read).

Call the seed step wherever `store.init?.()` is already awaited so it
only runs once per process, right at the top of `handleApi` — change:

```js
  async function handleApi(request, response, pathname) {
    await store.init?.();
```

to:

```js
  async function ensureStoreReady() {
    await store.init?.();
    if (!seedCatalogPromise) {
      seedCatalogPromise = seedCatalogIfNeeded();
    }
    await seedCatalogPromise;
  }

  async function handleApi(request, response, pathname) {
    await ensureStoreReady();
```

(`seedProductsIfEmpty` is itself idempotent, but "seed once on boot"
should actually mean once per process: avoid rereading `data/models.json`
and reissuing the `count(*)` query on every request.)

- [ ] **Step 5: Add the `/api/admin/products*` routes**

In `server/index.js`, add the import:

```js
import {
  buildQuote,
  normalizeAddressInput,
  normalizeEmail,
  normalizeUserRole,
  productionTimeMinutes,
  sortProducts,
  validateAddressInput,
  validateProductInput
} from '../shared/contract.js';
```

Add these routes in `handleApi`, right after the existing `GET
/api/products/:productId` block and before the `POST
/api/auth/register` block:

```js
    if (request.method === 'GET' && pathname === '/api/admin/products') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const products = await loadCatalog();
      writeJson(response, 200, { products: sortProducts(products, 'name') });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/products') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const body = await parseBody(request);
      const validation = validateProductInput(body);
      if (!validation.ok) {
        errorResponse(request, response, 422, validation.code, validation.message);
        return;
      }
      const now = new Date().toISOString();
      const product = { id: crypto.randomUUID(), ...validation.product, createdAt: now, updatedAt: now };
      await store.createProduct(product);
      invalidateCatalogCache();
      writeJson(response, 201, { product });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/admin/products/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const productId = decodeURIComponent(pathname.split('/').pop());
      const product = await store.getProduct(productId);
      if (!product) {
        errorResponse(request, response, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
        return;
      }
      writeJson(response, 200, { product });
      return;
    }

    if (request.method === 'PATCH' && pathname.startsWith('/api/admin/products/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const productId = decodeURIComponent(pathname.split('/').pop());
      const existing = await store.getProduct(productId);
      if (!existing) {
        errorResponse(request, response, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
        return;
      }
      const body = await parseBody(request);
      const validation = validateProductInput({ ...existing, ...body });
      if (!validation.ok) {
        errorResponse(request, response, 422, validation.code, validation.message);
        return;
      }
      const product = await store.updateProduct(productId, validation.product);
      invalidateCatalogCache();
      writeJson(response, 200, { product });
      return;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/api/admin/products/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const productId = decodeURIComponent(pathname.split('/').pop());
      await store.deleteProduct(productId);
      invalidateCatalogCache();
      writeNoContent(response);
      return;
    }
```

Note the route-matching order: because Node evaluates these `if` blocks
top-to-bottom and `pathname.startsWith('/api/admin/products/')` would
also match the literal collection route if it weren't checked first,
`GET /api/admin/products` (the exact, no-trailing-segment match) must
stay **before** the `startsWith('/api/admin/products/')` blocks — exactly
as written above.

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `node --test`
Expected: PASS — all previous tests plus the new admin-products ones.
Task 1's `/api/admin/users` auth-gate assertion should already be passing
via the temporary stub added there; no extra test edits are needed in
this task.

- [ ] **Step 7: Commit**

```bash
git add server/index.js shared/contract.js test/api.test.js
git commit -m "feat: move product catalog into Postgres, add admin products CRUD API"
```

- [ ] **Step 8: Manual verification against real Postgres (local dev)**

```bash
docker compose up --build -d
curl -s http://127.0.0.1:3001/api/products | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).items.length))"
```

Expected: prints the same count as `data/models.json` has entries — this
is the seed step firing against a real database, not just the in-memory
test store.

---

## Task 4: Admin Orders API (list all, detail, status update)

**Files:**
- Modify: `shared/contract.js` (order status enum)
- Modify: `server/index.js` (three new routes)
- Test: `test/api.test.js` (append)

**Interfaces:**
- Produces: `ORDER_STATUSES` array in `shared/contract.js` (reused by the
  admin front-end in Task 9 to render the status `<select>`).
- Consumes: `requireAdmin` from Task 1. No store changes needed — orders
  already live in the store's big state object read by `requireAdmin`'s
  returned `store` snapshot.

- [ ] **Step 1: Write the failing tests**

Append to `test/api.test.js`:

```js
test('admin can list every order across all customers and view one in detail', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Dora', email: 'dora-orders@example.com', password: '12345678' })
  });
  const customerAuth = { Authorization: `Bearer ${customer.json.accessToken}` };
  const address = await api(app, '/api/me/addresses', {
    method: 'POST', headers: customerAuth,
    body: JSON.stringify({ recipientName: 'Dora', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' })
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { ...customerAuth, 'Idempotency-Key': 'admin-orders-1' },
    body: JSON.stringify({
      items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }],
      addressId: address.json.address.id,
      customer: { name: 'Dora', email: 'dora-orders@example.com' }
    })
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
    body: JSON.stringify({ name: 'Elis', email: 'elis-orders@example.com', password: '12345678' })
  });
  const customerAuth = { Authorization: `Bearer ${customer.json.accessToken}` };
  const address = await api(app, '/api/me/addresses', {
    method: 'POST', headers: customerAuth,
    body: JSON.stringify({ recipientName: 'Elis', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' })
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { ...customerAuth, 'Idempotency-Key': 'admin-orders-2' },
    body: JSON.stringify({
      items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }],
      addressId: address.json.address.id,
      customer: { name: 'Elis', email: 'elis-orders@example.com' }
    })
  });

  const admin = await loginAsNewAdmin(app, 'admin-orders-2@example.com');
  const invalid = await api(app, `/api/admin/orders/${order.json.order.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'not-a-real-status' })
  });
  assert.equal(invalid.response.status, 422);

  const valid = await api(app, `/api/admin/orders/${order.json.order.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'confirmed' })
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.json.order.status, 'confirmed');

  const asCustomerAgain = await api(app, `/api/me/orders/${order.json.order.id}`, { headers: customerAuth });
  assert.equal(asCustomerAgain.json.order.status, 'confirmed');
});

test('a customer cannot list all orders or change order status', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const register = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Fabio', email: 'fabio-orders@example.com', password: '12345678' })
  });
  const customer = { Authorization: `Bearer ${register.json.accessToken}` };

  const list = await api(app, '/api/admin/orders', { headers: customer });
  assert.equal(list.response.status, 403);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/api.test.js`
Expected: FAIL — `/api/admin/orders*` routes don't exist yet.

- [ ] **Step 3: Add the order status enum to `shared/contract.js`**

Add near `USER_ROLES`:

```js
export const ORDER_STATUSES = ['pending', 'confirmed', 'in_production', 'shipped', 'completed', 'cancelled'];
```

- [ ] **Step 4: Add the `/api/admin/orders*` routes**

In `server/index.js`, update the import to include `ORDER_STATUSES`:

```js
import {
  buildQuote,
  normalizeAddressInput,
  normalizeEmail,
  normalizeUserRole,
  ORDER_STATUSES,
  productionTimeMinutes,
  sortProducts,
  validateAddressInput,
  validateProductInput
} from '../shared/contract.js';
```

Add these routes right after the existing `GET /api/me/orders/:id` block
(before the final `errorResponse(request, response, 404, 'NOT_FOUND', ...)`
fallback):

```js
    if (request.method === 'GET' && pathname === '/api/admin/orders') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const url = new URL(request.url, 'http://localhost');
      const statusFilter = String(url.searchParams.get('status') || '').trim();
      const orders = admin.store.orders
        .filter((order) => !statusFilter || order.status === statusFilter)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      writeJson(response, 200, { orders });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/admin/orders/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const orderId = decodeURIComponent(pathname.split('/').pop());
      const order = admin.store.orders.find((entry) => entry.id === orderId);
      if (!order) {
        errorResponse(request, response, 404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');
        return;
      }
      writeJson(response, 200, { order });
      return;
    }

    if (request.method === 'PATCH' && pathname.startsWith('/api/admin/orders/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const orderId = decodeURIComponent(pathname.split('/').pop());
      const body = await parseBody(request);
      if (!ORDER_STATUSES.includes(body.status)) {
        errorResponse(request, response, 422, 'INVALID_STATUS', `Status inválido. Use um de: ${ORDER_STATUSES.join(', ')}.`);
        return;
      }
      let updatedOrder = null;
      await store.update((nextStore) => {
        const target = nextStore.orders.find((entry) => entry.id === orderId);
        if (!target) {
          const error = new Error('Pedido não encontrado.');
          error.code = 'ORDER_NOT_FOUND';
          throw error;
        }
        updatedOrder = { ...target, status: body.status, updatedAt: new Date().toISOString() };
        nextStore.orders = nextStore.orders.map((entry) => entry.id === orderId ? updatedOrder : entry);
        return nextStore;
      });
      writeJson(response, 200, { order: updatedOrder });
      return;
    }
```

`ORDER_NOT_FOUND` already gets mapped to a 404 by the existing generic
`error.code.endsWith('_NOT_FOUND')` branch in the top-level error
handler — no changes needed there.

Note the same route-ordering rule as Task 3: `GET /api/admin/orders`
(exact match) must be checked before the two `startsWith('/api/admin/orders/')`
blocks.

- [ ] **Step 5: No deferred assertion cleanup is needed**

Task 1 now keeps its `/api/admin/users` auth-gate assertion live by using
the temporary stub route added there. Do not comment or uncomment
anything in this task.

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `node --test`
Expected: PASS — all previous tests plus the three new admin-orders ones.

- [ ] **Step 7: Commit**

```bash
git add shared/contract.js server/index.js test/api.test.js
git commit -m "feat: add admin orders API (list all, detail, status update)"
```

---

## Task 5: Admin Users API (list, detail with addresses, role/profile update, delete)

**Files:**
- Modify: `server/store.js` (make `orders.user_id` nullable with
  `ON DELETE SET NULL`, fix the `readStore`/`replaceStore` mapping)
- Modify: `server/index.js` (four new routes)
- Test: `test/api.test.js` (append)

**Interfaces:**
- Consumes: `requireAdmin` from Task 1, `USER_ROLES`/`normalizeUserRole`
  from Task 1.
- No new store methods needed — users/addresses/orders are already all
  in the big state object; this task only changes how `orders.user_id`
  behaves when its owning user row is deleted.

- [ ] **Step 1: Write the failing tests**

Append to `test/api.test.js`:

```js
test('admin can list users and see one user\'s detail with their addresses', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Gil', email: 'gil-users@example.com', password: '12345678' })
  });
  await api(app, '/api/me/addresses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${customer.json.accessToken}` },
    body: JSON.stringify({ recipientName: 'Gil', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' })
  });

  const admin = await loginAsNewAdmin(app, 'admin-users@example.com');
  const list = await api(app, '/api/admin/users', { headers: admin });
  assert.equal(list.response.status, 200);
  assert.ok(list.json.users.some((entry) => entry.email === 'gil-users@example.com'));
  assert.equal(list.json.users.every((entry) => !('passwordHash' in entry)), true);

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
    body: JSON.stringify({ name: 'Hugo', email: 'hugo-users@example.com', password: '12345678' })
  });
  const adminEmail = 'admin-promote@example.com';
  const adminRegister = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Admin', email: adminEmail, password: '12345678' })
  });
  await app.promoteToAdmin(adminEmail);
  const admin = { Authorization: `Bearer ${adminRegister.json.accessToken}` };

  const promote = await api(app, `/api/admin/users/${customer.json.user.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({ role: 'admin' })
  });
  assert.equal(promote.response.status, 200);
  assert.equal(promote.json.user.role, 'admin');

  const selfDemote = await api(app, `/api/admin/users/${adminRegister.json.user.id}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify({ role: 'customer' })
  });
  assert.equal(selfDemote.response.status, 422);
  assert.equal(selfDemote.json.error.code, 'CANNOT_CHANGE_OWN_ROLE');
});

test('deleting a user cannot target yourself, and preserves the deleted user\'s orders with a null owner', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const customer = await api(app, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ines', email: 'ines-users@example.com', password: '12345678' })
  });
  const customerAuth = { Authorization: `Bearer ${customer.json.accessToken}` };
  const address = await api(app, '/api/me/addresses', {
    method: 'POST', headers: customerAuth,
    body: JSON.stringify({ recipientName: 'Ines', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' })
  });
  const order = await api(app, '/api/orders', {
    method: 'POST',
    headers: { ...customerAuth, 'Idempotency-Key': 'delete-user-1' },
    body: JSON.stringify({
      items: [{ productId: 'p3-card', optionName: 'Business Card Holder — Japandi/Ribbed', quantity: 12 }],
      addressId: address.json.address.id,
      customer: { name: 'Ines', email: 'ines-users@example.com' }
    })
  });

  const admin = await loginAsNewAdmin(app, 'admin-delete@example.com');

  const selfDelete = await api(app, `/api/admin/users/${(await (await api(app, '/api/me', { headers: admin })).json).user.id}`, {
    method: 'DELETE', headers: admin
  });
  assert.equal(selfDelete.response.status, 422);

  const del = await api(app, `/api/admin/users/${customer.json.user.id}`, { method: 'DELETE', headers: admin });
  assert.equal(del.response.status, 204);

  const store = await app.store.read();
  const survivingOrder = store.orders.find((entry) => entry.id === order.json.order.id);
  assert.ok(survivingOrder, 'order must survive user deletion');
  assert.equal(survivingOrder.userId, undefined);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/api.test.js`
Expected: FAIL — `/api/admin/users*` routes don't exist yet.

- [ ] **Step 3: Make `orders.user_id` nullable with `ON DELETE SET NULL`**

In `server/store.js`, the `orders` table currently declares:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
```

`BACKEND_CONTRACT.md` already types `Order.userId` as optional
(`userId?: string`) — the schema just hadn't been updated to match.
Add these two lines to `SCHEMA_SQL` right after the `orders` table's
closing `);` (so they run as idempotent migrations against any
already-existing table, exactly like the `emails` table's `ALTER TABLE
... ADD COLUMN IF NOT EXISTS` lines from the mailer work):

```sql
ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
```

In `readStore` (`server/store.js`), change the `orders` mapping's
`userId` field from:

```js
      userId: row.user_id,
```

to:

```js
      userId: undefinedIfNull(row.user_id),
```

In `replaceStore` (`server/store.js`), change the `orders` insert's
`user_id` parameter from:

```js
        order.userId,
```

to:

```js
        nullIfEmpty(order.userId),
```

(This only changes behavior for orders whose owning user has since been
deleted through the new admin endpoint below — every existing code path
that creates an order still always sets `userId: sessionUser.user.id`,
never null, since order creation still requires authentication.)

- [ ] **Step 4: Add the `/api/admin/users*` routes**

In `server/index.js`, update the import to include `USER_ROLES`:

```js
import {
  buildQuote,
  normalizeAddressInput,
  normalizeEmail,
  normalizeUserRole,
  ORDER_STATUSES,
  productionTimeMinutes,
  sortProducts,
  USER_ROLES,
  validateAddressInput,
  validateProductInput
} from '../shared/contract.js';
```

Add these routes right after the `/api/admin/orders*` block from Task 4,
replacing the temporary exact-match `GET /api/admin/users` stub added in
Task 1 with the real collection implementation:

```js
    if (request.method === 'GET' && pathname === '/api/admin/users') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const url = new URL(request.url, 'http://localhost');
      const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
      const users = admin.store.users
        .filter((user) => !query || `${user.name} ${user.email}`.toLowerCase().includes(query))
        .map(sanitizeUser)
        .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
      writeJson(response, 200, { users });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/admin/users/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const userId = decodeURIComponent(pathname.split('/').pop());
      const user = admin.store.users.find((entry) => entry.id === userId);
      if (!user) {
        errorResponse(request, response, 404, 'USER_NOT_FOUND', 'Usuário não encontrado.');
        return;
      }
      const addresses = admin.store.addresses.filter((entry) => entry.userId === userId);
      const orders = admin.store.orders
        .filter((entry) => entry.userId === userId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      writeJson(response, 200, { user: sanitizeUser(user), addresses, orders });
      return;
    }

    if (request.method === 'PATCH' && pathname.startsWith('/api/admin/users/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const userId = decodeURIComponent(pathname.split('/').pop());
      const body = await parseBody(request);
      if (body.role !== undefined) {
        if (!USER_ROLES.includes(body.role)) {
          errorResponse(request, response, 422, 'INVALID_ROLE', `Papel inválido. Use um de: ${USER_ROLES.join(', ')}.`);
          return;
        }
        if (userId === admin.user.id && body.role !== admin.user.role) {
          errorResponse(request, response, 422, 'CANNOT_CHANGE_OWN_ROLE', 'Você não pode alterar seu próprio papel.');
          return;
        }
      }
      let updatedUser = null;
      await store.update((nextStore) => {
        const target = nextStore.users.find((entry) => entry.id === userId);
        if (!target) {
          const error = new Error('Usuário não encontrado.');
          error.code = 'USER_NOT_FOUND';
          throw error;
        }
        updatedUser = {
          ...target,
          name: body.name !== undefined ? String(body.name).trim() || target.name : target.name,
          phone: body.phone !== undefined ? String(body.phone).trim() || undefined : target.phone,
          role: body.role !== undefined ? normalizeUserRole(body.role) : target.role,
          updatedAt: new Date().toISOString()
        };
        nextStore.users = nextStore.users.map((entry) => entry.id === userId ? updatedUser : entry);
        return nextStore;
      });
      writeJson(response, 200, { user: sanitizeUser(updatedUser) });
      return;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/api/admin/users/')) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const userId = decodeURIComponent(pathname.split('/').pop());
      if (userId === admin.user.id) {
        errorResponse(request, response, 422, 'CANNOT_DELETE_SELF', 'Você não pode excluir a própria conta por aqui.');
        return;
      }
      await store.update((nextStore) => {
        const target = nextStore.users.find((entry) => entry.id === userId);
        if (!target) {
          const error = new Error('Usuário não encontrado.');
          error.code = 'USER_NOT_FOUND';
          throw error;
        }
        nextStore.users = nextStore.users.filter((entry) => entry.id !== userId);
        nextStore.sessions = nextStore.sessions.filter((entry) => entry.userId !== userId);
        nextStore.addresses = nextStore.addresses.filter((entry) => entry.userId !== userId);
        nextStore.idempotencyKeys = nextStore.idempotencyKeys.filter((entry) => entry.userId !== userId);
        nextStore.orders = nextStore.orders.map((entry) => entry.userId === userId ? { ...entry, userId: undefined } : entry);
        return nextStore;
      });
      writeNoContent(response);
      return;
    }
```

Note: `createMemoryStore`'s `update()` doesn't enforce a real foreign-key
`ON DELETE SET NULL` the way Postgres does — the `nextStore.orders.map(...)`
line above does that same "detach instead of cascade" behavior by hand,
so both stores behave identically. This is also why the `DELETE` handler
filters `sessions`/`addresses`/`idempotencyKeys` manually instead of
relying on cascade: `createMemoryStore` has no real foreign keys at all,
it only mimics Postgres's cascade behavior by convention — these lines
keep that convention consistent for the new "preserve orders" rule too.

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test`
Expected: PASS — every test in the suite, including Task 1's through
Task 5's.

- [ ] **Step 6: Commit**

```bash
git add server/store.js server/index.js test/api.test.js
git commit -m "feat: add admin users CRUD (list, detail+addresses+orders, role update, delete)"
```

---

## Task 6: `api-client.js` admin methods

**Files:**
- Modify: `js/api-client.js`

**Interfaces:**
- Produces: a new exported `adminClient` object — `{ listProducts,
  createProduct, updateProduct, deleteProduct, listOrders, getOrder,
  updateOrderStatus, listUsers, getUser, updateUser, deleteUser }` — each
  method returns a `Promise` resolving to the parsed JSON body, or
  rejecting with the same `ApiError` shape `apiClient`'s methods already
  throw (`error.status`, `error.code`, `error.message`).
- Consumes: the module-private `request()` and `queryString()` helpers
  already defined in `js/api-client.js` (unchanged) — admin calls go
  straight through `request()`, deliberately bypassing `invoke()`'s
  mock/live fallback switching, since the admin panel is a live-backend
  only feature (Global Constraints).

Nothing here needs a written test — `js/api-client.js` has no existing
test coverage in this repo (front-end code is smoke-tested by running
the app in a browser, not unit tested — see the existing `test/`
directory, which only covers `server/*` and `shared/*`). Task 8's manual
verification step exercises this file end-to-end instead.

- [ ] **Step 1: Add the `adminClient` export**

At the end of `js/api-client.js`, after the existing `export const
apiClient = { ... };` block, add:

```js
export const adminClient = {
  listProducts: () => request('/api/admin/products'),
  createProduct: (payload) => request('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) }),
  updateProduct: (id, payload) => request(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteProduct: (id) => request(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listOrders: (params) => request(`/api/admin/orders${queryString(params)}`),
  getOrder: (id) => request(`/api/admin/orders/${encodeURIComponent(id)}`),
  updateOrderStatus: (id, statusValue) => request(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: statusValue }) }),
  listUsers: (params) => request(`/api/admin/users${queryString(params)}`),
  getUser: (id) => request(`/api/admin/users/${encodeURIComponent(id)}`),
  updateUser: (id, payload) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteUser: (id) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
};
```

- [ ] **Step 2: Commit**

```bash
git add js/api-client.js
git commit -m "feat: add adminClient methods to api-client.js"
```

---

## Task 7: Admin panel shell — `admin.html`, `css/admin.css`, auth gate, tabs, Products panel

**Files:**
- Create: `admin.html`
- Create: `css/admin.css`
- Create: `js/admin.js`
- Modify: `Dockerfile.frontend`

**Interfaces:**
- Consumes: `apiClient` (from `js/api-client.js`, for `init()`/`getMe()`)
  and `adminClient` (Task 6) for every admin API call; `money()`-style
  formatting is duplicated locally (small, one-line — not worth sharing
  a module for a single currency formatter).
- Produces: nothing consumed elsewhere — this is the top of the admin
  app's dependency graph.

This task has no automated tests (see Task 6's note — this repo has no
front-end unit tests, only manual browser verification, matching how
`js/app.js` itself is verified). Its own final step is the manual check.

- [ ] **Step 1: Create `admin.html`**

```html
<!doctype html>
<html lang="pt-BR">

<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Painel administrativo | napo3d</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
    rel="stylesheet" />
  <link rel="stylesheet" href="./css/styles.css" />
  <link rel="stylesheet" href="./css/admin.css" />
</head>

<body>
  <header class="site-header">
    <div class="container nav-wrap">
      <a class="brand" href="./index.html" aria-label="Voltar à loja">
        <span class="brand-mark">3D</span>
        <span>Painel administrativo</span>
      </a>
      <nav aria-label="Navegação do painel">
        <a href="./index.html">Ver loja</a>
        <button class="nav-account" id="admin-logout" type="button" hidden>Sair</button>
      </nav>
    </div>
  </header>

  <main class="store-page">
    <div class="container store-page-inner admin-inner">
      <p class="form-status" id="admin-guard-status" role="status">Verificando acesso...</p>

      <div id="admin-app" hidden>
        <span class="eyebrow">Área restrita</span>
        <h1>Painel administrativo</h1>
        <div class="segmented-controls" id="admin-tabs">
          <button class="segmented-button is-active" data-admin-tab="products" type="button">Produtos</button>
          <button class="segmented-button" data-admin-tab="orders" type="button">Pedidos</button>
          <button class="segmented-button" data-admin-tab="users" type="button">Usuários</button>
        </div>

        <section class="info-section admin-panel" id="admin-panel-products">
          <div class="section-heading">
            <h2>Produtos</h2>
            <button class="button button-primary" id="admin-product-new" type="button">Novo produto</button>
          </div>
          <div class="info-list admin-list" id="admin-products-list"></div>
        </section>

        <section class="info-section admin-panel" id="admin-panel-orders" hidden>
          <div class="section-heading">
            <h2>Pedidos</h2>
            <label class="sort-box">
              <span>Status</span>
              <select id="admin-orders-filter">
                <option value="">Todos</option>
                <option value="pending">Pendente</option>
                <option value="confirmed">Confirmado</option>
                <option value="in_production">Em produção</option>
                <option value="shipped">Enviado</option>
                <option value="completed">Concluído</option>
                <option value="cancelled">Cancelado</option>
              </select>
            </label>
          </div>
          <div class="info-list admin-list" id="admin-orders-list"></div>
        </section>

        <section class="info-section admin-panel" id="admin-panel-users" hidden>
          <div class="section-heading">
            <h2>Usuários</h2>
            <label class="search-box">
              <span aria-hidden="true">⌕</span>
              <input id="admin-users-search" type="search" placeholder="Buscar por nome ou e-mail" aria-label="Buscar usuários" />
            </label>
          </div>
          <div class="info-list admin-list" id="admin-users-list"></div>
        </section>
      </div>
    </div>
  </main>

  <dialog class="quantity-dialog admin-dialog" id="admin-product-dialog">
    <button class="dialog-close" id="admin-product-dialog-close" type="button" aria-label="Fechar">×</button>
    <span class="eyebrow" id="admin-product-dialog-eyebrow">Novo produto</span>
    <h2 id="admin-product-dialog-title">Cadastrar produto</h2>
    <form id="admin-product-form">
      <label>Nome<input name="name" required></label>
      <div class="form-row">
        <label>Categoria<input name="category"></label>
        <label>Página do catálogo<input name="page" type="number" min="1" step="1"></label>
      </div>
      <label>Resumo<input name="summary"></label>
      <label>Imagem de referência (URL ou data URI)<input name="reference"></label>
      <div class="admin-options-heading">
        <span>Variações</span>
        <button class="button button-secondary" id="admin-option-add" type="button">Adicionar variação</button>
      </div>
      <div id="admin-options-list"></div>
      <p class="form-status" id="admin-product-status" role="status"></p>
      <div class="inline-actions">
        <button class="button button-primary" type="submit">Salvar produto</button>
      </div>
    </form>
  </dialog>

  <template id="admin-option-row-template">
    <div class="admin-option-row">
      <div class="form-row">
        <label>Nome da variação<input data-option-field="name" required></label>
        <label>Peso (g)<input data-option-field="weight" type="number" min="1" step="1" required></label>
      </div>
      <div class="form-row">
        <label>Cor(es)<input data-option-field="colors"></label>
        <label>Pontuação (ordenação)<input data-option-field="score" type="number" step="1"></label>
      </div>
      <div class="form-row">
        <label>URL (MakerWorld etc.)<input data-option-field="url"></label>
        <label>URL da imagem<input data-option-field="imageUrl"></label>
      </div>
      <button class="button button-secondary admin-option-remove" type="button">Remover variação</button>
    </div>
  </template>

  <dialog class="quantity-dialog admin-dialog" id="admin-order-dialog">
    <button class="dialog-close" id="admin-order-dialog-close" type="button" aria-label="Fechar">×</button>
    <span class="eyebrow">Pedido</span>
    <h2 id="admin-order-dialog-title">Detalhe do pedido</h2>
    <div class="info-list" id="admin-order-detail"></div>
    <label>Status
      <select id="admin-order-status-select">
        <option value="pending">Pendente</option>
        <option value="confirmed">Confirmado</option>
        <option value="in_production">Em produção</option>
        <option value="shipped">Enviado</option>
        <option value="completed">Concluído</option>
        <option value="cancelled">Cancelado</option>
      </select>
    </label>
    <p class="form-status" id="admin-order-status-message" role="status"></p>
    <div class="inline-actions">
      <button class="button button-primary" id="admin-order-status-save" type="button">Salvar status</button>
    </div>
  </dialog>

  <dialog class="quantity-dialog admin-dialog" id="admin-user-dialog">
    <button class="dialog-close" id="admin-user-dialog-close" type="button" aria-label="Fechar">×</button>
    <span class="eyebrow">Usuário</span>
    <h2 id="admin-user-dialog-title">Detalhe do usuário</h2>
    <div class="info-list" id="admin-user-profile"></div>
    <label>Nome<input id="admin-user-name"></label>
    <label>Telefone<input id="admin-user-phone"></label>
    <label>Papel
      <select id="admin-user-role">
        <option value="customer">Cliente</option>
        <option value="admin">Administrador</option>
      </select>
    </label>
    <p class="form-status" id="admin-user-status" role="status"></p>
    <div class="inline-actions">
      <button class="button button-primary" id="admin-user-save" type="button">Salvar alterações</button>
      <button class="button button-danger" id="admin-user-delete" type="button">Excluir usuário</button>
    </div>
    <section class="info-section">
      <div class="section-heading"><h2>Endereços</h2></div>
      <div class="info-list" id="admin-user-addresses"></div>
    </section>
    <section class="info-section">
      <div class="section-heading"><h2>Pedidos</h2></div>
      <div class="info-list" id="admin-user-orders"></div>
    </section>
  </dialog>

  <script src="./js/admin.js" type="module"></script>
</body>

</html>
```

- [ ] **Step 2: Create `css/admin.css`**

This file only adds what `css/styles.css` genuinely doesn't have yet — it
never redefines an existing class, only extends the same design tokens.

```css
.admin-inner {
  max-width: 1080px;
}

.admin-panel {
  margin-top: 24px;
}

.admin-list {
  gap: 10px;
}

.admin-list-row {
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  padding: 14px 18px;
}

.admin-list-row-info {
  display: grid;
  gap: 4px;
}

.admin-list-row-info span {
  color: var(--muted);
  font-size: 13px;
}

.admin-list-row-actions {
  display: flex;
  gap: 8px;
}

.button-danger {
  background: transparent;
  border: 1px solid var(--accent-dark);
  color: var(--accent-dark);
}

.inline-badge.role-admin {
  background: var(--accent);
  color: #fff;
}

.admin-options-heading {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin: 18px 0 10px;
}

.admin-option-row {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 14px;
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
  padding: 14px;
}

.admin-dialog {
  max-width: 640px;
  max-height: calc(100vh - 64px);
  overflow-y: auto;
}
```

- [ ] **Step 3: Create `js/admin.js` — auth gate, tab switching, and the Products panel**

```js
import { apiClient, adminClient } from './api-client.js';

const $ = (selector) => document.querySelector(selector);
const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 });
const text = (value) => value == null || value === '' ? '' : String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const state = {
  me: null,
  activeTab: 'products',
  products: [],
  editingProductId: null
};

function setStatus(selector, message, tone = '') {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || '';
  node.dataset.tone = tone;
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.classList.toggle('is-active', button.dataset.adminTab === tab));
  document.querySelectorAll('.admin-panel').forEach((panel) => {
    panel.hidden = panel.id !== `admin-panel-${tab}`;
  });
  if (tab === 'products') loadProducts();
  if (tab === 'orders') loadOrders();
  if (tab === 'users') loadUsers();
}

// --- Products -------------------------------------------------------------

function optionRowValues(row) {
  const field = (name) => row.querySelector(`[data-option-field="${name}"]`)?.value || '';
  return {
    name: field('name'),
    weight: Number(field('weight')),
    colors: field('colors'),
    score: Number(field('score')) || 0,
    url: field('url'),
    imageUrl: field('imageUrl')
  };
}

function addOptionRow(option = {}) {
  const template = $('#admin-option-row-template');
  const clone = template.content.firstElementChild.cloneNode(true);
  Object.entries(option).forEach(([key, value]) => {
    const field = clone.querySelector(`[data-option-field="${key}"]`);
    if (field) field.value = value ?? '';
  });
  clone.querySelector('.admin-option-remove').addEventListener('click', () => clone.remove());
  $('#admin-options-list').appendChild(clone);
}

function openProductDialog(product = null) {
  state.editingProductId = product?.id || null;
  $('#admin-product-dialog-eyebrow').textContent = product ? 'Editar produto' : 'Novo produto';
  $('#admin-product-dialog-title').textContent = product ? product.name : 'Cadastrar produto';
  const form = $('#admin-product-form');
  form.reset();
  $('#admin-options-list').innerHTML = '';
  form.elements.namedItem('name').value = product?.name || '';
  form.elements.namedItem('category').value = product?.category || '';
  form.elements.namedItem('page').value = product?.page || '';
  form.elements.namedItem('summary').value = product?.summary || '';
  form.elements.namedItem('reference').value = product?.reference || '';
  (product?.options?.length ? product.options : [{}]).forEach(addOptionRow);
  setStatus('#admin-product-status', '');
  $('#admin-product-dialog').showModal();
}

function productRow(product) {
  const optionCount = (product.options || []).length;
  return `<article class="admin-list-row">
    <div class="admin-list-row-info">
      <strong>${text(product.name)}</strong>
      <span>${text(product.category || 'Sem categoria')} · ${optionCount} variação(ões)</span>
    </div>
    <div class="admin-list-row-actions">
      <button class="button button-secondary" data-product-edit="${text(product.id)}" type="button">Editar</button>
      <button class="button button-danger" data-product-delete="${text(product.id)}" type="button">Excluir</button>
    </div>
  </article>`;
}

async function loadProducts() {
  const list = $('#admin-products-list');
  list.innerHTML = '<p class="empty-state-inline">Carregando produtos...</p>';
  try {
    const result = await adminClient.listProducts();
    state.products = result.products;
    list.innerHTML = state.products.length
      ? state.products.map(productRow).join('')
      : '<p class="empty-state-inline">Nenhum produto cadastrado ainda.</p>';
    list.querySelectorAll('[data-product-edit]').forEach((button) => button.addEventListener('click', () => {
      openProductDialog(state.products.find((product) => product.id === button.dataset.productEdit));
    }));
    list.querySelectorAll('[data-product-delete]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('Excluir este produto? Pedidos antigos que o referenciam não são afetados.')) return;
      await adminClient.deleteProduct(button.dataset.productDelete);
      await loadProducts();
    }));
  } catch (error) {
    list.innerHTML = `<p class="empty-state-inline">${text(error.message || 'Não foi possível carregar os produtos.')}</p>`;
  }
}

function bindProductEvents() {
  $('#admin-product-new')?.addEventListener('click', () => openProductDialog());
  $('#admin-product-dialog-close')?.addEventListener('click', () => $('#admin-product-dialog').close());
  $('#admin-option-add')?.addEventListener('click', () => addOptionRow());
  $('#admin-product-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      name: form.elements.namedItem('name').value.trim(),
      category: form.elements.namedItem('category').value.trim(),
      page: form.elements.namedItem('page').value ? Number(form.elements.namedItem('page').value) : undefined,
      summary: form.elements.namedItem('summary').value.trim(),
      reference: form.elements.namedItem('reference').value.trim(),
      options: [...$('#admin-options-list').children].map(optionRowValues)
    };
    setStatus('#admin-product-status', 'Salvando...');
    try {
      if (state.editingProductId) await adminClient.updateProduct(state.editingProductId, payload);
      else await adminClient.createProduct(payload);
      $('#admin-product-dialog').close();
      await loadProducts();
    } catch (error) {
      setStatus('#admin-product-status', error.message || 'Não foi possível salvar o produto.');
    }
  });
}

// --- Bootstrap --------------------------------------------------------------

async function init() {
  await apiClient.init();
  const result = await apiClient.getMe().catch(() => ({ user: null }));
  state.me = result.user;
  if (!state.me) {
    setStatus('#admin-guard-status', 'Você precisa entrar com uma conta de administrador. Redirecionando...');
    setTimeout(() => { window.location.href = './index.html?page=account'; }, 800);
    return;
  }
  if (state.me.role !== 'admin') {
    setStatus('#admin-guard-status', 'Sua conta não tem acesso ao painel administrativo.');
    return;
  }
  setStatus('#admin-guard-status', '');
  $('#admin-app').hidden = false;
  $('#admin-logout').hidden = false;
  $('#admin-logout').addEventListener('click', async () => {
    await apiClient.logout();
    window.location.href = './index.html';
  });
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.adminTab)));
  bindProductEvents();
  switchTab('products');
}

init().catch((error) => {
  console.error('[napo3d-admin] init error', error);
  setStatus('#admin-guard-status', 'Não foi possível carregar o painel administrativo.');
});
```

- [ ] **Step 4: Manual verification**

Start the stack locally (`npm run dev` or `docker compose up --build`),
promote your local test account to admin directly in the dev database:

```bash
docker compose exec -T db psql -U napo3d -d napo3d_development \
  -c "UPDATE users SET role = 'admin' WHERE email = 'you@example.com';"

Before testing the page in Docker, make sure the new HTML file is actually
packaged into the frontend image. `Dockerfile.frontend` currently copies
only `index.html`, so add:

```dockerfile
COPY admin.html /usr/share/nginx/html/admin.html
```

next to the existing `COPY index.html ...` line; otherwise `/admin.html`
works in a loose local checkout but disappears in the built container and
production deploy.
```

Log in on `index.html?page=account` with that account, then open
`admin.html` directly. Confirm:
- A non-admin account (or logged-out) sees the guard message and gets
  redirected/blocked, never the panel.
- The Products tab lists every seeded product from Task 3.
- "Novo produto" opens the dialog, "Adicionar variação" adds a row,
  submitting creates the product and it appears in the list.
- "Editar" pre-fills the dialog with existing values including options.
- "Excluir" removes it from the list after confirmation.

- [ ] **Step 5: Commit**

```bash
git add admin.html css/admin.css js/admin.js
git commit -m "feat: add admin panel shell with auth gate, tabs, and products CRUD UI"
```

---

## Task 8: Orders panel (list, filter by status, detail, status update)

**Files:**
- Modify: `js/admin.js`

**Interfaces:**
- Consumes: `adminClient.listOrders/getOrder/updateOrderStatus` (Task 6),
  the `#admin-order-dialog` markup already created in Task 7.

- [ ] **Step 1: Add the Orders section to `js/admin.js`**

Find this exact boundary in `js/admin.js` (the end of
`bindProductEvents` from Task 7, right before the bootstrap comment):

```js
}

// --- Bootstrap --------------------------------------------------------------
```

Replace it with:

```js
}

// --- Orders -----------------------------------------------------------------

const ORDER_STATUS_LABELS = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  in_production: 'Em produção',
  shipped: 'Enviado',
  completed: 'Concluído',
  cancelled: 'Cancelado'
};

let editingOrderId = null;

function orderRow(order) {
  return `<article class="admin-list-row">
    <div class="admin-list-row-info">
      <strong>Pedido ${text(order.id)}</strong>
      <span>${text(order.customerName)} · ${new Date(order.createdAt).toLocaleString('pt-BR')}</span>
      <span>${ORDER_STATUS_LABELS[order.status] || order.status} · ${money(order.total)}</span>
    </div>
    <div class="admin-list-row-actions">
      <button class="button button-secondary" data-order-detail="${text(order.id)}" type="button">Ver detalhe</button>
    </div>
  </article>`;
}

function openOrderDialog(order) {
  editingOrderId = order.id;
  $('#admin-order-dialog-title').textContent = `Pedido ${order.id}`;
  $('#admin-order-detail').innerHTML = `
    <div class="info-card"><strong>Cliente</strong><span>${text(order.customerName)} · ${text(order.customerEmail)}</span><span>${text(order.customerPhone || 'Telefone não informado')}</span></div>
    <div class="info-card"><strong>Endereço de entrega</strong><span>${text(order.addressSnapshot?.street || '')}, ${text(order.addressSnapshot?.number || '')}</span><span>${text(order.addressSnapshot?.city || '')}/${text(order.addressSnapshot?.state || '')} · CEP ${text(order.addressSnapshot?.postalCode || '')}</span></div>
    ${order.items.map((item) => `<div class="info-card"><strong>${text(item.productNameSnapshot)} — ${text(item.optionName)}</strong><span>${item.quantity} un. · ${item.unitWeightGrams} g · ${money(item.unitPrice)} por peça</span><span>Total da linha: ${money(item.lineTotal)}</span></div>`).join('')}
    <div class="info-card"><strong>Total do pedido</strong><span>Subtotal ${money(order.subtotal)} · Frete ${money(order.shipping)} · Total ${money(order.total)}</span>${order.notes ? `<span>Observações: ${text(order.notes)}</span>` : ''}</div>
  `;
  $('#admin-order-status-select').value = order.status;
  setStatus('#admin-order-status-message', '');
  $('#admin-order-dialog').showModal();
}

async function loadOrders() {
  const list = $('#admin-orders-list');
  list.innerHTML = '<p class="empty-state-inline">Carregando pedidos...</p>';
  try {
    const status = $('#admin-orders-filter').value;
    const result = await adminClient.listOrders(status ? { status } : {});
    list.innerHTML = result.orders.length
      ? result.orders.map(orderRow).join('')
      : '<p class="empty-state-inline">Nenhum pedido encontrado.</p>';
    list.querySelectorAll('[data-order-detail]').forEach((button) => button.addEventListener('click', async () => {
      const detail = await adminClient.getOrder(button.dataset.orderDetail);
      openOrderDialog(detail.order);
    }));
  } catch (error) {
    list.innerHTML = `<p class="empty-state-inline">${text(error.message || 'Não foi possível carregar os pedidos.')}</p>`;
  }
}

function bindOrderEvents() {
  $('#admin-orders-filter')?.addEventListener('change', () => loadOrders());
  $('#admin-order-dialog-close')?.addEventListener('click', () => $('#admin-order-dialog').close());
  $('#admin-order-status-save')?.addEventListener('click', async () => {
    if (!editingOrderId) return;
    setStatus('#admin-order-status-message', 'Salvando...');
    try {
      await adminClient.updateOrderStatus(editingOrderId, $('#admin-order-status-select').value);
      setStatus('#admin-order-status-message', 'Status atualizado.');
      await loadOrders();
    } catch (error) {
      setStatus('#admin-order-status-message', error.message || 'Não foi possível atualizar o status.');
    }
  });
}

// --- Bootstrap --------------------------------------------------------------
```

- [ ] **Step 2: Wire it into `init()`**

Find in `js/admin.js`:

```js
  bindProductEvents();
  switchTab('products');
```

Replace with:

```js
  bindProductEvents();
  bindOrderEvents();
  switchTab('products');
```

- [ ] **Step 3: Manual verification**

With the same admin session from Task 7, place a test order from the
storefront as a regular customer (a second browser profile or incognito
window logged in as a non-admin customer), then in the admin panel:
- Open the Orders tab — the order appears with the right customer name
  and total.
- Filter by status — narrows the list correctly.
- Click "Ver detalhe" — dialog shows items, address, totals.
- Change the status and save — the list re-renders with the new status,
  and (per Task 4's test) the customer's own `GET /api/me/orders/:id`
  reflects it too.

- [ ] **Step 4: Commit**

```bash
git add js/admin.js
git commit -m "feat: add admin orders panel (list, filter, detail, status update)"
```

---

## Task 9: Users panel (list, search, detail with addresses/orders, role update, delete)

**Files:**
- Modify: `js/admin.js`

**Interfaces:**
- Consumes: `adminClient.listUsers/getUser/updateUser/deleteUser`
  (Task 6), the `#admin-user-dialog` markup already created in Task 7.

- [ ] **Step 1: Add the Users section to `js/admin.js`**

Find this exact boundary (the end of `bindOrderEvents` from Task 8,
right before the bootstrap comment):

```js
}

// --- Bootstrap --------------------------------------------------------------
```

Replace it with:

```js
}

// --- Users ------------------------------------------------------------------

let editingUserId = null;

function userRow(user) {
  return `<article class="admin-list-row">
    <div class="admin-list-row-info">
      <strong>${text(user.name)}</strong>
      <span>${text(user.email)}</span>
      <span class="inline-badge${user.role === 'admin' ? ' role-admin' : ''}">${user.role === 'admin' ? 'Administrador' : 'Cliente'}</span>
    </div>
    <div class="admin-list-row-actions">
      <button class="button button-secondary" data-user-detail="${text(user.id)}" type="button">Ver detalhe</button>
    </div>
  </article>`;
}

function addressSummary(address) {
  return `<div class="info-card"><strong>${text(address.recipientName)}</strong><span>${text(address.street)}, ${text(address.number)}${address.complement ? ` — ${text(address.complement)}` : ''}</span><span>${text(address.city)}/${text(address.state)} · CEP ${text(address.postalCode)}</span>${address.isDefault ? '<span>Endereço padrão</span>' : ''}</div>`;
}

function orderSummary(order) {
  return `<div class="info-card"><strong>Pedido ${text(order.id)}</strong><span>${ORDER_STATUS_LABELS[order.status] || order.status} · ${money(order.total)}</span><span>${new Date(order.createdAt).toLocaleString('pt-BR')}</span></div>`;
}

async function openUserDialog(userId) {
  const detail = await adminClient.getUser(userId);
  editingUserId = detail.user.id;
  $('#admin-user-dialog-title').textContent = detail.user.name;
  $('#admin-user-profile').innerHTML = `<div class="info-card"><strong>${text(detail.user.email)}</strong><span>Cadastrado em ${new Date(detail.user.createdAt).toLocaleDateString('pt-BR')}</span></div>`;
  $('#admin-user-name').value = detail.user.name;
  $('#admin-user-phone').value = detail.user.phone || '';
  $('#admin-user-role').value = detail.user.role;
  $('#admin-user-role').disabled = detail.user.id === state.me.id;
  $('#admin-user-addresses').innerHTML = detail.addresses.length
    ? detail.addresses.map(addressSummary).join('')
    : '<p class="empty-state-inline">Nenhum endereço salvo.</p>';
  $('#admin-user-orders').innerHTML = detail.orders.length
    ? detail.orders.map(orderSummary).join('')
    : '<p class="empty-state-inline">Nenhum pedido ainda.</p>';
  $('#admin-user-delete').hidden = detail.user.id === state.me.id;
  setStatus('#admin-user-status', '');
  $('#admin-user-dialog').showModal();
}

async function loadUsers() {
  const list = $('#admin-users-list');
  list.innerHTML = '<p class="empty-state-inline">Carregando usuários...</p>';
  try {
    const query = $('#admin-users-search').value.trim();
    const result = await adminClient.listUsers(query ? { query } : {});
    list.innerHTML = result.users.length
      ? result.users.map(userRow).join('')
      : '<p class="empty-state-inline">Nenhum usuário encontrado.</p>';
    list.querySelectorAll('[data-user-detail]').forEach((button) => button.addEventListener('click', () => openUserDialog(button.dataset.userDetail)));
  } catch (error) {
    list.innerHTML = `<p class="empty-state-inline">${text(error.message || 'Não foi possível carregar os usuários.')}</p>`;
  }
}

function bindUserEvents() {
  let searchTimer = null;
  $('#admin-users-search')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadUsers(), 300);
  });
  $('#admin-user-dialog-close')?.addEventListener('click', () => $('#admin-user-dialog').close());
  $('#admin-user-save')?.addEventListener('click', async () => {
    if (!editingUserId) return;
    setStatus('#admin-user-status', 'Salvando...');
    try {
      await adminClient.updateUser(editingUserId, {
        name: $('#admin-user-name').value.trim(),
        phone: $('#admin-user-phone').value.trim(),
        role: $('#admin-user-role').disabled ? undefined : $('#admin-user-role').value
      });
      setStatus('#admin-user-status', 'Usuário atualizado.');
      await loadUsers();
    } catch (error) {
      setStatus('#admin-user-status', error.message || 'Não foi possível salvar as alterações.');
    }
  });
  $('#admin-user-delete')?.addEventListener('click', async () => {
    if (!editingUserId || !confirm('Excluir este usuário? Endereços e sessões dele são removidos; pedidos são mantidos sem o vínculo com a conta.')) return;
    try {
      await adminClient.deleteUser(editingUserId);
      $('#admin-user-dialog').close();
      await loadUsers();
    } catch (error) {
      setStatus('#admin-user-status', error.message || 'Não foi possível excluir este usuário.');
    }
  });
}

// --- Bootstrap --------------------------------------------------------------
```

- [ ] **Step 2: Wire it into `init()`**

Find in `js/admin.js`:

```js
  bindProductEvents();
  bindOrderEvents();
  switchTab('products');
```

Replace with:

```js
  bindProductEvents();
  bindOrderEvents();
  bindUserEvents();
  switchTab('products');
```

- [ ] **Step 3: Manual verification**

- Open the Users tab — every registered account appears with its role
  badge; the currently logged-in admin's own row, when opened, has the
  role `<select>` disabled (matches the server-side
  `CANNOT_CHANGE_OWN_ROLE` guard from Task 5) and no delete button.
- Search narrows the list by name/email.
- Open a different user, promote them to `admin`, save — their badge
  updates on the list.
- Open a user with a saved address and a placed order — both show up
  under "Endereços" and "Pedidos" in the dialog.
- Delete a user — they disappear from the list; if they had an order,
  confirm (via the Orders tab) that the order is still there.

- [ ] **Step 4: Commit**

```bash
git add js/admin.js
git commit -m "feat: add admin users panel (list, search, detail, role update, delete)"
```

---

## Task 10: Show an "Admin" link in the storefront header for admins only

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`

**Interfaces:** none new — this only reads `state.me.role`, already
produced by Task 1's `sanitizeUser` change and already available on the
front-end via the existing `GET /api/me` call in `refreshSession()`.

This is a convenience link only, not a security boundary — the real
enforcement is server-side (`requireAdmin`, Task 1) and client-side in
`admin.html` itself (the auth-gate in `js/admin.js`, Task 7). A customer
who guesses `/admin.html` still gets blocked by both of those; this task
just avoids showing a dead-end link to people who can't use it.

- [ ] **Step 1: Add the link markup**

In `index.html`, find the header nav:

```html
      <nav aria-label="Navegação principal">
        <a href="#catalogo">Catálogo</a>
        <a href="#como-funciona">Como funciona</a>
        <button class="nav-account" id="account-open" type="button">Minha conta</button>
        <button class="nav-cart" id="cart-open" type="button" aria-label="Abrir carrinho">Carrinho <span
            id="cart-count-top">0</span></button>
      </nav>
```

Replace with:

```html
      <nav aria-label="Navegação principal">
        <a href="#catalogo">Catálogo</a>
        <a href="#como-funciona">Como funciona</a>
        <a href="./admin.html" id="admin-nav-link" hidden>Admin</a>
        <button class="nav-account" id="account-open" type="button">Minha conta</button>
        <button class="nav-cart" id="cart-open" type="button" aria-label="Abrir carrinho">Carrinho <span
            id="cart-count-top">0</span></button>
      </nav>
```

- [ ] **Step 2: Toggle it whenever the logged-in user changes**

In `js/app.js`, add a small render function near `renderCategories`:

```js
function renderAdminNavLink() {
  const link = $('#admin-nav-link');
  if (link) link.hidden = state.me?.role !== 'admin';
}
```

Call it once at boot — find in `init()`:

```js
  await Promise.all([loadProducts(), refreshSession()]);
  if (state.me) await loadUserData();
```

Replace with:

```js
  await Promise.all([loadProducts(), refreshSession()]);
  renderAdminNavLink();
  if (state.me) await loadUserData();
```

Call it again after login/register — find in the `#account-page-form`
submit handler:

```js
      const result = state.authMode === 'register' ? await apiClient.register(payload) : await apiClient.login(payload);
      state.me = result.user;
      await loadUserData();
      renderAccountPage();
```

Replace with:

```js
      const result = state.authMode === 'register' ? await apiClient.register(payload) : await apiClient.login(payload);
      state.me = result.user;
      renderAdminNavLink();
      await loadUserData();
      renderAccountPage();
```

And after logout — find in the `#account-logout` click handler (inside
`renderAccountPage`):

```js
    $('#account-logout').onclick = async () => {
      await apiClient.logout();
      state.me = null;
      state.addresses = [];
      state.orders = [];
      state.selectedAddressId = null;
      state.quote = null;
      renderAccountPage();
      setStatus('#account-page-status', 'Sessão encerrada.');
    };
```

Replace with:

```js
    $('#account-logout').onclick = async () => {
      await apiClient.logout();
      state.me = null;
      state.addresses = [];
      state.orders = [];
      state.selectedAddressId = null;
      state.quote = null;
      renderAdminNavLink();
      renderAccountPage();
      setStatus('#account-page-status', 'Sessão encerrada.');
    };
```

- [ ] **Step 3: Manual verification**

As a logged-out visitor and as a logged-in `customer`, confirm the
"Admin" link never appears anywhere on the storefront (catalog, cart,
account, shipping pages). Log in as your promoted `admin` account and
confirm it appears in the header immediately, without a page reload, and
that clicking it opens the working admin panel from Task 7–9. Log out
and confirm it disappears again immediately.

- [ ] **Step 4: Commit**

```bash
git add index.html js/app.js
git commit -m "feat: show an Admin link in the storefront header for admin accounts"
```

---

## Task 11: Final acceptance walkthrough on production

This plan's backend/front-end tasks are safe to implement and commit
autonomously (Tasks 1–10), but **do not merge this to `main` without
reading this task first** — merging triggers the existing GitHub Actions
workflow, which deploys to `https://napo3d.shop` / `https://napo3d.store`
automatically (see `docs/engineering/deploy_aws_lightsail.md`). Treat
the push itself as the risky step, and this task as mandatory afterward,
not optional.

- [ ] **Step 1: Before merging — run the full local suite one more time**

```bash
node --test
```

Expected: every test from Tasks 1–5 (and every pre-existing test) passes,
zero failures.

- [ ] **Step 2: Merge to `main` and watch the deploy**

```bash
git push origin main
gh run watch --repo penapono/napo3d --exit-status
```

Expected: the "Deploy production" run succeeds. If it fails, do not
retry blindly — read the job log (`gh run view --log-failed`) first;
the most likely cause at this stage is a database migration issue (Task
2/Task 5's `ALTER TABLE` statements) failing against the real, larger
production database in a way the in-memory tests couldn't catch.

- [ ] **Step 3: Confirm the storefront catalog is still visible**

```bash
curl -s "https://napo3d.shop/api/products?limit=200" -o /tmp/napo3d_catalog_check.json
node -e "const j=require('/tmp/napo3d_catalog_check.json'); console.log('items:', j.items.length); console.log(j.items.map(i=>i.name).join(' | '))"
rm -f /tmp/napo3d_catalog_check.json
```

Expected: **12 items**, the same names as before this plan (`Escultura
Logo`, `Organizador de Mesa`, `Porta Cartões`, `Escultura Motor`,
`Suporte de Celular`, `Caixa Premium`, `Carrinho de Bordo`, `Miniatura
Boeing 737`, `Porta-copos`, `Chaveiro Redondo`, `Chaveiro NFC`, `Objeto
Antiansiedade`) — this is the proof that Task 2/3's migration from
`data/models.json` into Postgres preserved every existing product,
seeded correctly against the real database, and that `loadCatalog` is
reading from the new `products` table successfully in production.

Also open `https://napo3d.shop/` and `https://napo3d.store/` in an
actual browser and confirm the catalog grid renders and "Minha conta" /
"Carrinho" still work (regression check for the unrelated bug fixed
earlier in this plan — this is the same button-dead symptom class, so
it's worth re-confirming after a deploy that touches `Dockerfile.api`,
`server/*`, and now also ships new front-end files).

- [ ] **Step 4: Place one real order end-to-end against production**

```bash
REG=$(curl -s -X POST https://napo3d.shop/api/auth/register -H 'Content-Type: application/json' -H 'Origin: https://napo3d.shop' -d '{"name":"Plan Acceptance Check","email":"plan-acceptance-check@example.com","password":"12345678"}')
TOKEN=$(echo "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).accessToken))")

ADDR=$(curl -s -X POST https://napo3d.shop/api/me/addresses -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Origin: https://napo3d.shop' -d '{"recipientName":"Plan Acceptance","postalCode":"13010111","street":"Rua A","number":"1","city":"Campinas","state":"SP"}')
ADDR_ID=$(echo "$ADDR" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).address.id))")

ORDER=$(curl -s -X POST https://napo3d.shop/api/orders -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Origin: https://napo3d.shop' -H 'Idempotency-Key: plan-acceptance-check-1' -d '{"items":[{"productId":"p3-logo","optionName":"Custom Badge","quantity":5}],"addressId":"'"$ADDR_ID"'","customer":{"name":"Plan Acceptance","email":"plan-acceptance-check@example.com"}}')
echo "$ORDER"
```

Expected: `201`-shaped JSON with a real `order.id`, `status: "pending"`,
correct `unitPrice`/`total` computed server-side from the seeded
product's real weight — proof that checkout still works end-to-end
against the migrated, Postgres-backed catalog (Task 2/3 didn't just move
the *read* path, `buildQuote` in `shared/contract.js` needs the exact
same shape back out of the database that it used to get from the JSON
file).

- [ ] **Step 5: Exercise the admin panel itself against production**

Using your own already-promoted admin account (bootstrapped in Task 1
Step 7):
- Log in at `https://napo3d.shop/index.html?page=account`, confirm the
  "Admin" link appears (Task 10), open it.
- Products tab: edit the product created in Step 4's test order (or any
  seeded one) — change its name, save, then re-run the `curl
  .../api/products` check from Step 3 and confirm the new name shows up
  publicly within 5 seconds (the `loadCatalog` cache TTL).
- Orders tab: find the order created in Step 4, open its detail, change
  its status to `confirmed`, save. Confirm via `curl -s
  https://napo3d.shop/api/me/orders/<id> -H "Authorization: Bearer
  $TOKEN"` (reusing the token from Step 4) that the customer-facing view
  now shows `"status":"confirmed"`.
- Users tab: find `plan-acceptance-check@example.com`, confirm their
  address from Step 4 appears under "Endereços" and their order appears
  under "Pedidos", then delete the user.

- [ ] **Step 6: Clean up every test artifact from production**

```bash
ssh ubuntu@corus.app.br "docker exec corus-production-db-1 psql -U napo3d -d napo3d_production \
  -c \"delete from users where email in ('plan-acceptance-check@example.com');\" \
  -c 'select count(*) from users;' -c 'select count(*) from orders;'"
```

If Step 5's Users-tab deletion already removed
`plan-acceptance-check@example.com`, this command simply deletes 0 rows
— harmless either way. Also delete any test product created purely for
Step 5's edit check, via the admin panel's own "Excluir" button, so the
public catalog only ever shows real inventory again.

If every step above passes, this plan is fully accepted: the admin panel
works end-to-end against real production, the catalog migration didn't
lose or corrupt any data, and the unrelated dead-buttons bug found while
starting this work is confirmed fixed and not regressed by this plan's
own deploy.
