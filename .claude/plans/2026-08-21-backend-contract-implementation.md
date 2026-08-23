# napo3d Backend Contract — Gap-Closing & Production Deploy Implementation Plan

> **For agentic workers:** This plan is written for an external coding agent
> (Codex) to execute directly, task by task, in order. Tasks 1–6 are pure
> repo changes (code, tests, docs, CI config) and are safe to execute
> autonomously. Tasks 7–10 are an **operational runbook** that requires SSH
> access to the production host, GitHub repository admin settings, DNS
> registrar access, and a Resend account — do **not** attempt these without
> a human operator present with those credentials, and confirm each
> destructive/irreversible step (DNS changes, certificate issuance, first
> production `up`) before running it. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Close the remaining gaps between `BACKEND_CONTRACT.md` and the
already-substantial `napo3d` implementation (Node/Postgres API, Docker
Compose, deploy docs already exist), then deploy the finished store to the
same AWS EC2 host that already runs Corus, under its own domain, database,
and containers.

**Architecture:** Nothing changes structurally. `napo3d` keeps its own
isolated `db` + `api` + `front` Docker Compose stack, its own Postgres
instance (not shared with Corus), and its own Nginx server block on the
shared host — it only shares the physical machine, Nginx, Docker Engine,
and Certbot with Corus, exactly as `docs/engineering/deploy_aws_lightsail.md`
already documents. The main functional gap is that orders are persisted
correctly but no e-mail is ever actually sent — this plan adds that, adds
missing authorization test coverage, replaces the stale GitHub Pages
workflow with a real production auto-deploy workflow, and executes the
existing (now-updated) deploy runbook against the real domain.

**Tech Stack:** Node.js 22 (native `http`, no framework), PostgreSQL 16,
`pg` driver, Docker Compose, Nginx + Certbot on the host, Resend for
transactional e-mail, GitHub Actions for CI/CD, Node's built-in test
runner (`node --test`).

**Spec:** `BACKEND_CONTRACT.md` (repo root). Executors should keep it open
alongside this plan — this plan only documents the *delta* between the spec
and the current code, not the whole system.

**Decisions already made for this plan (do not re-litigate these):**
- Password hashing stays on Node's built-in `scrypt` (already implemented
  in `server/index.js`) instead of switching to bcrypt/Argon2id. It is a
  NIST/OWASP-approved KDF and this avoids adding a native or WASM
  dependency for no functional gain.
- E-mail provider is **Resend** (simple HTTPS API, Node 22's global
  `fetch` is enough — no SDK dependency needed).
- Production deploys become **automatic on push to `main`** via a new
  GitHub Actions workflow (matching the Corus repos' convention), replacing
  today's manual-SSH-only flow.
- The existing GitHub Pages workflow (`.github/workflows/static.yml`) is
  **removed** — a mock-mode static copy of the storefront living at a
  `*.github.io` URL once the real store is live would be confusing and
  could be indexed by search engines as if it were the real store.
- Public domain: **`napo3d.shop`** / **`www.napo3d.shop`**, pointed at the
  same public IP the Corus host already uses.
- GitHub repo: `penapono/napo3d` (confirmed via `git remote -v`).

## Global Constraints

- Price tiers (already implemented in `shared/contract.js`, do not change):
  1–50 units → `peso_em_gramas * 375 / 1000`; 51–100 → `* 325 / 1000`;
  101+ → `* 275 / 1000`; rounded to the nearest integer, no cents.
- Never trust client-sent `total`, `unitPrice`, `weight`, or `role` —
  the server already recomputes everything via `buildQuote`; new code must
  preserve this.
- Passwords: minimum 8 characters (already enforced).
- `Idempotency-Key` on `POST /api/orders` must keep preventing duplicate
  orders (already implemented — do not regress the existing tests).
- All new secrets (Resend API key, DB password) live only in
  `.env.production` on the host (`chmod 600`) or GitHub Actions secrets —
  never in frontend JS, never committed to git.
- CORS stays restricted to the store's own origins (already implemented via
  `CORS_ORIGINS` env var).
- Sanitize any customer-controlled text before it is interpolated into an
  e-mail body (contract: "Sanitizar texto antes do e-mail e do painel").
- Backups: PostgreSQL must be backed up daily (contract requirement, not
  yet automated — Task 6 closes this).

---

## Current-state summary (read this before touching anything)

`napo3d` is **not a green-field backend**. `server/index.js` (plain
`node:http`, no framework) already implements: register/login/logout,
`GET /api/me`, full address CRUD + default-address selection, catalog
listing/filtering/pagination, `GET /api/products/:id`, order quoting
(`POST /api/orders/quote`), order creation with server-side price
recalculation, address snapshotting, `Idempotency-Key` handling, and
per-route rate limiting. `server/store.js` implements both a
`createPostgresStore` (real schema, transactional read/update/write) and a
`createMemoryStore` (used by all tests). `shared/contract.js` holds the
pricing/quote/validation logic shared by client and server.
`js/api-client.js` already auto-detects a live API via `/api/health` and
transparently falls back to `js/mock-backend.js` (`localStorage`-backed) —
**no frontend JS changes are required by this plan**; the migration
described in `BACKEND_CONTRACT.md`'s "Migração do front-end" section is
already done in code.

Remaining gaps closed by this plan:

1. Orders queue two rows into an `emails` table but **nothing ever sends
   them** — no provider integration exists. (Task 1)
2. The internal order recipient e-mail is hardcoded in
   `server/index.js` instead of coming from `ORDER_RECIPIENT`. (Task 1)
3. No test asserts that a user cannot read/modify another user's addresses
   or orders, and no test covers default-address selection, catalog
   filtering, or rate limiting. (Task 2)
4. `.github/workflows/static.yml` still auto-publishes the raw repo to
   GitHub Pages, which will run in mock mode forever and contradicts the
   goal of one real, backend-connected store. (Task 3)
5. There is no CI/CD workflow to production — only a manual, human-run
   `script/deploy_production`. (Task 4)
6. `docs/engineering/deploy_aws_lightsail.md` uses a placeholder domain
   and doesn't mention the new e-mail env vars or backup automation.
   (Task 5)
7. PostgreSQL has no automated daily backup, only a manual `pg_dump`
   one-liner in the docs. (Task 6)
8. The host has never actually been provisioned for `napo3d` — directories,
   deploy key, `.env.production`, first `docker compose up`, Nginx vhost,
   DNS, and TLS certificate all still need to happen for real. (Tasks 7–9)
9. `Dockerfile.api` has no `USER` directive, so the API runs as `root`
   inside its container — every other service already on this host
   (`corus-back`, `corus-front`, `corus-tracker`, `corus-tracker-mcp`)
   runs as a dedicated non-root user instead, confirmed directly against
   their Dockerfiles. (Task 2B)

**Feasibility check performed against the real Corus infrastructure**
(not just its docs): the GitHub Actions workflow in Task 4 below was
rewritten to match `corus-back/.github/workflows/deploy-production.yml`
and `corus-back/script/deploy_production` byte-for-byte in structure
(verified by reading those actual files, which are checked out locally at
`/Users/pnaponoceno/projects/corus/corus-back/`) — not just this plan's
best guess at the pattern. Port `3500`/`3501` was confirmed free against
`corus-shared-knowledge/docs/engineering/infra/02-port-registry.md`
(highest allocated today is `3400`, for `corus-front`). The `location
/api/` Nginx routing in Task 8 was checked against Corus's own
2026-07-31 incident (a generic `location /api` swallowed a frontend's own
`/api/*` routes meant for a different backend) — that incident doesn't
apply to `napo3d` because there is no separate frontend BFF layer here:
every `/api/*` route the browser calls is meant for the one `napo3d` API
container, so routing all of `/api/` there is correct as written. The
`www.` alias gotcha from that same incident (a missing `www.` in
`server_name` silently falling through to the wrong `server{}` block) is
already avoided in Task 8's Nginx block, which lists both `napo3d.shop`
and `www.napo3d.shop` in `server_name` from the start.

---

## Task 1: Real e-mail delivery via Resend

**Files:**
- Create: `server/mailer.js`
- Modify: `server/store.js` (emails table schema + read/write mapping)
- Modify: `server/index.js` (wire mailer into order creation + background
  retry loop, replace hardcoded recipient)
- Modify: `compose.yml`, `compose.production.yml` (new env vars on `api`)
- Modify: `.env.production.example` (new vars)
- Test: `test/mailer.test.js`

**Interfaces:**
- Produces (used by `server/index.js` in this task, and by nothing else
  in this plan): `resolveMailerConfig(env?) -> { provider, apiKey, from,
  orderRecipient, configured }`, `buildEmailContent(type, order) ->
  { subject, html, text }`, `processPendingEmails(store, options?) ->
  Promise<{ sent: number, skipped: boolean }>`, `escapeHtml(value) ->
  string`.
- Consumes: `store.read()` / `store.update(mutator)` from `server/store.js`
  (existing interface, unchanged shape — `store.read()` returns
  `{ users, sessions, addresses, orders, idempotencyKeys, emails }`).

- [ ] **Step 1: Write the failing tests**

Create `test/mailer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store.js';
import {
  buildInternalOrderEmail,
  buildCustomerConfirmationEmail,
  escapeHtml,
  processPendingEmails
} from '../server/mailer.js';

function sampleOrder(overrides = {}) {
  return {
    id: 'order-1',
    customerName: 'Ana <script>alert(1)</script>',
    customerEmail: 'ana@example.com',
    customerPhone: '11999999999',
    addressSnapshot: {
      recipientName: 'Ana',
      street: 'Rua A',
      number: '10',
      city: 'Campinas',
      state: 'SP',
      postalCode: '13010111'
    },
    items: [
      { productNameSnapshot: 'Produto', optionName: 'Laranja', unitWeightGrams: 40, quantity: 10, unitPrice: 15, lineTotal: 150 }
    ],
    subtotal: 150,
    shipping: 0,
    total: 150,
    productionEstimateHours: 1,
    notes: '',
    ...overrides
  };
}

test('escapeHtml neutralizes HTML special characters', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

test('buildInternalOrderEmail escapes customer-controlled text', () => {
  const email = buildInternalOrderEmail(sampleOrder());
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
});

test('buildCustomerConfirmationEmail includes order id and total', () => {
  const email = buildCustomerConfirmationEmail(sampleOrder());
  assert.match(email.subject, /order-1/);
  assert.match(email.html, /R\$\s*150/);
});

test('processPendingEmails skips sending when the mailer is not configured', async () => {
  const store = createMemoryStore();
  await store.update((next) => {
    next.orders.push(sampleOrder());
    next.emails.push({ id: 'email-1', type: 'customer_confirmation', to: 'ana@example.com', orderId: 'order-1', createdAt: new Date(0).toISOString() });
    return next;
  });

  const result = await processPendingEmails(store, { config: { configured: false } });
  assert.equal(result.skipped, true);

  const after = await store.read();
  assert.equal(after.emails[0].sentAt, undefined);
});

test('processPendingEmails sends pending emails and marks them sent', async () => {
  const store = createMemoryStore();
  await store.update((next) => {
    next.orders.push(sampleOrder());
    next.emails.push(
      { id: 'email-1', type: 'customer_confirmation', to: 'ana@example.com', orderId: 'order-1', createdAt: new Date(0).toISOString() },
      { id: 'email-2', type: 'internal_order', to: 'owner@example.com', orderId: 'order-1', createdAt: new Date(0).toISOString() }
    );
    return next;
  });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, text: async () => '' };
  };

  const config = { configured: true, apiKey: 'test-key', from: 'pedidos@napo3d.shop', orderRecipient: 'owner@example.com' };
  const result = await processPendingEmails(store, { config, fetchImpl });

  assert.equal(result.sent, 2);
  assert.equal(calls.length, 2);

  const after = await store.read();
  assert.ok(after.emails.every((email) => email.sentAt));
});

test('processPendingEmails records the error and keeps the email pending on failure', async () => {
  const store = createMemoryStore();
  await store.update((next) => {
    next.orders.push(sampleOrder());
    next.emails.push({ id: 'email-1', type: 'customer_confirmation', to: 'ana@example.com', orderId: 'order-1', createdAt: new Date(0).toISOString() });
    return next;
  });

  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const config = { configured: true, apiKey: 'test-key', from: 'pedidos@napo3d.shop', orderRecipient: 'owner@example.com' };
  const result = await processPendingEmails(store, { config, fetchImpl });

  assert.equal(result.sent, 0);
  const after = await store.read();
  assert.equal(after.emails[0].sentAt, undefined);
  assert.equal(after.emails[0].attempts, 1);
  assert.match(after.emails[0].lastError, /500/);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/mailer.test.js`
Expected: FAIL — `Cannot find module '../server/mailer.js'`

- [ ] **Step 3: Implement `server/mailer.js`**

```js
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveMailerConfig(env = process.env) {
  const provider = String(env.EMAIL_PROVIDER || 'resend').trim();
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.FROM_EMAIL || '').trim();
  const orderRecipient = String(env.ORDER_RECIPIENT || 'pedro.gnaponoceno@gmail.com').trim();
  return {
    provider,
    apiKey,
    from,
    orderRecipient,
    configured: provider === 'resend' && Boolean(apiKey) && Boolean(from)
  };
}

function formatCurrency(value) {
  return `R$ ${Number(value || 0).toLocaleString('pt-BR')}`;
}

function renderItemsRows(items) {
  return (items || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.productNameSnapshot)} — ${escapeHtml(item.optionName)}</td>
      <td style="text-align:right">${Number(item.quantity)}</td>
      <td style="text-align:right">${Number(item.unitWeightGrams)} g</td>
      <td style="text-align:right">${formatCurrency(item.unitPrice)}</td>
      <td style="text-align:right">${formatCurrency(item.lineTotal)}</td>
    </tr>`).join('');
}

function renderAddressBlock(address = {}) {
  const line2 = [address.complement, address.neighborhood].filter(Boolean).map(escapeHtml).join(' — ');
  return [
    escapeHtml(address.recipientName),
    `${escapeHtml(address.street)}, ${escapeHtml(address.number)}`,
    line2,
    `${escapeHtml(address.city)} - ${escapeHtml(address.state)}`,
    `CEP ${escapeHtml(address.postalCode)}`,
    address.reference ? `Referência: ${escapeHtml(address.reference)}` : ''
  ].filter(Boolean).join('<br>');
}

export function buildInternalOrderEmail(order) {
  const subject = `Novo pedido #${order.id} — ${order.customerName}`;
  const html = `
    <h1>Novo pedido recebido</h1>
    <p><strong>Pedido:</strong> ${escapeHtml(order.id)}</p>
    <p><strong>Cliente:</strong> ${escapeHtml(order.customerName)} (${escapeHtml(order.customerEmail)})</p>
    <p><strong>Telefone:</strong> ${escapeHtml(order.customerPhone || 'não informado')}</p>
    <p><strong>Endereço de entrega:</strong><br>${renderAddressBlock(order.addressSnapshot)}</p>
    <table cellpadding="6" cellspacing="0" border="1">
      <thead><tr><th>Item</th><th>Qtd.</th><th>Peso</th><th>Preço unit.</th><th>Total</th></tr></thead>
      <tbody>${renderItemsRows(order.items)}</tbody>
    </table>
    <p><strong>Subtotal:</strong> ${formatCurrency(order.subtotal)}</p>
    <p><strong>Frete:</strong> ${formatCurrency(order.shipping)}</p>
    <p><strong>Total:</strong> ${formatCurrency(order.total)}</p>
    <p><strong>Estimativa de produção:</strong> ${order.productionEstimateHours}h</p>
    ${order.notes ? `<p><strong>Observações:</strong> ${escapeHtml(order.notes)}</p>` : ''}
  `;
  const text = `Novo pedido ${order.id} de ${order.customerName} (${order.customerEmail}). Total: ${formatCurrency(order.total)}.`;
  return { subject, html, text };
}

export function buildCustomerConfirmationEmail(order) {
  const subject = `Recebemos seu pedido #${order.id}`;
  const html = `
    <h1>Pedido confirmado</h1>
    <p>Olá, ${escapeHtml(order.customerName)}! Recebemos seu pedido <strong>${escapeHtml(order.id)}</strong>.</p>
    <table cellpadding="6" cellspacing="0" border="1">
      <thead><tr><th>Item</th><th>Qtd.</th><th>Peso</th><th>Preço unit.</th><th>Total</th></tr></thead>
      <tbody>${renderItemsRows(order.items)}</tbody>
    </table>
    <p><strong>Total:</strong> ${formatCurrency(order.total)}</p>
    <p>Assim que a produção avançar, atualizaremos você por e-mail.</p>
  `;
  const text = `Recebemos seu pedido ${order.id}. Total: ${formatCurrency(order.total)}.`;
  return { subject, html, text };
}

export function buildEmailContent(type, order) {
  if (type === 'internal_order') return buildInternalOrderEmail(order);
  if (type === 'customer_confirmation') return buildCustomerConfirmationEmail(order);
  throw new Error(`Tipo de e-mail desconhecido: ${type}`);
}

async function sendViaResend({ to, from, subject, html, text }, apiKey, fetchImpl) {
  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html, text })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend respondeu ${response.status}: ${body.slice(0, 200)}`);
  }
}

export async function processPendingEmails(store, options = {}) {
  const config = options.config || resolveMailerConfig();
  const fetchImpl = options.fetchImpl || fetch;
  if (!config.configured) return { sent: 0, skipped: true };

  const currentStore = await store.read();
  const pending = currentStore.emails.filter((email) => !email.sentAt);
  let sent = 0;

  for (const email of pending) {
    const order = currentStore.orders.find((entry) => entry.id === email.orderId);
    if (!order) continue;
    const to = email.type === 'internal_order' ? config.orderRecipient : email.to;
    try {
      const content = buildEmailContent(email.type, order);
      await sendViaResend({ to, from: config.from, ...content }, config.apiKey, fetchImpl);
      await store.update((next) => {
        next.emails = next.emails.map((entry) => entry.id === email.id
          ? { ...entry, sentAt: new Date().toISOString(), lastError: undefined }
          : entry);
        return next;
      });
      sent += 1;
    } catch (error) {
      await store.update((next) => {
        next.emails = next.emails.map((entry) => entry.id === email.id
          ? { ...entry, attempts: (entry.attempts || 0) + 1, lastError: String(error.message || error) }
          : entry);
        return next;
      });
    }
  }

  return { sent, skipped: false };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/mailer.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Extend `server/store.js` schema for e-mail delivery status**

In `SCHEMA_SQL` (`server/store.js:16-97`), replace the `emails` table
definition:

```sql
CREATE TABLE IF NOT EXISTS emails (
  id text PRIMARY KEY,
  type text NOT NULL,
  recipient_email text NOT NULL,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);
```

with:

```sql
CREATE TABLE IF NOT EXISTS emails (
  id text PRIMARY KEY,
  type text NOT NULL,
  recipient_email text NOT NULL,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);

ALTER TABLE emails ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS last_error text;
```

(Using `ADD COLUMN IF NOT EXISTS` instead of changing the `CREATE TABLE`
body keeps this idempotent against an already-running database that has
the old 5-column table, matching this file's existing "no separate
migration files" convention.)

In `readStore` (`server/store.js:286-293`), replace the `emails` mapping:

```js
    emails: emailsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      to: row.recipient_email,
      orderId: row.order_id,
      createdAt: asIsoString(row.created_at)
    }))
```

with:

```js
    emails: emailsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      to: row.recipient_email,
      orderId: row.order_id,
      createdAt: asIsoString(row.created_at),
      sentAt: row.sent_at ? asIsoString(row.sent_at) : undefined,
      attempts: Number(row.attempts || 0),
      lastError: undefinedIfNull(row.last_error)
    }))
```

In `replaceStore` (`server/store.js:415-420`), replace the emails insert
loop:

```js
  for (const email of nextStore.emails) {
    await client.query(
      'INSERT INTO emails (id, type, recipient_email, order_id, created_at) VALUES ($1, $2, $3, $4, $5)',
      [email.id, email.type, email.to, email.orderId, asTimestamp(email.createdAt)]
    );
  }
```

with:

```js
  for (const email of nextStore.emails) {
    await client.query(
      `INSERT INTO emails (id, type, recipient_email, order_id, created_at, sent_at, attempts, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        email.id,
        email.type,
        email.to,
        email.orderId,
        asTimestamp(email.createdAt),
        email.sentAt ? asTimestamp(email.sentAt) : null,
        Number(email.attempts || 0),
        nullIfEmpty(email.lastError)
      ]
    );
  }
```

- [ ] **Step 6: Wire the mailer into `server/index.js`**

Add the import (`server/index.js:6-14`, alongside the existing
`shared/contract.js` and `./store.js` imports):

```js
import { processPendingEmails, resolveMailerConfig } from './mailer.js';
```

Inside `createApp` (`server/index.js:24-31`, right after `const
corsOrigins = resolveCorsOrigins(options.corsOrigins);`), add:

```js
  const mailerConfig = options.mailerConfig || resolveMailerConfig();
```

Replace the hardcoded recipient in `queueEmails`
(`server/index.js:221-238`):

```js
      {
        id: crypto.randomUUID(),
        type: 'internal_order',
        to: 'pedro.gnaponoceno@gmail.com',
        orderId: order.id,
        createdAt: new Date().toISOString()
      },
```

with:

```js
      {
        id: crypto.randomUUID(),
        type: 'internal_order',
        to: mailerConfig.orderRecipient,
        orderId: order.id,
        createdAt: new Date().toISOString()
      },
```

Right after the order's `store.update(...)` call succeeds in the
`POST /api/orders` handler (`server/index.js:583-599`), trigger a
non-blocking send attempt so confirmation e-mails go out immediately
instead of waiting for the next background tick:

```js
        await store.update((nextStore) => {
          nextStore.orders.push(order);
          if (idempotencyKey) {
            nextStore.idempotencyKeys.push({
              id: crypto.randomUUID(),
              key: idempotencyKey,
              userId: sessionUser.user.id,
              orderId: order.id,
              response: responsePayload,
              createdAt: now
            });
          }
          queueEmails(nextStore, order);
          return nextStore;
        });

        processPendingEmails(store, { config: mailerConfig }).catch((error) => {
          console.error('[mailer] send failed', error);
        });

        writeJson(response, 201, responsePayload);
```

Finally, add a background retry loop that only starts when the server
actually starts listening (never during `createApp()` + `app.inject()`
unit tests), in `server.start` (`server/index.js:727-732`):

```js
  server.start = async function start(port = Number(process.env.PORT || 3001), host = process.env.HOST || '127.0.0.1') {
    await store.init?.();
    setInterval(() => {
      processPendingEmails(store, { config: mailerConfig }).catch((error) => {
        console.error('[mailer] worker error', error);
      });
    }, 30_000);
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  };
```

- [ ] **Step 7: Add the new env vars to Docker Compose and the example env file**

In `compose.yml`, replace the `x-api-environment` anchor:

```yaml
x-api-environment: &api-environment
  DATABASE_URL: postgresql://${POSTGRES_USER:-napo3d}:${POSTGRES_PASSWORD:-napo3d}@db:5432/${POSTGRES_DB:-napo3d_development}
  HOST: 0.0.0.0
  PORT: "3001"
  CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000}
```

with:

```yaml
x-api-environment: &api-environment
  DATABASE_URL: postgresql://${POSTGRES_USER:-napo3d}:${POSTGRES_PASSWORD:-napo3d}@db:5432/${POSTGRES_DB:-napo3d_development}
  HOST: 0.0.0.0
  PORT: "3001"
  CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000}
  EMAIL_PROVIDER: ${EMAIL_PROVIDER:-resend}
  RESEND_API_KEY: ${RESEND_API_KEY:-}
  FROM_EMAIL: ${FROM_EMAIL:-}
  ORDER_RECIPIENT: ${ORDER_RECIPIENT:-pedro.gnaponoceno@gmail.com}
```

(Leaving `RESEND_API_KEY`/`FROM_EMAIL` blank by default means
`resolveMailerConfig` reports `configured: false` in local dev, so
developers never accidentally send real e-mails from `docker:up`.)

In `compose.production.yml`, replace the `x-api-environment` anchor:

```yaml
x-api-environment: &api-environment
  DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
  HOST: 0.0.0.0
  PORT: "3001"
  CORS_ORIGINS: ${CORS_ORIGINS}
```

with:

```yaml
x-api-environment: &api-environment
  DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
  HOST: 0.0.0.0
  PORT: "3001"
  CORS_ORIGINS: ${CORS_ORIGINS}
  EMAIL_PROVIDER: ${EMAIL_PROVIDER}
  RESEND_API_KEY: ${RESEND_API_KEY}
  FROM_EMAIL: ${FROM_EMAIL}
  ORDER_RECIPIENT: ${ORDER_RECIPIENT}
```

Replace `.env.production.example` in full:

```dotenv
POSTGRES_DB=napo3d_production
POSTGRES_USER=napo3d
POSTGRES_PASSWORD=change-me
CORS_ORIGINS=https://napo3d.shop,https://www.napo3d.shop
EMAIL_PROVIDER=resend
RESEND_API_KEY=change-me
FROM_EMAIL=pedidos@napo3d.shop
ORDER_RECIPIENT=pedro.gnaponoceno@gmail.com
```

- [ ] **Step 8: Run the full test suite and validate Compose config**

Run: `node --test`
Expected: PASS (all existing + new mailer tests)

Run: `docker compose -f compose.yml config >/dev/null && docker compose -f compose.production.yml config >/dev/null`
Expected: no errors (both files parse and interpolate cleanly)

- [ ] **Step 9: Commit**

```bash
git add server/mailer.js server/store.js server/index.js test/mailer.test.js compose.yml compose.production.yml .env.production.example
git commit -m "feat: send real order emails via Resend instead of only queuing them"
```

---

## Task 2: Authorization and coverage tests

**Files:**
- Modify: `test/api.test.js` (append new tests; no production code changes
  in this task — all endpoints under test already exist and already behave
  correctly, this task only proves it)

**Interfaces:**
- Consumes: `startTestServer()` and `api(app, pathname, options)` helpers
  already defined at the top of `test/api.test.js:9-30` — reuse them
  as-is, do not redefine.

- [ ] **Step 1: Write the failing/new tests**

Append to `test/api.test.js`:

```js
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
      recipientName: 'Ana', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP'
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
    body: JSON.stringify({ recipientName: 'Ana', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' })
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
    method: 'POST', headers: auth,
    body: JSON.stringify({ recipientName: 'Carla', postalCode: '13010111', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' })
  });
  assert.equal(first.json.address.isDefault, true);

  const second = await api(app, '/api/me/addresses', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ recipientName: 'Carla', postalCode: '13010222', street: 'Rua B', number: '2', city: 'Campinas', state: 'SP' })
  });
  assert.equal(second.json.address.isDefault, false);

  const setDefault = await api(app, `/api/me/addresses/${second.json.address.id}/default`, {
    method: 'POST', headers: auth
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
  for (let i = 0; i < 11; i += 1) {
    const result = await api(app, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: `User ${i}`, email: `user${i}@example.com`, password: '12345678' })
    });
    lastStatus = result.response.status;
  }
  assert.equal(lastStatus, 429);
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/api.test.js`
Expected: PASS (all existing tests + 5 new tests, 0 failures)

- [ ] **Step 3: Commit**

```bash
git add test/api.test.js
git commit -m "test: cover cross-user authorization, default address, catalog filtering, rate limiting"
```

---

## Task 2B: Run the API container as a non-root user

**Why this belongs here:** every other repository already running on the
same shared EC2 host (`corus-back`, `corus-front`, `corus-tracker`,
`corus-tracker-mcp`) runs its final container stage as a dedicated
non-root user — confirmed directly against their real Dockerfiles, and
documented as a hard rule in
`corus-shared-knowledge/docs/engineering/infra/00-docker-conventions.md`
("nenhum roda como `root` no estágio final"). `napo3d`'s `Dockerfile.api`
currently has no `USER` directive, so the Node process runs as `root`
inside its container. Nothing is broken today, but it's a real, low-effort
divergence from a convention every neighboring service on this exact host
already follows.

**Files:**
- Modify: `Dockerfile.api`

**Interfaces:** none (build-time change only; the running app's behavior
is unaffected since it never writes to the filesystem — it only reads
`data/models.json` and talks to Postgres over the network).

- [ ] **Step 1: Add a dedicated user and switch to it before `CMD`**

Replace `Dockerfile.api` in full:

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY . .

RUN addgroup -S napo3d \
    && adduser -S napo3d -G napo3d \
    && chown -R napo3d:napo3d /app

USER napo3d:napo3d

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

EXPOSE 3001

CMD ["node", "./server/index.js"]
```

- [ ] **Step 2: Rebuild and verify the container runs as the new user**

Run: `docker compose -f compose.yml build api && docker compose -f compose.yml run --rm api whoami`
Expected: prints `napo3d`, not `root`

Run: `docker compose -f compose.yml up -d && curl http://127.0.0.1:3001/api/health`
Expected: `{"status":"ok"}` — confirms the app still starts, reads
`data/models.json`, and reaches Postgres correctly as the new non-root
user.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.api
git commit -m "security: run the API container as a non-root user, matching the shared host's convention"
```

---

## Task 3: Remove the GitHub Pages workflow

**Files:**
- Delete: `.github/workflows/static.yml`

**Interfaces:** none (deletion only).

- [ ] **Step 1: Delete the workflow file**

```bash
git rm .github/workflows/static.yml
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore: remove GitHub Pages workflow, storefront now deploys to production only"
```

- [ ] **Step 3: Manual follow-up (cannot be done from the repo — flag to the human operator)**

In the GitHub repo settings (`https://github.com/penapono/napo3d/settings/pages`),
set **Source** to **None** to actually unpublish the already-live Pages
site. Deleting the workflow file only stops *future* deploys to Pages; the
last-published version stays live at the `*.github.io` URL until the
Pages source is disabled.

---

## Task 4: Add the production auto-deploy GitHub Actions workflow

**Files:**
- Create: `.github/workflows/deploy-production.yml`

**Interfaces:** none (new CI workflow; consumes repo secrets configured in
Task 9).

- [ ] **Step 1: Create the workflow**

This mirrors, line for line, the already-working
`.github/workflows/deploy-production.yml` used by `corus-back` and
`corus-front` in production today (verified directly against those repos'
files, not just their docs) — same SSH hardening flags, same
heredoc-with-positional-argument pattern for passing the commit SHA (safer
than interpolating `${{ github.sha }}` directly into a shell string), same
`permissions`/`timeout-minutes` safety nets. Only the names (`napo3d`,
port-free since it has its own combined front+api deploy script) differ.

```yaml
name: Deploy production

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: napo3d-production
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy to AWS EC2 (shared Corus host)
    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 30

    steps:
      - name: Configure SSH
        env:
          SSH_PRIVATE_KEY: ${{ secrets.LIGHTSAIL_SSH_PRIVATE_KEY }}
          SSH_KNOWN_HOSTS: ${{ secrets.LIGHTSAIL_KNOWN_HOSTS }}
        run: |
          install -m 700 -d ~/.ssh
          printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/lightsail
          chmod 600 ~/.ssh/lightsail
          printf '%s\n' "$SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 600 ~/.ssh/known_hosts

      - name: Deploy pushed commit
        env:
          LIGHTSAIL_HOST: ${{ secrets.LIGHTSAIL_HOST }}
          DEPLOY_SHA: ${{ github.sha }}
        run: |
          ssh -i ~/.ssh/lightsail \
            -o BatchMode=yes \
            -o StrictHostKeyChecking=yes \
            "ubuntu@$LIGHTSAIL_HOST" \
            "bash -s -- '$DEPLOY_SHA'" <<'REMOTE'
          set -Eeuo pipefail

          readonly deploy_sha="$1"
          cd /srv/napo3d/current

          git fetch origin main
          git checkout main
          git merge --ff-only "$deploy_sha"

          ./script/deploy_production
          REMOTE
```

- [ ] **Step 2: Validate the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy-production.yml'))"`
(or any YAML linter available; the goal is only to catch indentation
errors before pushing)
Expected: no error/output

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-production.yml
git commit -m "ci: add automatic production deploy over SSH on push to main"
```

This workflow will fail at runtime until the `LIGHTSAIL_HOST`,
`LIGHTSAIL_SSH_PRIVATE_KEY`, `LIGHTSAIL_KNOWN_HOSTS` secrets and the
`production` environment exist — that is done in Task 9, after the host is
actually provisioned (Task 7), since the deploy key and host address don't
exist yet at this point in the plan.

---

## Task 5: Update the deploy documentation

**Files:**
- Modify: `docs/engineering/deploy_aws_lightsail.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Replace the placeholder domain everywhere it appears**

Replace every occurrence of `loja.napo3d.com.br` with `napo3d.shop` and
every occurrence of `www.loja.napo3d.com.br` with `www.napo3d.shop` in
`docs/engineering/deploy_aws_lightsail.md` (occurrences are in the
prerequisites table, the Nginx `server_name` line, the `certbot` command,
and the DNS/`dig` section).

- [ ] **Step 2: Document the new e-mail env vars in section 4**

Replace:

```dotenv
POSTGRES_DB=napo3d_production
POSTGRES_USER=napo3d
POSTGRES_PASSWORD=<senha-forte-e-unica>
CORS_ORIGINS=https://loja.napo3d.com.br
```

with:

```dotenv
POSTGRES_DB=napo3d_production
POSTGRES_USER=napo3d
POSTGRES_PASSWORD=<senha-forte-e-unica>
CORS_ORIGINS=https://napo3d.shop,https://www.napo3d.shop
EMAIL_PROVIDER=resend
RESEND_API_KEY=<chave-da-conta-resend>
FROM_EMAIL=pedidos@napo3d.shop
ORDER_RECIPIENT=pedro.gnaponoceno@gmail.com
```

- [ ] **Step 3: Update section 9 (GitHub Actions)**

Replace the whole section 9 body (which currently says the repo "ainda não
tem workflow de deploy por GitHub Actions") with:

```markdown
## 9. GitHub Actions

O repositório já tem `.github/workflows/deploy-production.yml`, que faz
deploy automático a cada push em `main` via SSH, executando
`script/deploy_production` no host.

Esse workflow depende dos seguintes secrets do repositório (**Settings →
Secrets and variables → Actions**) e de um environment chamado
`production`:

| Secret | Conteúdo |
|---|---|
| `LIGHTSAIL_HOST` | IP público ou hostname do host compartilhado com o Corus |
| `LIGHTSAIL_SSH_PRIVATE_KEY` | Chave privada dedicada ao deploy do napo3d (gerada na seção 3) |
| `LIGHTSAIL_KNOWN_HOSTS` | Saída de `ssh-keyscan <host>` para esse mesmo host |

Depois de configurar os secrets, qualquer push em `main` dispara o deploy.
Para forçar manualmente, use **Actions → Deploy napo3d to production → Run
workflow**.
```

- [ ] **Step 4: Update section 10 (Backups)**

Replace the whole section 10 body with:

```markdown
## 10. Backups

`script/backup_napo3d` faz um `pg_dump` diário e apaga dumps com mais de
14 dias. No host, registre no crontab do usuário `ubuntu`:

\`\`\`bash
crontab -e
# adicionar:
0 3 * * * /srv/napo3d/current/script/backup_napo3d >> /var/log/napo3d-backup.log 2>&1
\`\`\`

Os dumps ficam em `/srv/napo3d-backups/daily/`. Recomendação operacional:

- não dependa apenas do disco do host — copie os dumps periodicamente para
  fora da instância (S3, outro host, etc.);
- teste a restauração de um dump antes de considerar o processo confiável.
```

- [ ] **Step 5: Commit**

```bash
git add docs/engineering/deploy_aws_lightsail.md
git commit -m "docs: point deploy guide at napo3d.shop and document email/backup setup"
```

---

## Task 6: Automated daily PostgreSQL backup script

**Files:**
- Create: `script/backup_napo3d`

**Interfaces:** none (standalone host script, invoked by cron per Task 5
Step 4).

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR=/srv/napo3d/current
readonly BACKUP_DIR=/srv/napo3d-backups/daily
readonly RETENTION_DAYS=14
readonly STAMP="$(date +%F-%H%M%S)"

mkdir -p "$BACKUP_DIR"

cd "$APP_DIR"
docker compose --env-file .env.production -f compose.production.yml exec -T db \
  sh -lc 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$BACKUP_DIR/napo3d-$STAMP.sql"

find "$BACKUP_DIR" -name 'napo3d-*.sql' -mtime "+$RETENTION_DAYS" -delete

echo "Backup finished: $BACKUP_DIR/napo3d-$STAMP.sql"
```

- [ ] **Step 2: Make it executable and commit**

```bash
chmod +x script/backup_napo3d
git add script/backup_napo3d
git commit -m "ops: add daily PostgreSQL backup script with 14-day retention"
```

- [ ] **Step 3: Verify on the host (after Task 7 provisions it — cannot run locally, there is no production `db` container here)**

```bash
/srv/napo3d/current/script/backup_napo3d
ls -lh /srv/napo3d-backups/daily/
```

Expected: a non-empty `napo3d-<timestamp>.sql` file appears.

---

## Operational runbook — requires production credentials (host SSH, GitHub admin, DNS, Resend)

Everything below this line touches real infrastructure: the shared EC2
host, DNS records, a TLS certificate, and GitHub repository secrets. Do
not run these unattended — confirm with the human operator before each
numbered task, since mistakes here (wrong DNS record, wrong Nginx block,
force-issuing a cert) are visible externally and not easily reversible.

## Task 7: Provision the host and bring the stack up for the first time

- [ ] **Step 1: Create a Resend account and sender**

Sign up at Resend, verify a sending domain or use their default test
domain during setup, and generate an API key. Note the key and the `from`
address you're approved to send from — you'll need both for
`.env.production`.

- [ ] **Step 2: Create host directories** (SSH into the shared EC2 host as `ubuntu`)

```bash
sudo mkdir -p /srv/napo3d/current
sudo mkdir -p /srv/napo3d-data/postgres
sudo mkdir -p /srv/napo3d-backups/{daily,manual}
sudo chown -R ubuntu:ubuntu /srv/napo3d /srv/napo3d-data /srv/napo3d-backups
chmod 700 /srv/napo3d-data/postgres
```

- [ ] **Step 3: Create a deploy key and grant read-only repo access**

```bash
ssh-keygen -t ed25519 -C 'napo3d-production' -f ~/.ssh/id_ed25519_napo3d -N ''
cat ~/.ssh/id_ed25519_napo3d.pub
```

Add the printed public key to `https://github.com/penapono/napo3d/settings/keys`
as a read-only deploy key. Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com-napo3d
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_napo3d
  IdentitiesOnly yes
EOF
ssh-keyscan github.com >> ~/.ssh/known_hosts
git clone git@github.com-napo3d:penapono/napo3d.git /srv/napo3d/current
cd /srv/napo3d/current
git checkout main
```

- [ ] **Step 4: Create `.env.production`**

```bash
cd /srv/napo3d/current
umask 077
cp .env.production.example .env.production
nano .env.production
chmod 600 .env.production
```

Fill in real values:

```dotenv
POSTGRES_DB=napo3d_production
POSTGRES_USER=napo3d
POSTGRES_PASSWORD=<gere com: openssl rand -hex 24>
CORS_ORIGINS=https://napo3d.shop,https://www.napo3d.shop
EMAIL_PROVIDER=resend
RESEND_API_KEY=<chave gerada no Passo 1>
FROM_EMAIL=<endereço aprovado no Passo 1>
ORDER_RECIPIENT=pedro.gnaponoceno@gmail.com
```

- [ ] **Step 5: First `up` and health check**

```bash
df -h
docker system df

cd /srv/napo3d/current
docker compose --env-file .env.production -f compose.production.yml build --pull front api
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs --tail=100 api front db

curl -I http://127.0.0.1:3500/
curl http://127.0.0.1:3501/api/health
```

Expected: frontend responds `200`; API responds `{"status":"ok"}`.

---

## Task 8: Nginx vhost, DNS, and HTTPS for napo3d.shop

- [ ] **Step 1: DNS**

At the DNS provider for `napo3d.shop`, create `A` records for `napo3d.shop`
and `www.napo3d.shop` pointing at the same public IP the Corus host
already uses. Confirm propagation:

```bash
dig +short napo3d.shop
dig +short www.napo3d.shop
```

- [ ] **Step 2: Nginx server block**

```bash
sudo nano /etc/nginx/sites-available/napo3d
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name napo3d.shop www.napo3d.shop;

    client_max_body_size 10M;
    proxy_read_timeout 120s;
    proxy_connect_timeout 15s;
    proxy_send_timeout 120s;

    location /api/ {
        proxy_pass http://127.0.0.1:3501;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
    }

    location / {
        proxy_pass http://127.0.0.1:3500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
    }
}
```

```bash
sudo ln -sfn /etc/nginx/sites-available/napo3d /etc/nginx/sites-enabled/napo3d
sudo nginx -t
sudo systemctl reload nginx
curl -I http://127.0.0.1/ -H 'Host: napo3d.shop'
curl http://127.0.0.1/api/health -H 'Host: napo3d.shop'
```

- [ ] **Step 3: TLS certificate**

```bash
sudo certbot --nginx --cert-name napo3d.shop -d napo3d.shop -d www.napo3d.shop
sudo certbot renew --dry-run
sudo certbot certificates
```

- [ ] **Step 4: Verify from outside the host**

Visit `https://napo3d.shop/` in a browser and confirm the catalog loads,
and that `https://napo3d.shop/api/health` returns `{"status":"ok"}`.

---

## Task 9: Enable the GitHub Actions auto-deploy

- [ ] **Step 1: Create the `production` environment**

In `https://github.com/penapono/napo3d/settings/environments`, create an
environment named `production` (required by the workflow from Task 4).

- [ ] **Step 2: Add repository secrets**

In `https://github.com/penapono/napo3d/settings/secrets/actions`, add:

- `LIGHTSAIL_HOST` — the host's public IP or hostname
- `LIGHTSAIL_SSH_PRIVATE_KEY` — the **private** half of the deploy key
  generated in Task 7 Step 3 (`~/.ssh/id_ed25519_napo3d`, not the
  `.pub` file)
- `LIGHTSAIL_KNOWN_HOSTS` — output of `ssh-keyscan <LIGHTSAIL_HOST>` run
  from any machine with network access to the host

- [ ] **Step 3: Trigger and verify a deploy**

Push any small commit to `main` (or use **Actions → Deploy napo3d to
production → Run workflow**), then confirm in the Actions tab that the
job succeeds, and that `git -C /srv/napo3d/current log -1` on the host
matches the latest commit on `main`.

---

## Task 10: End-to-end acceptance validation against production

Walk through `BACKEND_CONTRACT.md`'s "Critérios de aceite" against
`https://napo3d.shop` with a real browser and a real e-mail address you
control:

- [ ] Register a new account, log out, log back in.
- [ ] Create two addresses; confirm the first becomes default automatically.
- [ ] Set the second address as default; confirm the first is no longer
  default (`GET /api/me/addresses` in DevTools network tab).
- [ ] Add a product to the cart, refresh the page, confirm the cart survived.
- [ ] Add the same product/option again; confirm quantity incremented
  instead of duplicating the line.
- [ ] Change the quantity across a price-tier boundary (e.g. from 40 to 60
  units) and confirm the unit price changes accordingly.
- [ ] Click "Concluir compra" while logged out; confirm it requires login
  (`401 AUTH_REQUIRED`) before anything else.
- [ ] Log in, remove all addresses, attempt checkout; confirm
  `422 ADDRESS_REQUIRED`.
- [ ] Complete a real order with a valid address.
- [ ] Confirm the order appears in `GET /api/me/orders`.
- [ ] Confirm **two** real e-mails arrive: one at the test account's own
  inbox (customer confirmation) and one at `pedro.gnaponoceno@gmail.com`
  (internal notification), each with correct items, weights, unit prices,
  subtotal, and total.
- [ ] Resubmit the exact same order request with the same
  `Idempotency-Key` (e.g. via `curl` with DevTools-copied headers);
  confirm it returns the same order id and does **not** create a second
  row in `orders`.
- [ ] Register a second account and confirm it cannot see the first
  account's addresses or orders.
- [ ] In DevTools, confirm `apiClient.getMode()` reports `"live"` (open the
  console and run `document` — or simpler, confirm Network tab shows
  requests going to `https://napo3d.shop/api/...`, not falling back to
  `localStorage`-only mock mode).
- [ ] On the host, run `docker compose --env-file .env.production -f
  compose.production.yml exec -T db psql -U napo3d -d napo3d_production -c
  "select count(*) from orders;"` and confirm the row count matches what
  was created during this walkthrough.
- [ ] Run `/srv/napo3d/current/script/backup_napo3d` once more manually and
  confirm a fresh dump appears in `/srv/napo3d-backups/daily/`.

If every box above is checked, `BACKEND_CONTRACT.md`'s acceptance criteria
are satisfied end-to-end.

---

## Explicitly out of scope for this plan

- **Cart persisted server-side** (`GET/PUT /api/me/cart`). The contract
  offers keeping an anonymous cart in a signed cookie as an alternative to
  a server endpoint; the current `localStorage`-based cart already
  survives refresh and login (it's a separate key from the account/session
  state, so logging in or out never clears it), which already satisfies
  the acceptance criterion. Add a server-side cart only if multi-device
  cart sync becomes an actual requirement.
- **Per-product `productionTime` values in `data/models.json`.** None of
  the 12 products currently set this field; every quote falls back to the
  contract's documented default of 60 minutes. Populating real per-product
  values is a content task for whoever owns the catalog, not a backend
  change.
- **Stripe/card payments** — contract explicitly defers this to a later
  phase.
- **Admin panel** — not requested by the contract beyond "sanitize text
  before the panel", and no panel exists yet.
