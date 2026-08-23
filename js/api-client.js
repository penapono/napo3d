import { createMockBackend } from './mock-backend.js';

const MOCK_TOKEN_KEY = 'napo3d-mock-access-token';
const LEGACY_LIVE_TOKEN_KEY = 'napo3d-access-token';
const MODE_KEY = 'napo3d-backend-mode';
const API_BASE_KEY = 'napo3d-api-base-url';

let mockAccessToken = localStorage.getItem(MOCK_TOKEN_KEY) || '';
let mode = 'mock';
let implementation = null;
let initPromise = null;
let apiBaseUrl = '';

function persistToken(token) {
  mockAccessToken = token || '';
  if (mockAccessToken) localStorage.setItem(MOCK_TOKEN_KEY, mockAccessToken);
  else localStorage.removeItem(MOCK_TOKEN_KEY);
}

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function createApiError(status, payload, fallbackMessage) {
  const error = new Error(payload?.error?.message || fallbackMessage || 'Erro na API.');
  error.status = status;
  error.code = payload?.error?.code || 'API_ERROR';
  error.isApiError = true;
  return error;
}

function queryString(params = {}) {
  const entries = Object.entries(params).filter(([, value]) => value != null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...options,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw createApiError(response.status, payload, `Falha em ${pathname}`);
  return payload;
}

async function loadCatalog() {
  const response = await fetch('./data/models.json');
  if (!response.ok) throw new Error(`Falha ao carregar catálogo local (${response.status})`);
  return response.json();
}

function liveImplementation() {
  return {
    getProducts: (params) => request(`/api/products${queryString(params)}`),
    getProduct: (id) => request(`/api/products/${encodeURIComponent(id)}`),
    register: (payload) =>
      request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
    login: (payload) =>
      request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    getMe: () => request('/api/me'),
    listAddresses: () => request('/api/me/addresses'),
    createAddress: (payload) =>
      request('/api/me/addresses', { method: 'POST', body: JSON.stringify(payload) }),
    updateAddress: (addressId, payload) =>
      request(`/api/me/addresses/${encodeURIComponent(addressId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    deleteAddress: (addressId) =>
      request(`/api/me/addresses/${encodeURIComponent(addressId)}`, { method: 'DELETE' }),
    setDefaultAddress: (addressId) =>
      request(`/api/me/addresses/${encodeURIComponent(addressId)}/default`, { method: 'POST' }),
    quoteOrder: (payload) =>
      request('/api/orders/quote', { method: 'POST', body: JSON.stringify(payload) }),
    createOrder: (payload) =>
      request('/api/orders', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : {},
      }),
    listOrders: () => request('/api/me/orders'),
  };
}

function buildImplementation(selectedMode) {
  if (selectedMode === 'live') return liveImplementation();
  return createMockBackend({
    getToken: () => mockAccessToken,
    loadCatalog,
  });
}

function configuredApiBaseCandidates() {
  const explicitMeta = document.querySelector('meta[name="napo3d-api-base-url"]')?.content || '';
  const explicitGlobal = globalThis.NAPO3D_API_BASE_URL || '';
  const stored = localStorage.getItem(API_BASE_KEY) || '';
  const sameOrigin = location.origin && location.origin !== 'null' ? location.origin : '';
  const localApiBase =
    location.hostname && ['localhost', '127.0.0.1'].includes(location.hostname)
      ? `${location.protocol}//${location.hostname}:3001`
      : '';
  const candidates = [
    explicitGlobal,
    explicitMeta,
    stored,
    sameOrigin,
    localApiBase,
    'http://127.0.0.1:3001',
    'http://localhost:3001',
  ]
    .map(normalizeBaseUrl)
    .filter(Boolean);
  return [...new Set(candidates)];
}

async function probeLiveApi(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.status === 'ok';
  } finally {
    clearTimeout(timer);
  }
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const preferred = localStorage.getItem(MODE_KEY);
      const candidates = configuredApiBaseCandidates();
      let liveCandidate = '';
      for (const candidate of candidates) {
        const liveAvailable = await probeLiveApi(candidate).catch(() => false);
        if (liveAvailable) {
          liveCandidate = candidate;
          break;
        }
      }
      apiBaseUrl = liveCandidate;
      mode = liveCandidate ? 'live' : preferred || 'mock';
      implementation = buildImplementation(mode);
      if (liveCandidate) localStorage.setItem(API_BASE_KEY, liveCandidate);
      if (liveCandidate) {
        localStorage.removeItem(LEGACY_LIVE_TOKEN_KEY);
      }
      localStorage.setItem(MODE_KEY, mode);
      return mode;
    })();
  }
  return initPromise;
}

async function invoke(method, ...args) {
  await ensureInit();
  try {
    return await implementation[method](...args);
  } catch (error) {
    const liveNetworkFailure = mode === 'live' && !error?.isApiError;
    if (liveNetworkFailure) {
      mode = 'mock';
      apiBaseUrl = '';
      localStorage.removeItem(API_BASE_KEY);
      implementation = buildImplementation('mock');
      localStorage.setItem(MODE_KEY, mode);
      return implementation[method](...args);
    }
    throw error;
  }
}

function withSession(method) {
  return async (payload) => {
    const result = await invoke(method, payload);
    if (mode === 'mock' && result?.accessToken) persistToken(result.accessToken);
    return result;
  };
}

export const apiClient = {
  init: ensureInit,
  getMode: () => mode,
  getApiBaseUrl: () => apiBaseUrl,
  register: withSession('register'),
  login: withSession('login'),
  async logout() {
    await invoke('logout').catch(() => null);
    persistToken('');
  },
  async getMe() {
    if (mode === 'mock' && !mockAccessToken) return { user: null };
    try {
      return await invoke('getMe');
    } catch (error) {
      if (error.status === 401) {
        if (mode === 'mock') persistToken('');
        return { user: null };
      }
      throw error;
    }
  },
  async getProducts(params) {
    return invoke('getProducts', params);
  },
  async getProduct(id) {
    return invoke('getProduct', id);
  },
  async listAddresses() {
    return invoke('listAddresses');
  },
  async createAddress(payload) {
    return invoke('createAddress', payload);
  },
  async updateAddress(addressId, payload) {
    return invoke('updateAddress', addressId, payload);
  },
  async deleteAddress(addressId) {
    return invoke('deleteAddress', addressId);
  },
  async setDefaultAddress(addressId) {
    return invoke('setDefaultAddress', addressId);
  },
  async quoteOrder(payload) {
    return invoke('quoteOrder', payload);
  },
  async createOrder(payload) {
    return invoke('createOrder', payload);
  },
  async listOrders() {
    return invoke('listOrders');
  },
};

export const adminClient = {
  listProducts: () => request('/api/admin/products'),
  createProduct: (payload) =>
    request('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) }),
  refreshProductMakerWorld: (id) =>
    request(`/api/admin/products/${encodeURIComponent(id)}/refresh-makerworld`, {
      method: 'POST',
    }),
  enrichProductAi: (id) =>
    request(`/api/admin/products/${encodeURIComponent(id)}/enrich-ai`, {
      method: 'POST',
    }),
  updateProduct: (id, payload) =>
    request(`/api/admin/products/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteProduct: (id) =>
    request(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listOrders: (params) => request(`/api/admin/orders${queryString(params)}`),
  getOrder: (id) => request(`/api/admin/orders/${encodeURIComponent(id)}`),
  updateOrderStatus: (id, statusValue) =>
    request(`/api/admin/orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: statusValue }),
    }),
  listUsers: (params) => request(`/api/admin/users${queryString(params)}`),
  getUser: (id) => request(`/api/admin/users/${encodeURIComponent(id)}`),
  updateUser: (id, payload) =>
    request(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteUser: (id) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
