import {
  buildQuote,
  normalizeEmail,
  sortProducts,
  validateAddressInput,
} from '../shared/contract.js';
import { buildCategoryCounts, groupCatalogProducts } from '../shared/catalog.js';

const DB_KEY = 'napo3d-mock-db';

function apiError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isApiError = true;
  return error;
}

function readDb() {
  try {
    return (
      JSON.parse(localStorage.getItem(DB_KEY) || 'null') || {
        users: [],
        sessions: [],
        addresses: [],
        orders: [],
        idempotencyKeys: [],
      }
    );
  } catch {
    return { users: [], sessions: [], addresses: [], orders: [], idempotencyKeys: [] };
  }
}

function writeDb(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createMockBackend({ getToken, loadCatalog }) {
  async function getContext() {
    const token = getToken();
    const db = readDb();
    const session = db.sessions.find((entry) => entry.token === token);
    if (!session) throw apiError('AUTH_REQUIRED', 'Autenticação obrigatória.', 401);
    const user = db.users.find((entry) => entry.id === session.userId);
    if (!user) throw apiError('AUTH_REQUIRED', 'Sessão inválida.', 401);
    return { db, user };
  }

  async function resolveQuote(items) {
    const products = groupCatalogProducts(await loadCatalog());
    const map = new Map(products.map((product) => [product.id, product]));
    return buildQuote(items, (productId) => map.get(productId));
  }

  return {
    async getProducts(params = {}) {
      const products = groupCatalogProducts(await loadCatalog());
      const categories = buildCategoryCounts(products);
      const query = String(params.query || '')
        .trim()
        .toLowerCase();
      const category = String(params.category || '').trim();
      const page = Math.max(1, Number(params.page) || 1);
      const limit = Math.min(48, Math.max(1, Number(params.limit) || 12));
      const filtered = sortProducts(
        products.filter((item) => {
          if (category && category !== 'all' && item.category !== category) return false;
          const option = item.options?.[0];
          if (!query) return true;
          const haystack =
            `${item.name} ${item.category} ${item.summary || ''} ${item.description || ''} ${(item.keywords || []).join(' ')} ${option?.name || ''} ${option?.colors || ''}`.toLowerCase();
          return haystack.includes(query);
        }),
        params.sort || 'recommended'
      );
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const start = (page - 1) * limit;
      return {
        items: filtered.slice(start, start + limit),
        categories,
        pagination: { page, limit, total, totalPages },
      };
    },
    async getProduct(productId) {
      const products = groupCatalogProducts(await loadCatalog());
      const product = products.find((item) => item.id === productId);
      if (!product) throw apiError('PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
      return { product };
    },
    async register(payload) {
      const db = readDb();
      const email = normalizeEmail(payload.email);
      if (!payload.name || !email || String(payload.password || '').length < 8) {
        throw apiError('INVALID_INPUT', 'Nome, e-mail e senha válida são obrigatórios.', 422);
      }
      if (db.users.some((entry) => entry.email === email))
        throw apiError('EMAIL_TAKEN', 'E-mail já cadastrado.', 409);
      const now = new Date().toISOString();
      const user = {
        id: crypto.randomUUID(),
        name: String(payload.name).trim(),
        email,
        phone: String(payload.phone || '').trim() || undefined,
        passwordHash: await sha256(String(payload.password)),
        createdAt: now,
        updatedAt: now,
      };
      const accessToken = crypto.randomUUID();
      db.users.push(user);
      db.sessions.push({ token: accessToken, userId: user.id, createdAt: now });
      writeDb(db);
      return { user: sanitizeUser(user), accessToken };
    },
    async login(payload) {
      const db = readDb();
      const email = normalizeEmail(payload.email);
      const passwordHash = await sha256(String(payload.password || ''));
      const user = db.users.find(
        (entry) => entry.email === email && entry.passwordHash === passwordHash
      );
      if (!user) throw apiError('INVALID_CREDENTIALS', 'Credenciais inválidas.', 401);
      const accessToken = crypto.randomUUID();
      db.sessions.push({
        token: accessToken,
        userId: user.id,
        createdAt: new Date().toISOString(),
      });
      writeDb(db);
      return { user: sanitizeUser(user), accessToken };
    },
    async logout() {
      const db = readDb();
      const token = getToken();
      db.sessions = db.sessions.filter((entry) => entry.token !== token);
      writeDb(db);
      return null;
    },
    async getMe() {
      const { user } = await getContext();
      return { user: sanitizeUser(user) };
    },
    async listAddresses() {
      const { db, user } = await getContext();
      return { addresses: db.addresses.filter((entry) => entry.userId === user.id) };
    },
    async createAddress(payload) {
      const { db, user } = await getContext();
      const validation = validateAddressInput(payload);
      if (!validation.ok) throw apiError(validation.code, validation.message, 422);
      const now = new Date().toISOString();
      const ownAddresses = db.addresses.filter((entry) => entry.userId === user.id);
      const address = {
        id: crypto.randomUUID(),
        userId: user.id,
        ...validation.address,
        isDefault: ownAddresses.length ? Boolean(payload.isDefault) : true,
        createdAt: now,
        updatedAt: now,
      };
      if (address.isDefault) {
        db.addresses = db.addresses.map((entry) =>
          entry.userId === user.id ? { ...entry, isDefault: false } : entry
        );
      }
      db.addresses.push(address);
      writeDb(db);
      return { address };
    },
    async updateAddress(addressId, payload) {
      const { db, user } = await getContext();
      const current = db.addresses.find(
        (entry) => entry.id === addressId && entry.userId === user.id
      );
      if (!current) throw apiError('ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);
      const validation = validateAddressInput({ ...current, ...payload });
      if (!validation.ok) throw apiError(validation.code, validation.message, 422);
      const address = { ...current, ...validation.address, updatedAt: new Date().toISOString() };
      db.addresses = db.addresses.map((entry) => (entry.id === addressId ? address : entry));
      writeDb(db);
      return { address };
    },
    async deleteAddress(addressId) {
      const { db, user } = await getContext();
      const current = db.addresses.find(
        (entry) => entry.id === addressId && entry.userId === user.id
      );
      if (!current) throw apiError('ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);
      db.addresses = db.addresses.filter((entry) => entry.id !== addressId);
      const own = db.addresses.filter((entry) => entry.userId === user.id);
      if (current.isDefault && own.length) own[0].isDefault = true;
      writeDb(db);
      return null;
    },
    async setDefaultAddress(addressId) {
      const { db, user } = await getContext();
      const current = db.addresses.find(
        (entry) => entry.id === addressId && entry.userId === user.id
      );
      if (!current) throw apiError('ADDRESS_NOT_FOUND', 'Endereço não encontrado.', 404);
      let updated = null;
      db.addresses = db.addresses.map((entry) => {
        if (entry.userId !== user.id) return entry;
        const next = {
          ...entry,
          isDefault: entry.id === addressId,
          updatedAt: new Date().toISOString(),
        };
        if (next.isDefault) updated = next;
        return next;
      });
      writeDb(db);
      return { address: updated };
    },
    async quoteOrder(payload) {
      const { db, user } = await getContext();
      const hasAddress = payload.addressId
        ? db.addresses.some((entry) => entry.id === payload.addressId && entry.userId === user.id)
        : false;
      if (!hasAddress)
        throw apiError('ADDRESS_REQUIRED', 'Selecione ou preencha um endereço.', 422);
      return { quote: await resolveQuote(payload.items) };
    },
    async createOrder(payload) {
      const { db, user } = await getContext();
      const idempotencyKey = String(payload.idempotencyKey || '').trim() || null;
      if (idempotencyKey) {
        const existing = db.idempotencyKeys.find(
          (entry) => entry.userId === user.id && entry.key === idempotencyKey
        );
        if (existing) return existing.response;
      }
      const address = db.addresses.find(
        (entry) => entry.id === payload.addressId && entry.userId === user.id
      );
      if (!address) throw apiError('ADDRESS_REQUIRED', 'Selecione ou preencha um endereço.', 422);
      const quote = await resolveQuote(payload.items);
      const orderId = crypto.randomUUID();
      const now = new Date().toISOString();
      const order = {
        id: orderId,
        userId: user.id,
        status: 'pending',
        customerName: String(payload.customer?.name || user.name).trim(),
        customerEmail: normalizeEmail(payload.customer?.email || user.email),
        customerPhone: String(payload.customer?.phone || user.phone || '').trim() || undefined,
        addressSnapshot: address,
        items: quote.items.map((item) => ({
          id: crypto.randomUUID(),
          orderId,
          productId: item.productId,
          optionName: item.optionName,
          productNameSnapshot: item.productNameSnapshot,
          unitWeightGrams: item.unitWeightGrams,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
        })),
        subtotal: quote.subtotal,
        shipping: quote.shipping,
        total: quote.total,
        productionEstimateHours: quote.productionEstimateHours,
        createdAt: now,
        updatedAt: now,
      };
      const response = {
        order: {
          id: order.id,
          status: order.status,
          items: order.items,
          subtotal: order.subtotal,
          shipping: order.shipping,
          total: order.total,
          productionEstimateHours: order.productionEstimateHours,
          createdAt: order.createdAt,
        },
      };
      db.orders.push(order);
      if (idempotencyKey)
        db.idempotencyKeys.push({ key: idempotencyKey, userId: user.id, response });
      writeDb(db);
      return response;
    },
    async listOrders() {
      const { db, user } = await getContext();
      return {
        orders: db.orders
          .filter((entry) => entry.userId === user.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      };
    },
  };
}
