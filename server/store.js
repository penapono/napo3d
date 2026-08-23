import { Pool } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgresql://napo3d:napo3d@127.0.0.1:5432/napo3d_development';

const EMPTY_STORE = {
  users: [],
  sessions: [],
  addresses: [],
  orders: [],
  idempotencyKeys: [],
  emails: [],
};

const STORE_LOCK_KEY = 3345103;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'customer';

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_name text NOT NULL,
  postal_code text NOT NULL,
  street text NOT NULL,
  number text NOT NULL,
  complement text,
  neighborhood text,
  city text NOT NULL,
  state text NOT NULL,
  reference text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  address_snapshot jsonb NOT NULL,
  subtotal integer NOT NULL,
  shipping integer NOT NULL,
  total integer NOT NULL,
  production_estimate_hours double precision NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position integer NOT NULL,
  product_id text NOT NULL,
  option_name text NOT NULL,
  product_name_snapshot text NOT NULL,
  unit_weight_grams integer NOT NULL,
  quantity integer NOT NULL,
  unit_price integer NOT NULL,
  line_total integer NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id text PRIMARY KEY,
  request_key text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  response_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, request_key)
);

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
ALTER TABLE emails ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text,
  reference text,
  summary text,
  description text,
  keywords jsonb NOT NULL DEFAULT '[]',
  ai_data jsonb NOT NULL DEFAULT '{}',
  page integer,
  production_time integer,
  options jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS production_time integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS keywords jsonb NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_data jsonb NOT NULL DEFAULT '{}';
`;

export function createMemoryStore(initialState = EMPTY_STORE) {
  let state = structuredClone({ ...EMPTY_STORE, ...initialState });
  let products = structuredClone(initialState.products || []);
  let pending = Promise.resolve();

  function runExclusive(task) {
    const result = pending.then(task, task);
    pending = result.then(
      () => undefined,
      () => undefined
    );
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
      return structuredClone(products).sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      );
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
    },
    async replaceProducts(nextProducts) {
      return runExclusive(async () => {
        products = structuredClone(nextProducts);
        return { count: products.length };
      });
    },
  };
}

export function createPostgresStore(options = {}) {
  const connectionString =
    options.connectionString || process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const pool = options.pool || new Pool({ connectionString });
  let initPromise = null;

  async function ensureReady() {
    if (!initPromise) {
      initPromise = (async () => {
        const client = await pool.connect();
        try {
          await client.query(SCHEMA_SQL);
        } finally {
          client.release();
        }
      })();
    }
    return initPromise;
  }

  async function withClient(callback) {
    await ensureReady();
    const client = await pool.connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  return {
    async init() {
      await ensureReady();
    },
    async read() {
      return withClient(readStore);
    },
    async write(nextStore) {
      return withClient(async (client) => {
        const store = withStoreDefaults(nextStore);
        await client.query('BEGIN');
        try {
          await client.query('SELECT pg_advisory_xact_lock($1)', [STORE_LOCK_KEY]);
          await replaceStore(client, store);
          await client.query('COMMIT');
          return structuredClone(store);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    async update(mutator) {
      return withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('SELECT pg_advisory_xact_lock($1)', [STORE_LOCK_KEY]);
          const currentStore = await readStore(client);
          const nextStore = withStoreDefaults(await mutator(structuredClone(currentStore)));
          await replaceStore(client, nextStore);
          await client.query('COMMIT');
          return structuredClone(nextStore);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
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
          `INSERT INTO products (
             id, name, category, reference, summary, description, keywords, ai_data,
             page, production_time, options, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12, $13)`,
          [
            product.id,
            product.name,
            nullIfEmpty(product.category),
            nullIfEmpty(product.reference),
            nullIfEmpty(product.summary),
            nullIfEmpty(product.description),
            JSON.stringify(product.keywords || []),
            JSON.stringify(product.aiData || {}),
            product.page ?? null,
            product.productionTime ?? null,
            JSON.stringify(product.options || []),
            asTimestamp(product.createdAt),
            asTimestamp(product.updatedAt),
          ]
        );
        return product;
      });
    },
    async updateProduct(id, patch) {
      return withClient(async (client) => {
        const existing = await client.query('SELECT * FROM products WHERE id = $1', [id]);
        if (!existing.rows[0]) return null;
        const next = {
          ...mapProductRow(existing.rows[0]),
          ...patch,
          id,
          updatedAt: new Date().toISOString(),
        };
        await client.query(
          `UPDATE products
             SET name = $2,
                 category = $3,
                 reference = $4,
                 summary = $5,
                 description = $6,
                 keywords = $7::jsonb,
                 ai_data = $8::jsonb,
                 page = $9,
                 production_time = $10,
                 options = $11::jsonb,
                 updated_at = $12
           WHERE id = $1`,
          [
            id,
            next.name,
            nullIfEmpty(next.category),
            nullIfEmpty(next.reference),
            nullIfEmpty(next.summary),
            nullIfEmpty(next.description),
            JSON.stringify(next.keywords || []),
            JSON.stringify(next.aiData || {}),
            next.page ?? null,
            next.productionTime ?? null,
            JSON.stringify(next.options || []),
            asTimestamp(next.updatedAt),
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
        await replaceProductsTable(client, seedList);
        return { seeded: seedList.length };
      });
    },
    async replaceProducts(nextProducts) {
      return withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await replaceProductsTable(client, nextProducts);
          await client.query('COMMIT');
          return { count: nextProducts.length };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    async close() {
      await pool.end();
    },
  };
}

function withStoreDefaults(store) {
  return {
    users: Array.isArray(store?.users) ? store.users : [],
    sessions: Array.isArray(store?.sessions) ? store.sessions : [],
    addresses: Array.isArray(store?.addresses) ? store.addresses : [],
    orders: Array.isArray(store?.orders) ? store.orders : [],
    idempotencyKeys: Array.isArray(store?.idempotencyKeys) ? store.idempotencyKeys : [],
    emails: Array.isArray(store?.emails) ? store.emails : [],
  };
}

async function readStore(client) {
  const usersResult = await client.query('SELECT * FROM users ORDER BY created_at ASC, id ASC');
  const sessionsResult = await client.query(
    'SELECT * FROM sessions ORDER BY created_at ASC, token ASC'
  );
  const addressesResult = await client.query(
    'SELECT * FROM addresses ORDER BY created_at ASC, id ASC'
  );
  const ordersResult = await client.query('SELECT * FROM orders ORDER BY created_at ASC, id ASC');
  const orderItemsResult = await client.query(
    'SELECT * FROM order_items ORDER BY order_id ASC, position ASC, id ASC'
  );
  const idempotencyResult = await client.query(
    'SELECT * FROM idempotency_keys ORDER BY created_at ASC, id ASC'
  );
  const emailsResult = await client.query('SELECT * FROM emails ORDER BY created_at ASC, id ASC');

  const itemsByOrderId = new Map();
  for (const row of orderItemsResult.rows) {
    const items = itemsByOrderId.get(row.order_id) || [];
    items.push({
      id: row.id,
      orderId: row.order_id,
      productId: row.product_id,
      optionName: row.option_name,
      productNameSnapshot: row.product_name_snapshot,
      unitWeightGrams: Number(row.unit_weight_grams),
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
      lineTotal: Number(row.line_total),
    });
    itemsByOrderId.set(row.order_id, items);
  }

  return {
    users: usersResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: undefinedIfNull(row.phone),
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: asIsoString(row.created_at),
      updatedAt: asIsoString(row.updated_at),
    })),
    sessions: sessionsResult.rows.map((row) => ({
      token: row.token,
      userId: row.user_id,
      createdAt: asIsoString(row.created_at),
    })),
    addresses: addressesResult.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      recipientName: row.recipient_name,
      postalCode: row.postal_code,
      street: row.street,
      number: row.number,
      complement: undefinedIfNull(row.complement),
      neighborhood: undefinedIfNull(row.neighborhood),
      city: row.city,
      state: row.state,
      reference: undefinedIfNull(row.reference),
      isDefault: row.is_default,
      createdAt: asIsoString(row.created_at),
      updatedAt: asIsoString(row.updated_at),
    })),
    orders: ordersResult.rows.map((row) => ({
      id: row.id,
      userId: undefinedIfNull(row.user_id),
      status: row.status,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      customerPhone: undefinedIfNull(row.customer_phone),
      addressSnapshot: row.address_snapshot || {},
      items: itemsByOrderId.get(row.id) || [],
      subtotal: Number(row.subtotal),
      shipping: Number(row.shipping),
      total: Number(row.total),
      productionEstimateHours: Number(row.production_estimate_hours),
      notes: undefinedIfNull(row.notes),
      createdAt: asIsoString(row.created_at),
      updatedAt: asIsoString(row.updated_at),
    })),
    idempotencyKeys: idempotencyResult.rows.map((row) => ({
      id: row.id,
      key: row.request_key,
      userId: row.user_id,
      orderId: row.order_id,
      response: row.response_payload,
      createdAt: asIsoString(row.created_at),
    })),
    emails: emailsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      to: row.recipient_email,
      orderId: row.order_id,
      createdAt: asIsoString(row.created_at),
      sentAt: row.sent_at ? asIsoString(row.sent_at) : undefined,
      attempts: Number(row.attempts || 0),
      lastError: undefinedIfNull(row.last_error),
      processingStartedAt: row.processing_started_at
        ? asIsoString(row.processing_started_at)
        : undefined,
    })),
  };
}

async function replaceStore(client, nextStore) {
  await client.query('DELETE FROM order_items');
  await client.query('DELETE FROM idempotency_keys');
  await client.query('DELETE FROM emails');
  await client.query('DELETE FROM sessions');
  await client.query('DELETE FROM addresses');
  await client.query('DELETE FROM orders');
  await client.query('DELETE FROM users');

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
        asTimestamp(user.updatedAt),
      ]
    );
  }

  for (const session of nextStore.sessions) {
    await client.query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [
      session.token,
      session.userId,
      asTimestamp(session.createdAt),
    ]);
  }

  for (const address of nextStore.addresses) {
    await client.query(
      `INSERT INTO addresses (
         id, user_id, recipient_name, postal_code, street, number, complement,
         neighborhood, city, state, reference, is_default, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        address.id,
        address.userId,
        address.recipientName,
        address.postalCode,
        address.street,
        address.number,
        nullIfEmpty(address.complement),
        nullIfEmpty(address.neighborhood),
        address.city,
        address.state,
        nullIfEmpty(address.reference),
        Boolean(address.isDefault),
        asTimestamp(address.createdAt),
        asTimestamp(address.updatedAt),
      ]
    );
  }

  for (const order of nextStore.orders) {
    await client.query(
      `INSERT INTO orders (
         id, user_id, status, customer_name, customer_email, customer_phone,
         address_snapshot, subtotal, shipping, total, production_estimate_hours,
         notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
      [
        order.id,
        nullIfEmpty(order.userId),
        order.status,
        order.customerName,
        order.customerEmail,
        nullIfEmpty(order.customerPhone),
        JSON.stringify(order.addressSnapshot || {}),
        Number(order.subtotal || 0),
        Number(order.shipping || 0),
        Number(order.total || 0),
        Number(order.productionEstimateHours || 0),
        nullIfEmpty(order.notes),
        asTimestamp(order.createdAt),
        asTimestamp(order.updatedAt),
      ]
    );

    for (const [position, item] of (order.items || []).entries()) {
      await client.query(
        `INSERT INTO order_items (
           id, order_id, position, product_id, option_name, product_name_snapshot,
           unit_weight_grams, quantity, unit_price, line_total
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          item.id,
          order.id,
          position,
          item.productId,
          item.optionName,
          item.productNameSnapshot,
          Number(item.unitWeightGrams || 0),
          Number(item.quantity || 0),
          Number(item.unitPrice || 0),
          Number(item.lineTotal || 0),
        ]
      );
    }
  }

  for (const entry of nextStore.idempotencyKeys) {
    await client.query(
      `INSERT INTO idempotency_keys (id, request_key, user_id, order_id, response_payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        entry.id,
        entry.key,
        entry.userId,
        entry.orderId,
        JSON.stringify(entry.response || {}),
        asTimestamp(entry.createdAt),
      ]
    );
  }

  for (const email of nextStore.emails) {
    await client.query(
      `INSERT INTO emails (id, type, recipient_email, order_id, created_at, sent_at, attempts, last_error, processing_started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        email.id,
        email.type,
        email.to,
        email.orderId,
        asTimestamp(email.createdAt),
        email.sentAt ? asTimestamp(email.sentAt) : null,
        Number(email.attempts || 0),
        nullIfEmpty(email.lastError),
        email.processingStartedAt ? asTimestamp(email.processingStartedAt) : null,
      ]
    );
  }
}

function mapProductRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: undefinedIfNull(row.category),
    reference: undefinedIfNull(row.reference),
    summary: undefinedIfNull(row.summary),
    description: undefinedIfNull(row.description),
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    aiData: row.ai_data && typeof row.ai_data === 'object' ? row.ai_data : {},
    page: row.page == null ? undefined : Number(row.page),
    productionTime: row.production_time == null ? undefined : Number(row.production_time),
    options: row.options || [],
    createdAt: asIsoString(row.created_at),
    updatedAt: asIsoString(row.updated_at),
  };
}

async function replaceProductsTable(client, products) {
  await client.query('DELETE FROM products');
  for (const product of products) {
    await client.query(
      `INSERT INTO products (
         id, name, category, reference, summary, description, keywords, ai_data,
         page, production_time, options, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12, $13)`,
      [
        product.id,
        product.name,
        nullIfEmpty(product.category),
        nullIfEmpty(product.reference),
        nullIfEmpty(product.summary),
        nullIfEmpty(product.description),
        JSON.stringify(product.keywords || []),
        JSON.stringify(product.aiData || {}),
        product.page ?? null,
        product.productionTime ?? null,
        JSON.stringify(product.options || []),
        asTimestamp(product.createdAt),
        asTimestamp(product.updatedAt),
      ]
    );
  }
}

function nullIfEmpty(value) {
  return value == null || value === '' ? null : value;
}

function undefinedIfNull(value) {
  return value == null ? undefined : value;
}

function asTimestamp(value) {
  return value instanceof Date ? value : new Date(value);
}

function asIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
