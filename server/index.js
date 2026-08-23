import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildQuote,
  normalizeUserRole,
  normalizeAddressInput,
  normalizeEmail,
  ORDER_STATUSES,
  productionTimeMinutes,
  sortProducts,
  USER_ROLES,
  validateAddressInput,
  validateProductInput,
} from '../shared/contract.js';
import { processPendingEmails, resolveMailerConfig } from './mailer.js';
import {
  hasMakerWorldOptions,
  makerWorldOptionTargets,
  mergeMakerWorldProductData,
  normalizeMakerWorldUrl,
  scrapeMakerWorldModel as runMakerWorldScraper,
} from './makerworld.js';
import { createPostgresStore, DEFAULT_DATABASE_URL } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export function createApp(options = {}) {
  const rootDir = options.rootDir || projectRoot;
  const store =
    options.store ||
    createPostgresStore({
      connectionString: options.databaseUrl || process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    });
  const catalogSeedPath = path.join(rootDir, 'data', 'models.json');
  const corsOrigins = resolveCorsOrigins(options.corsOrigins);
  const mailerConfig = options.mailerConfig || resolveMailerConfig();
  const scrapeMakerWorld =
    options.scrapeMakerWorldModel ||
    ((url) =>
      runMakerWorldScraper(normalizeMakerWorldUrl(url) || url, {
        scraperUrl: options.makerWorldScraperUrl || process.env.MAKERWORLD_SCRAPER_URL,
      }));
  const rateLimits = new Map();
  const makerWorldRefreshJobs = new Map();
  const makerWorldActiveRefreshes = new Map();

  const catalogState = {
    loadedAt: 0,
    items: [],
  };
  let seedCatalogPromise = null;

  async function seedCatalogIfNeeded() {
    const raw = await readFile(catalogSeedPath, 'utf8');
    const now = new Date().toISOString();
    const seedProducts = JSON.parse(raw).map((product) => ({
      ...product,
      createdAt: now,
      updatedAt: now,
    }));
    const result = await store.seedProductsIfEmpty(seedProducts);
    if (result.seeded) {
      console.log(`[catalog] seeded ${result.seeded} products from data/models.json`);
    }
  }

  async function ensureStoreReady() {
    await store.init?.();
    if (!seedCatalogPromise) {
      seedCatalogPromise = seedCatalogIfNeeded();
    }
    await seedCatalogPromise;
  }

  function invalidateCatalogCache() {
    catalogState.loadedAt = 0;
    catalogState.items = [];
  }

  function serializeMakerWorldJob(job) {
    if (!job) return null;
    return {
      status: job.status,
      startedAt: job.startedAt || null,
      updatedAt: job.updatedAt || null,
      finishedAt: job.finishedAt || null,
      successCount: job.successCount || 0,
      failureCount: job.failureCount || 0,
      totalCount: job.totalCount || 0,
      error: job.error || '',
    };
  }

  function setMakerWorldJob(productId, patch) {
    const current = makerWorldRefreshJobs.get(productId) || { productId };
    const next = { ...current, ...patch, productId };
    makerWorldRefreshJobs.set(productId, next);
    return next;
  }

  function withAdminProductMeta(product) {
    return {
      ...product,
      hasMakerWorldOptions: hasMakerWorldOptions(product),
      makerworldRefresh: serializeMakerWorldJob(makerWorldRefreshJobs.get(product.id)),
    };
  }

  function startMakerWorldRefresh(productId) {
    const running = makerWorldActiveRefreshes.get(productId);
    if (running) {
      return {
        alreadyRunning: true,
        job: serializeMakerWorldJob(makerWorldRefreshJobs.get(productId)),
      };
    }

    const startedAt = new Date().toISOString();
    setMakerWorldJob(productId, {
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      successCount: 0,
      failureCount: 0,
      totalCount: 0,
      error: '',
    });

    const promise = (async () => {
      try {
        const product = await store.getProduct(productId);
        if (!product) {
          const error = new Error('Produto não encontrado.');
          error.code = 'PRODUCT_NOT_FOUND';
          throw error;
        }

        const targets = makerWorldOptionTargets(product);
        if (!targets.length) {
          const error = new Error('Este produto não possui URLs do MakerWorld para atualizar.');
          error.code = 'NO_MAKERWORLD_SOURCE';
          throw error;
        }

        setMakerWorldJob(productId, {
          totalCount: targets.length,
          updatedAt: new Date().toISOString(),
        });

        const refreshes = [];
        for (const target of targets) {
          try {
            const payload = await scrapeMakerWorld(
              normalizeMakerWorldUrl(target.url) || target.url
            );
            refreshes.push({ target, payload });
          } catch (error) {
            refreshes.push({ target, error });
          }

          setMakerWorldJob(productId, {
            updatedAt: new Date().toISOString(),
            successCount: refreshes.filter((entry) => entry.payload).length,
            failureCount: refreshes.filter((entry) => entry.error).length,
          });
        }

        const successCount = refreshes.filter((entry) => entry.payload).length;
        const failureCount = refreshes.filter((entry) => entry.error).length;
        if (!successCount) {
          const firstError = refreshes.find((entry) => entry.error)?.error;
          const error = new Error(
            firstError?.message || 'Não foi possível atualizar nenhuma URL do MakerWorld.'
          );
          error.code = firstError?.code || 'MAKERWORLD_REFRESH_FAILED';
          throw error;
        }

        const patch = mergeMakerWorldProductData(product, refreshes);
        const updated = await store.updateProduct(productId, patch);
        if (!updated) {
          const error = new Error('Produto não encontrado.');
          error.code = 'PRODUCT_NOT_FOUND';
          throw error;
        }

        invalidateCatalogCache();
        const finishedAt = new Date().toISOString();
        setMakerWorldJob(productId, {
          status: 'succeeded',
          updatedAt: finishedAt,
          finishedAt,
          successCount,
          failureCount,
          totalCount: targets.length,
          error: '',
        });
      } catch (error) {
        const finishedAt = new Date().toISOString();
        setMakerWorldJob(productId, {
          status: 'failed',
          updatedAt: finishedAt,
          finishedAt,
          error: error.message || 'Falha ao atualizar dados do MakerWorld.',
        });
      } finally {
        makerWorldActiveRefreshes.delete(productId);
      }
    })();

    makerWorldActiveRefreshes.set(productId, promise);
    return {
      alreadyRunning: false,
      job: serializeMakerWorldJob(makerWorldRefreshJobs.get(productId)),
    };
  }

  async function loadCatalog() {
    if (catalogState.items.length && Date.now() - catalogState.loadedAt < 5_000) {
      return catalogState.items;
    }
    catalogState.items = await store.listProducts();
    catalogState.loadedAt = Date.now();
    return catalogState.items;
  }

  function errorResponse(request, response, status, code, message, details) {
    writeJson(response, status, { error: { code, message, details } });
  }

  function writeJson(response, status, payload) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(payload));
  }

  function writeNoContent(response) {
    response.writeHead(204);
    response.end();
  }

  function writeText(response, status, message) {
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(message);
  }

  function applyCors(request, response) {
    const origin = String(request.headers.origin || '').trim();
    if (!origin) return;
    if (corsOrigins.has('*')) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Vary', 'Origin');
      return;
    }
    if (corsOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
  }

  function applyDefaultHeaders(request, response) {
    applyCors(request, response);
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Idempotency-Key'
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }

  async function parseBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      const error = new Error('JSON inválido.');
      error.code = 'INVALID_JSON';
      throw error;
    }
  }

  function sanitizeUser(user) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: normalizeUserRole(user.role),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  function verifyPassword(password, hash) {
    const [algorithm, salt, expected] = String(hash || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  }

  function createToken() {
    return crypto.randomUUID();
  }

  function getBearerToken(request) {
    const header = request.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' ? token : null;
  }

  async function getSessionUser(request) {
    const token = getBearerToken(request);
    if (!token) return null;
    const currentStore = await store.read();
    const session = currentStore.sessions.find((entry) => entry.token === token);
    if (!session) return null;
    const user = currentStore.users.find((entry) => entry.id === session.userId);
    if (!user) return null;
    return { token, session, user, store: currentStore };
  }

  async function requireUser(request, response) {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      errorResponse(request, response, 401, 'AUTH_REQUIRED', 'Autenticação obrigatória.');
      return null;
    }
    return sessionUser;
  }

  async function requireAdmin(request, response) {
    const sessionUser = await requireUser(request, response);
    if (!sessionUser) return null;
    if (normalizeUserRole(sessionUser.user.role) !== 'admin') {
      errorResponse(request, response, 403, 'FORBIDDEN', 'Acesso restrito a administradores.');
      return null;
    }
    return sessionUser;
  }

  function checkRateLimit(key, limit, windowMs) {
    const now = Date.now();
    const bucket = rateLimits.get(key) || [];
    const nextBucket = bucket.filter((timestamp) => now - timestamp < windowMs);
    nextBucket.push(now);
    rateLimits.set(key, nextBucket);
    return nextBucket.length <= limit;
  }

  function requestIp(request) {
    return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown')
      .split(',')[0]
      .trim();
  }

  function matchesOwnAddress(addresses, userId, addressId) {
    return (
      addresses.find((address) => address.id === addressId && address.userId === userId) || null
    );
  }

  async function resolveOrderAddress(payload, userId, currentStore) {
    if (payload.addressId) {
      const address = matchesOwnAddress(currentStore.addresses, userId, payload.addressId);
      if (!address) {
        const error = new Error('Endereço obrigatório.');
        error.code = 'ADDRESS_REQUIRED';
        throw error;
      }
      return structuredClone(address);
    }

    if (payload.address) {
      const validation = validateAddressInput(payload.address);
      if (!validation.ok) {
        const error = new Error(validation.message);
        error.code = 'ADDRESS_REQUIRED';
        throw error;
      }
      return {
        ...validation.address,
        id: crypto.randomUUID(),
        userId,
        isDefault: false,
      };
    }

    const fallback = currentStore.addresses.find(
      (address) => address.userId === userId && address.isDefault
    );
    if (!fallback) {
      const error = new Error('Endereço obrigatório.');
      error.code = 'ADDRESS_REQUIRED';
      throw error;
    }
    return structuredClone(fallback);
  }

  async function buildOrderQuote(items) {
    const catalog = await loadCatalog();
    const productsById = new Map(catalog.map((item) => [item.id, item]));
    return buildQuote(items, (productId) => productsById.get(productId));
  }

  async function queueEmails(currentStore, order) {
    currentStore.emails.push(
      {
        id: crypto.randomUUID(),
        type: 'internal_order',
        to: mailerConfig.orderRecipient,
        orderId: order.id,
        createdAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: 'customer_confirmation',
        to: order.customerEmail,
        orderId: order.id,
        createdAt: new Date().toISOString(),
      }
    );
  }

  async function handleApi(request, response, pathname) {
    await ensureStoreReady();

    if (request.method === 'GET' && pathname === '/api/health') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/products') {
      const catalog = await loadCatalog();
      const url = new URL(request.url, 'http://localhost');
      const query = String(url.searchParams.get('query') || '')
        .trim()
        .toLowerCase();
      const category = String(url.searchParams.get('category') || '').trim();
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const limit = Math.min(48, Math.max(1, Number(url.searchParams.get('limit')) || 12));
      const sort = String(url.searchParams.get('sort') || 'recommended');

      const filtered = sortProducts(
        catalog.filter((product) => {
          if (category && category !== 'all' && product.category !== category) return false;
          if (!query) return true;
          const haystack =
            `${product.name} ${product.category} ${product.summary || ''} ${(product.options || []).map((option) => `${option.name} ${option.colors || ''}`).join(' ')}`.toLowerCase();
          return haystack.includes(query);
        }),
        sort
      );

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const offset = (page - 1) * limit;
      writeJson(response, 200, {
        items: filtered.slice(offset, offset + limit),
        pagination: { page, limit, total, totalPages },
      });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/products/')) {
      const catalog = await loadCatalog();
      const productId = decodeURIComponent(pathname.split('/').pop());
      const product = catalog.find((entry) => entry.id === productId);
      if (!product) {
        errorResponse(request, response, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
        return;
      }
      writeJson(response, 200, { product });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/products') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const products = await loadCatalog();
      writeJson(response, 200, {
        products: sortProducts(products.map(withAdminProductMeta), 'name'),
      });
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
      const product = {
        id: crypto.randomUUID(),
        ...validation.product,
        createdAt: now,
        updatedAt: now,
      };
      await store.createProduct(product);
      invalidateCatalogCache();
      writeJson(response, 201, { product });
      return;
    }

    if (
      request.method === 'POST' &&
      pathname.endsWith('/refresh-makerworld') &&
      pathname.startsWith('/api/admin/products/')
    ) {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const productId = decodeURIComponent(pathname.split('/')[4] || '');
      const product = await store.getProduct(productId);
      if (!product) {
        errorResponse(request, response, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
        return;
      }
      if (!hasMakerWorldOptions(product)) {
        errorResponse(
          request,
          response,
          422,
          'NO_MAKERWORLD_SOURCE',
          'Este produto não possui URLs do MakerWorld para atualizar.'
        );
        return;
      }
      const refresh = startMakerWorldRefresh(productId);
      writeJson(response, 202, {
        job: refresh.job,
        product: withAdminProductMeta(product),
      });
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
      writeJson(response, 200, { product: withAdminProductMeta(product) });
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

    if (request.method === 'POST' && pathname === '/api/auth/register') {
      const ip = requestIp(request);
      if (!checkRateLimit(`register:${ip}`, 10, 15 * 60 * 1000)) {
        errorResponse(request, response, 429, 'RATE_LIMITED', 'Tente novamente em alguns minutos.');
        return;
      }
      const body = await parseBody(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!body.name || !email || password.length < 8) {
        errorResponse(
          request,
          response,
          422,
          'INVALID_INPUT',
          'Nome, e-mail e senha válida são obrigatórios.'
        );
        return;
      }
      const createdAt = new Date().toISOString();
      const user = {
        id: crypto.randomUUID(),
        name: String(body.name).trim(),
        email,
        phone: String(body.phone || '').trim() || undefined,
        passwordHash: passwordHash(password),
        role: 'customer',
        createdAt,
        updatedAt: createdAt,
      };

      const token = createToken();
      await store.update((currentStore) => {
        if (currentStore.users.some((entry) => entry.email === email)) {
          const error = new Error('E-mail já cadastrado.');
          error.code = 'EMAIL_TAKEN';
          throw error;
        }
        currentStore.users.push(user);
        currentStore.sessions.push({ token, userId: user.id, createdAt });
        return currentStore;
      });
      writeJson(response, 201, { user: sanitizeUser(user), accessToken: token });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/auth/login') {
      const ip = requestIp(request);
      if (!checkRateLimit(`login:${ip}`, 20, 15 * 60 * 1000)) {
        errorResponse(request, response, 429, 'RATE_LIMITED', 'Tente novamente em alguns minutos.');
        return;
      }
      const body = await parseBody(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const currentStore = await store.read();
      const user = currentStore.users.find((entry) => entry.email === email);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        errorResponse(request, response, 401, 'INVALID_CREDENTIALS', 'Credenciais inválidas.');
        return;
      }
      const token = createToken();
      await store.update((nextStore) => {
        nextStore.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
        return nextStore;
      });
      writeJson(response, 200, { user: sanitizeUser(user), accessToken: token });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/auth/logout') {
      const token = getBearerToken(request);
      if (!token) {
        writeNoContent(response);
        return;
      }
      await store.update((currentStore) => {
        currentStore.sessions = currentStore.sessions.filter((entry) => entry.token !== token);
        return currentStore;
      });
      writeNoContent(response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/me') {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      writeJson(response, 200, { user: sanitizeUser(sessionUser.user) });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/me/addresses') {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const addresses = sessionUser.store.addresses.filter(
        (entry) => entry.userId === sessionUser.user.id
      );
      writeJson(response, 200, { addresses });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/me/addresses') {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const body = await parseBody(request);
      const validation = validateAddressInput(body);
      if (!validation.ok) {
        errorResponse(request, response, 422, validation.code, validation.message);
        return;
      }

      const now = new Date().toISOString();
      const address = {
        id: crypto.randomUUID(),
        userId: sessionUser.user.id,
        ...validation.address,
        isDefault: Boolean(body.isDefault),
      };

      await store.update((currentStore) => {
        const existing = currentStore.addresses.filter(
          (entry) => entry.userId === sessionUser.user.id
        );
        if (!existing.length) address.isDefault = true;
        if (address.isDefault) {
          currentStore.addresses = currentStore.addresses.map((entry) =>
            entry.userId === sessionUser.user.id ? { ...entry, isDefault: false } : entry
          );
        }
        currentStore.addresses.push({ ...address, createdAt: now, updatedAt: now });
        return currentStore;
      });
      writeJson(response, 201, { address: { ...address, createdAt: now, updatedAt: now } });
      return;
    }

    if (request.method === 'PATCH' && pathname.startsWith('/api/me/addresses/')) {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const addressId = decodeURIComponent(pathname.split('/').pop());
      const body = await parseBody(request);
      let updatedAddress = null;
      await store.update((currentStore) => {
        const currentAddress = matchesOwnAddress(
          currentStore.addresses,
          sessionUser.user.id,
          addressId
        );
        if (!currentAddress) {
          const error = new Error('Endereço não encontrado.');
          error.code = 'ADDRESS_NOT_FOUND';
          throw error;
        }
        const merged = normalizeAddressInput({ ...currentAddress, ...body });
        const validation = validateAddressInput(merged);
        if (!validation.ok) {
          const error = new Error(validation.message);
          error.code = validation.code;
          throw error;
        }
        updatedAddress = {
          ...currentAddress,
          ...validation.address,
          updatedAt: new Date().toISOString(),
        };
        currentStore.addresses = currentStore.addresses.map((entry) =>
          entry.id === currentAddress.id ? updatedAddress : entry
        );
        return currentStore;
      });
      writeJson(response, 200, { address: updatedAddress });
      return;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/api/me/addresses/')) {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const addressId = decodeURIComponent(pathname.split('/').pop());
      await store.update((currentStore) => {
        const target = matchesOwnAddress(currentStore.addresses, sessionUser.user.id, addressId);
        if (!target) {
          const error = new Error('Endereço não encontrado.');
          error.code = 'ADDRESS_NOT_FOUND';
          throw error;
        }
        currentStore.addresses = currentStore.addresses.filter((entry) => entry.id !== target.id);
        const ownAddresses = currentStore.addresses.filter(
          (entry) => entry.userId === sessionUser.user.id
        );
        if (target.isDefault && ownAddresses.length) {
          ownAddresses[0].isDefault = true;
        }
        return currentStore;
      });
      writeNoContent(response);
      return;
    }

    if (
      request.method === 'POST' &&
      pathname.endsWith('/default') &&
      pathname.startsWith('/api/me/addresses/')
    ) {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const [, , , , addressId] = pathname.split('/');
      let defaultAddress = null;
      await store.update((currentStore) => {
        const target = matchesOwnAddress(currentStore.addresses, sessionUser.user.id, addressId);
        if (!target) {
          const error = new Error('Endereço não encontrado.');
          error.code = 'ADDRESS_NOT_FOUND';
          throw error;
        }
        currentStore.addresses = currentStore.addresses.map((entry) => {
          if (entry.userId !== sessionUser.user.id) return entry;
          const next = {
            ...entry,
            isDefault: entry.id === target.id,
            updatedAt: new Date().toISOString(),
          };
          if (next.isDefault) defaultAddress = next;
          return next;
        });
        return currentStore;
      });
      writeJson(response, 200, { address: defaultAddress });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/orders/quote') {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const body = await parseBody(request);
      const addressId = body.addressId;
      const address = addressId
        ? matchesOwnAddress(sessionUser.store.addresses, sessionUser.user.id, addressId)
        : body.address
          ? normalizeAddressInput(body.address)
          : null;
      if (!address) {
        errorResponse(
          request,
          response,
          422,
          'ADDRESS_REQUIRED',
          'Selecione ou preencha um endereço.'
        );
        return;
      }
      const quote = await buildOrderQuote(body.items);
      writeJson(response, 200, { quote });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/orders') {
      const ip = requestIp(request);
      if (!checkRateLimit(`orders:${ip}`, 30, 15 * 60 * 1000)) {
        errorResponse(request, response, 429, 'RATE_LIMITED', 'Tente novamente em alguns minutos.');
        return;
      }
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const body = await parseBody(request);
      const idempotencyKey = String(request.headers['idempotency-key'] || '').trim() || null;

      try {
        const currentStore = await store.read();
        if (idempotencyKey) {
          const previous = currentStore.idempotencyKeys.find(
            (entry) => entry.userId === sessionUser.user.id && entry.key === idempotencyKey
          );
          if (previous) {
            writeJson(response, 201, previous.response);
            return;
          }
        }

        const addressSnapshot = await resolveOrderAddress(body, sessionUser.user.id, currentStore);
        const quote = await buildOrderQuote(body.items);
        const now = new Date().toISOString();
        const orderId = crypto.randomUUID();
        const customer = {
          name: String(
            body.customer?.name || sessionUser.user.name || addressSnapshot.recipientName || ''
          ).trim(),
          email: normalizeEmail(body.customer?.email || sessionUser.user.email),
          phone: String(body.customer?.phone || sessionUser.user.phone || '').trim() || undefined,
        };

        if (!customer.name || !customer.email) {
          errorResponse(
            request,
            response,
            422,
            'INVALID_CUSTOMER',
            'Dados do cliente incompletos.'
          );
          return;
        }

        const order = {
          id: orderId,
          userId: sessionUser.user.id,
          status: 'pending',
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          addressSnapshot,
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
          notes: String(body.notes || '').trim() || undefined,
          createdAt: now,
          updatedAt: now,
        };

        const responsePayload = {
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

        await store.update((nextStore) => {
          nextStore.orders.push(order);
          if (idempotencyKey) {
            nextStore.idempotencyKeys.push({
              id: crypto.randomUUID(),
              key: idempotencyKey,
              userId: sessionUser.user.id,
              orderId: order.id,
              response: responsePayload,
              createdAt: now,
            });
          }
          queueEmails(nextStore, order);
          return nextStore;
        });

        processPendingEmails(store, { config: mailerConfig }).catch((error) => {
          console.error('[mailer] send failed', error);
        });

        writeJson(response, 201, responsePayload);
      } catch (error) {
        if (error.code === 'ADDRESS_REQUIRED') {
          errorResponse(request, response, 422, 'ADDRESS_REQUIRED', error.message);
          return;
        }
        throw error;
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/me/orders') {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const orders = sessionUser.store.orders
        .filter((entry) => entry.userId === sessionUser.user.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      writeJson(response, 200, { orders });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/me/orders/')) {
      const sessionUser = await requireUser(request, response);
      if (!sessionUser) return;
      const orderId = decodeURIComponent(pathname.split('/').pop());
      const order = sessionUser.store.orders.find(
        (entry) => entry.id === orderId && entry.userId === sessionUser.user.id
      );
      if (!order) {
        errorResponse(request, response, 404, 'ORDER_NOT_FOUND', 'Pedido não encontrado.');
        return;
      }
      writeJson(response, 200, { order });
      return;
    }

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
        errorResponse(
          request,
          response,
          422,
          'INVALID_STATUS',
          `Status inválido. Use um de: ${ORDER_STATUSES.join(', ')}.`
        );
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
        nextStore.orders = nextStore.orders.map((entry) =>
          entry.id === orderId ? updatedOrder : entry
        );
        return nextStore;
      });
      writeJson(response, 200, { order: updatedOrder });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/users') {
      const admin = await requireAdmin(request, response);
      if (!admin) return;
      const url = new URL(request.url, 'http://localhost');
      const query = String(url.searchParams.get('query') || '')
        .trim()
        .toLowerCase();
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
          errorResponse(
            request,
            response,
            422,
            'INVALID_ROLE',
            `Papel inválido. Use um de: ${USER_ROLES.join(', ')}.`
          );
          return;
        }
        if (userId === admin.user.id && body.role !== admin.user.role) {
          errorResponse(
            request,
            response,
            422,
            'CANNOT_CHANGE_OWN_ROLE',
            'Você não pode alterar seu próprio papel.'
          );
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
          updatedAt: new Date().toISOString(),
        };
        nextStore.users = nextStore.users.map((entry) =>
          entry.id === userId ? updatedUser : entry
        );
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
        errorResponse(
          request,
          response,
          422,
          'CANNOT_DELETE_SELF',
          'Você não pode excluir a própria conta por aqui.'
        );
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
        nextStore.idempotencyKeys = nextStore.idempotencyKeys.filter(
          (entry) => entry.userId !== userId
        );
        nextStore.orders = nextStore.orders.map((entry) =>
          entry.userId === userId ? { ...entry, userId: undefined } : entry
        );
        return nextStore;
      });
      writeNoContent(response);
      return;
    }

    errorResponse(request, response, 404, 'NOT_FOUND', 'Rota não encontrada.');
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url || '/', 'http://localhost');
    try {
      applyDefaultHeaders(request, response);
      if (request.method === 'OPTIONS') {
        writeNoContent(response);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url.pathname);
        return;
      }
      writeText(response, 404, 'napo3d API server: use /api/*');
    } catch (error) {
      if (error.code === 'INVALID_JSON') {
        errorResponse(request, response, 400, 'INVALID_JSON', error.message);
        return;
      }
      if (error.code === 'EMAIL_TAKEN') {
        errorResponse(request, response, 409, 'EMAIL_TAKEN', error.message);
        return;
      }
      if (error.code === 'ADDRESS_NOT_FOUND') {
        errorResponse(request, response, 404, error.code, error.message);
        return;
      }
      if (error.code && String(error.code).startsWith('INVALID_')) {
        errorResponse(request, response, 422, error.code, error.message);
        return;
      }
      if (error.code && String(error.code).endsWith('_NOT_FOUND')) {
        errorResponse(request, response, 404, error.code, error.message);
        return;
      }
      console.error('[server] unexpected error', error);
      errorResponse(request, response, 500, 'INTERNAL_ERROR', 'Erro interno do servidor.');
    }
  }

  const server = createServer(handleRequest);

  server.inject = async function inject({
    method = 'GET',
    path: requestPath = '/',
    headers = {},
    body = null,
  } = {}) {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value])
    );
    const chunks =
      body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];

    const request = {
      method,
      url: requestPath,
      headers: normalizedHeaders,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    let statusCode = 200;
    let responseHeaders = {};
    const responseChunks = [];

    const response = {
      setHeader(name, value) {
        responseHeaders[name] = value;
      },
      writeHead(status, nextHeaders = {}) {
        statusCode = status;
        responseHeaders = { ...responseHeaders, ...nextHeaders };
      },
      end(chunk = '') {
        if (chunk) responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      },
    };

    await handleRequest(request, response);

    const text = Buffer.concat(responseChunks).toString('utf8');
    let json = null;
    if (
      (responseHeaders['Content-Type'] || responseHeaders['content-type'] || '').includes(
        'application/json'
      ) &&
      text
    ) {
      json = JSON.parse(text);
    }

    return { statusCode, headers: responseHeaders, text, json };
  };

  server.start = async function start(
    port = Number(process.env.PORT || 3001),
    host = process.env.HOST || '127.0.0.1'
  ) {
    await ensureStoreReady();
    const mailerWorker = setInterval(() => {
      processPendingEmails(store, { config: mailerConfig }).catch((error) => {
        console.error('[mailer] worker error', error);
      });
    }, 30_000);
    mailerWorker.unref?.();
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
    });
  };

  server.store = store;

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.start().then(() => {
    const address = app.address();
    const port = typeof address === 'object' && address ? address.port : process.env.PORT || 3001;
    console.log(`napo3d api listening on http://localhost:${port}`);
  });
}

function resolveCorsOrigins(input) {
  if (Array.isArray(input) && input.length)
    return new Set(input.map((origin) => String(origin).trim()).filter(Boolean));
  const envOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(envOrigins.length ? envOrigins : DEFAULT_CORS_ORIGINS);
}
