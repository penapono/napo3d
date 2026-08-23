import {
  lineProductionMinutes,
  normalizePostalCode,
  sortProducts,
  unitPriceFromWeight,
  weightInGrams,
} from '../shared/contract.js';
import { primaryProductOption } from '../shared/catalog.js';
import { apiClient } from './api-client.js';

const copy = {
  Organização: 'Mais ordem e leveza para a sua rotina.',
  Casa: 'Um detalhe especial para deixar seu espaço mais bonito.',
  Presentes: 'Um presente criativo, útil e cheio de personalidade.',
  Diversão: 'Uma peça divertida para brincar, relaxar e colecionar.',
  Escritório: 'Mais praticidade e personalidade para a sua mesa.',
  Acessórios: 'Um detalhe funcional para acompanhar o seu dia.',
  Aviação: 'Uma peça marcante para quem ama design e aviação.',
  Embalagem: 'Uma apresentação especial para tornar cada entrega inesquecível.',
  Fidget: 'Uma pausa gostosa para as mãos e para a mente.',
  Utilitário: 'Uma solução inteligente para facilitar sua rotina.',
  'Identidade visual': 'Uma peça exclusiva para destacar a sua marca.',
  'Brinde inteligente / NFC': 'Um brinde memorável que aproxima sua marca das pessoas.',
};

const localImages = { 'Porta-copos': './assets/images/porta-copos.png' };

const state = {
  items: [],
  categories: [],
  catalogTotal: 0,
  query: '',
  category: 'all',
  sort: 'recommended',
  page: 1,
  perPage: 6,
  totalPages: 1,
  cart: loadCart(),
  me: null,
  addresses: [],
  orders: [],
  authMode: 'login',
  editingAddressId: null,
  selectedAddressId: null,
  quote: null,
  pendingItem: null,
  backendMode: 'mock',
};

const ROUTE_PATHS = {
  home: '/',
  cart: '/carrinho',
  account: '/minha-conta',
  shipping: '/endereco',
};
const LEGACY_ROUTE_MAP = {
  cart: 'cart',
  account: 'account',
  shipping: 'shipping',
};
const POST_AUTH_ROUTE_KEY = 'napo3d-post-auth-route';

const $ = (selector) => document.querySelector(selector);
const normalizePathname = (pathname) => {
  const normalized = String(pathname || '').trim() || '/';
  if (normalized === '/index.html') return '/';
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};
const pathForPage = (page) => ROUTE_PATHS[page] || ROUTE_PATHS.home;
const pageForPathname = (pathname) => {
  const normalized = normalizePathname(pathname);
  if (normalized === ROUTE_PATHS.home) return null;
  return (
    Object.entries(ROUTE_PATHS).find(
      ([page, candidate]) => page !== 'home' && candidate === normalized
    )?.[0] || null
  );
};
const currentPage = () => pageForPathname(location.pathname);
const money = (value) =>
  Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
  });
const text = (value) =>
  value == null || value === ''
    ? ''
    : String(value).replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
      );
const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  return [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    mins || (!days && !hours) ? `${mins}m` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function formatTierProductionTime(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) return `> ${mins}min`;
  if (!mins) return `> ${hours}h`;
  return `> ${hours}h ${mins}min`;
}

function loadCart() {
  try {
    const cart = JSON.parse(localStorage.getItem('napo3d-cart') || '[]');
    return Array.isArray(cart) ? cart : [];
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem('napo3d-cart', JSON.stringify(state.cart));
}

function setStatus(selector, message, tone = '') {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || '';
  node.dataset.tone = tone;
}

function formatPhone(value) {
  const digits = String(value || '')
    .replace(/\D/g, '')
    .slice(0, 11);
  if (digits.length <= 2) return digits ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function isValidEmail(value) {
  return VALID_EMAIL_REGEX.test(String(value || '').trim());
}

function storePostAuthPage(page) {
  if (!page) return;
  sessionStorage.setItem(POST_AUTH_ROUTE_KEY, pathForPage(page));
}

function consumePostAuthPath() {
  const path = sessionStorage.getItem(POST_AUTH_ROUTE_KEY) || '';
  sessionStorage.removeItem(POST_AUTH_ROUTE_KEY);
  return path;
}

function navigateTo(page = null, options = {}) {
  const hash = options.hash ? `#${String(options.hash).replace(/^#/, '')}` : '';
  const nextPath = pathForPage(page);
  const nextUrl = `${nextPath}${hash}`;
  if (`${location.pathname}${location.hash}` !== nextUrl) {
    history[options.replace ? 'replaceState' : 'pushState']({}, '', nextUrl);
  }
  renderStorePage();
  if (page === 'shipping') refreshQuote().catch(console.error);
  if (page) {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    return;
  }
  if (hash) {
    requestAnimationFrame(() => {
      document.querySelector(hash)?.scrollIntoView({ block: 'start' });
    });
  }
}

function redirect(page, params = {}) {
  if (params.next) storePostAuthPage(params.next);
  navigateTo(page, { hash: params.hash || '' });
}

function normalizeInitialLocation() {
  const url = new URL(window.location.href);
  const legacyPage = LEGACY_ROUTE_MAP[url.searchParams.get('page') || ''];
  const legacyNext = LEGACY_ROUTE_MAP[url.searchParams.get('next') || ''];
  if (legacyNext) storePostAuthPage(legacyNext);
  if (!legacyPage && normalizePathname(url.pathname) !== '/index.html') return;
  const nextPage = legacyPage || currentPage();
  history.replaceState({}, '', `${pathForPage(nextPage)}${url.hash}`);
}

function productImage(item, option) {
  const local = localImages[item.name.trim()];
  const galleryPrimary = Array.isArray(option.imageGallery) ? option.imageGallery[0] : '';
  const candidate = option.imageUrl || galleryPrimary;
  const candidateIsLocal = candidate && candidate.startsWith('assets/images/');
  return {
    primary: local || candidate,
    fallback: local ? candidate : candidateIsLocal ? option.imageUrl || '' : '',
  };
}

function image(url, alt, fallbackUrl = '') {
  if (!url) return '<div class="image-fallback">Imagem<br>indisponível</div>';
  const fallback =
    fallbackUrl && fallbackUrl !== url
      ? `this.onerror=function(){this.hidden=true;this.nextElementSibling.hidden=false};this.src='${text(fallbackUrl)}'`
      : 'this.hidden=true;this.nextElementSibling.hidden=false';
  return `<img src="${text(url)}" alt="${text(alt)}" loading="lazy" onerror="${fallback}"><div class="image-fallback" hidden>Imagem indisponível</div>`;
}

function findProduct(productId) {
  return state.items.find((item) => item.id === productId) || null;
}

function cartLine(entry) {
  const item = findProduct(entry.productId);
  const option = primaryProductOption(item);
  if (!item || !option) return null;
  const unitPrice = unitPriceFromWeight(weightInGrams(option), entry.quantity) || 0;
  return {
    item,
    option,
    quantity: entry.quantity,
    label: item.name,
    unitPrice,
    lineTotal: unitPrice * entry.quantity,
    productionMinutes: lineProductionMinutes(item, entry.quantity, option),
  };
}

function cartSummary() {
  const lines = state.cart.map(cartLine).filter(Boolean);
  return {
    lines,
    count: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: lines.reduce((sum, line) => sum + line.lineTotal, 0),
    productionMinutes: lines.reduce((sum, line) => sum + line.productionMinutes, 0),
  };
}

function ratingMarkup(option) {
  const rating = Number(option?.rating);
  if (!Number.isFinite(rating) || rating <= 0) return '';
  const ratingCount = Number(option?.ratingCount);
  const ratingLabel = rating.toFixed(1).replace('.', ',');
  const countLabel =
    Number.isFinite(ratingCount) && ratingCount > 0
      ? `${ratingCount.toLocaleString('pt-BR')} avaliações`
      : 'sem total informado';
  const width = `${Math.max(0, Math.min(100, (rating / 5) * 100))}%`;
  return `<div class="product-rating" aria-label="Avaliação ${text(ratingLabel)} de 5 com ${text(countLabel)}"><span class="product-rating-stars" style="--rating-width:${text(width)}"><span aria-hidden="true">★★★★★</span></span><span class="product-rating-value">${text(ratingLabel)}</span>${Number.isFinite(ratingCount) && ratingCount > 0 ? `<span class="product-rating-count">(${text(ratingCount.toLocaleString('pt-BR'))})</span>` : ''}</div>`;
}

function cardAction(item, option) {
  if (state.me?.role === 'admin' && option?.url) {
    return `<a class="quote-button add-to-cart icon-action" href="${text(option.url)}" target="_blank" rel="noreferrer noopener" aria-label="Abrir ${text(item.name)} no MakerWorld" title="Abrir no MakerWorld"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="sr-only">Abrir no MakerWorld</span></a>`;
  }
  return `<button class="quote-button add-to-cart icon-action" type="button" data-product-id="${text(item.id)}" aria-label="Adicionar ${text(item.name)} ao carrinho" title="Adicionar ao carrinho"><i class="fa-solid fa-cart-plus" aria-hidden="true"></i><span class="sr-only">Adicionar ao carrinho</span></button>`;
}

function card(item) {
  const option = primaryProductOption(item);
  if (!option) return '';
  const description =
    item.summary ||
    item.description ||
    copy[item.category] ||
    'Uma peça especial, feita para fazer parte da sua rotina.';
  const imageSource = productImage(item, option);
  const tierPrices = [
    { label: 'Até 50 un.', quantity: 1 },
    { label: '51 a 100 un.', quantity: 51 },
    { label: 'Mais de 100 un.', quantity: 101 },
  ]
    .map(
      (tier) =>
        `<div class="tier-price"><span>${tier.label}</span><strong>${money(unitPriceFromWeight(weightInGrams(option), tier.quantity))}</strong><small class="tier-production-time">${text(formatTierProductionTime(lineProductionMinutes(item, tier.quantity, option)))}</small><small>por peça</small></div>`
    )
    .join('');
  return `<article class="product-card"><div class="product-image">${image(imageSource.primary, item.name, imageSource.fallback)}<span class="product-tag">${text(item.category)}</span></div><div class="product-info"><h3>${text(item.name)}</h3>${ratingMarkup(option)}<p class="variant-name">${text(description)}</p><div class="tier-prices" aria-label="Preços por quantidade">${tierPrices}</div>${cardAction(item, option)}</div></article>`;
}

async function refreshCatalog() {
  const requestedPage = state.page;
  const result = await apiClient.getProducts({
    limit: state.perPage,
    page: requestedPage,
    sort: state.sort,
    category: state.category,
    query: state.query.trim(),
  });
  const totalPages = Math.max(1, Number(result.pagination?.totalPages) || 1);
  if (requestedPage > totalPages) {
    state.page = totalPages;
    return refreshCatalog();
  }
  state.items = Array.isArray(result.items) ? result.items : [];
  state.categories = Array.isArray(result.categories) ? result.categories : [];
  state.catalogTotal = Number(result.pagination?.total) || state.items.length;
  state.totalPages = totalPages;
  state.page = requestedPage;
}

function renderPagination() {
  const pagination = $('#pagination');
  if (!pagination) return;
  if (state.catalogTotal <= state.perPage) {
    pagination.innerHTML = '';
    return;
  }
  pagination.innerHTML = `<button class="page-button page-button-icon" type="button" data-page="prev" aria-label="Página anterior" ${state.page === 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>${Array.from({ length: state.totalPages }, (_, index) => `<button class="page-button${state.page === index + 1 ? ' active' : ''}" type="button" data-page="${index + 1}">${index + 1}</button>`).join('')}<button class="page-button page-button-icon" type="button" data-page="next" aria-label="Próxima página" ${state.page === state.totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
  pagination.querySelectorAll('.page-button').forEach((button) =>
    button.addEventListener('click', async () => {
      const target = button.dataset.page;
      state.page =
        target === 'prev' ? state.page - 1 : target === 'next' ? state.page + 1 : Number(target);
      await refreshCatalog();
      renderCategories();
      renderCatalog();
      $('#catalogo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );
}

function renderCatalog() {
  const grid = $('#catalog-grid');
  if (!grid) return;
  grid.innerHTML = state.items.map(card).join('');
  $('#empty-state').hidden = state.items.length > 0;
  renderPagination();
  grid
    .querySelectorAll('.add-to-cart')
    .forEach((button) =>
      button.addEventListener('click', () => openQuantityDialog(button.dataset.productId))
    );
}

function renderCart() {
  const summary = cartSummary();
  saveCart();
  ['#cart-count', '#cart-count-top'].forEach((selector) => {
    const node = $(selector);
    if (node) node.textContent = String(summary.count);
  });
  if ($('#cart-items')) {
    $('#cart-items').innerHTML = summary.lines.length
      ? summary.lines
          .map(
            (line, index) =>
              `<div class="cart-item"><div><strong>${text(line.label)}</strong><span>${money(line.unitPrice)} por peça · ${line.quantity} un.</span></div><div class="cart-controls"><button type="button" data-cart-action="decrease" data-cart-index="${index}" aria-label="Diminuir quantidade"><i class="fa-solid fa-minus" aria-hidden="true"></i></button><span>${line.quantity}</span><button type="button" data-cart-action="increase" data-cart-index="${index}" aria-label="Aumentar quantidade"><i class="fa-solid fa-plus" aria-hidden="true"></i></button><button type="button" data-cart-action="remove" data-cart-index="${index}">Remover</button></div></div>`
          )
          .join('')
      : '<p class="cart-empty">Seu carrinho está vazio.</p>';
  }
  $('#cart-total') && ($('#cart-total').textContent = money(summary.subtotal));
  $('#production-total') &&
    ($('#production-total').textContent = formatDuration(summary.productionMinutes));
  if ($('#page-cart-items')) {
    $('#page-cart-items').innerHTML = summary.lines.length
      ? summary.lines
          .map(
            (line, index) =>
              `<div class="page-cart-item"><div><strong>${text(line.label)}</strong><span>${line.quantity} un. · ${money(line.unitPrice)} por peça</span></div><div class="cart-controls"><button type="button" data-page-cart="decrease" data-index="${index}" aria-label="Diminuir quantidade"><i class="fa-solid fa-minus" aria-hidden="true"></i></button><span>${line.quantity}</span><button type="button" data-page-cart="increase" data-index="${index}" aria-label="Aumentar quantidade"><i class="fa-solid fa-plus" aria-hidden="true"></i></button><button type="button" data-page-cart="remove" data-index="${index}">Remover</button></div></div>`
          )
          .join('')
      : '<p class="cart-empty">Seu carrinho está vazio.</p>';
  }
  $('#page-cart-total') && ($('#page-cart-total').textContent = money(summary.subtotal));
  $('#page-production-total') &&
    ($('#page-production-total').textContent = formatDuration(summary.productionMinutes));
}

function openQuantityDialog(productId) {
  const item = findProduct(productId);
  const option = primaryProductOption(item);
  if (!item || !option) return;
  state.pendingItem = { item, option };
  const source = productImage(item, option);
  $('#quantity-title').textContent = item.name;
  $('#quantity-description').textContent = item.description || item.summary || option.name || '';
  $('#quantity-image').src = source.primary;
  $('#quantity-image').alt = item.name;
  renderQuantityGallery(option);
  $('#quantity-input').value = 1;
  updateQuantityPreview();
  $('#quantity-dialog').showModal();
}

function renderQuantityGallery(option) {
  const node = $('#quantity-gallery');
  if (!node) return;
  const gallery = Array.isArray(option?.imageGallery) ? option.imageGallery.filter(Boolean) : [];
  if (gallery.length <= 1) {
    node.hidden = true;
    node.innerHTML = '';
    return;
  }
  node.hidden = false;
  node.innerHTML = gallery
    .map(
      (url, index) =>
        `<button class="quantity-gallery-thumb${index === 0 ? ' is-active' : ''}" type="button" data-quantity-image="${text(url)}" aria-label="Ver imagem ${index + 1}"><img src="${text(url)}" alt="Imagem ${index + 1} da peça" loading="lazy" /></button>`
    )
    .join('');
  node.querySelectorAll('[data-quantity-image]').forEach((button) => {
    button.addEventListener('click', () => {
      node
        .querySelectorAll('.quantity-gallery-thumb')
        .forEach((thumb) => thumb.classList.toggle('is-active', thumb === button));
      $('#quantity-image').src = button.dataset.quantityImage;
    });
  });
}

function updateQuantityPreview() {
  if (!state.pendingItem) return;
  const quantity = Math.max(1, Number($('#quantity-input').value) || 1);
  $('#quantity-input').value = quantity;
  const unitPrice = unitPriceFromWeight(weightInGrams(state.pendingItem.option), quantity) || 0;
  $('#quantity-unit-price').textContent = money(unitPrice);
  $('#quantity-total-price').textContent = `Total: ${money(unitPrice * quantity)}`;
  $('#quantity-production-time').textContent = `Produção estimada: ${formatDuration(
    lineProductionMinutes(state.pendingItem.item, quantity, state.pendingItem.option)
  )}`;
}

function addToCart(productId, quantity) {
  const item = findProduct(productId);
  const optionName = primaryProductOption(item)?.name || item?.name || '';
  const existing = state.cart.find(
    (entry) => entry.productId === productId && entry.optionName === optionName
  );
  if (existing) existing.quantity += quantity;
  else state.cart.push({ productId, optionName, quantity });
  renderCart();
  $('#cart-panel')?.classList.add('open');
}

function updateCart(index, action) {
  const entry = state.cart[index];
  if (!entry) return;
  if (action === 'increase') entry.quantity += 1;
  if (action === 'decrease') entry.quantity = Math.max(1, entry.quantity - 1);
  if (action === 'remove') state.cart.splice(index, 1);
  renderCart();
  if (currentPage() === 'shipping') refreshQuote().catch(console.error);
}

function renderHeader() {
  const adminLink = $('#admin-open');
  if (!adminLink) return;
  adminLink.hidden = state.me?.role !== 'admin';
}

async function refreshSession() {
  const result = await apiClient.getMe();
  state.me = result.user || null;
}

async function loadProducts() {
  await refreshCatalog();
}

async function loadUserData() {
  if (!state.me) {
    state.addresses = [];
    state.orders = [];
    return;
  }
  const [addresses, orders] = await Promise.all([
    apiClient.listAddresses(),
    apiClient.listOrders(),
  ]);
  state.addresses = addresses.addresses || [];
  state.orders = orders.orders || [];
  if (!state.selectedAddressId) {
    state.selectedAddressId =
      state.addresses.find((address) => address.isDefault)?.id || state.addresses[0]?.id || null;
  }
}

function renderCategories() {
  const node = $('#category-filters');
  if (!node) return;
  const categories = state.categories.length
    ? state.categories
    : [...new Set(state.items.map((item) => item.category).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, 'pt-BR'))
        .map((name) => ({
          name,
          count: state.items.filter((item) => item.category === name).length,
        }));
  node.innerHTML =
    `<button class="pill${state.category === 'all' ? ' active' : ''}" data-category="all">Tudo (${text(state.catalogTotal)})</button>` +
    categories
      .map(
        (category) =>
          `<button class="pill${state.category === category.name ? ' active' : ''}" data-category="${text(category.name)}">${text(category.name)} (${text(category.count)})</button>`
      )
      .join('');
}

function renderOrders() {
  const container = $('#account-orders');
  if (!container) return;
  container.innerHTML = state.orders.length
    ? state.orders
        .map(
          (order) =>
            `<article class="info-card"><strong>Pedido ${text(order.id)}</strong><span>Status: ${text(order.status)}</span><span>${new Date(order.createdAt).toLocaleString('pt-BR')}</span><span>Total ${money(order.total)}</span><span>Produção ${formatDuration(Number(order.productionEstimateHours || 0) * 60)}</span></article>`
        )
        .join('')
    : '<p class="empty-state-inline">Nenhum pedido salvo ainda.</p>';
}

function renderAccountPage() {
  renderHeader();
  if (currentPage() !== 'account') return;
  const authControls = $('#account-auth-controls');
  const modeLabel = $('#account-mode-label');
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.authMode === state.authMode);
  });
  const form = $('#account-page-form');
  const summary = $('#account-summary');
  const actions = $('#account-actions');
  const nameField = $('#account-name-field');
  const phoneField = $('#account-phone-field');
  const nameInput = document.querySelector('[name="accountName"]');
  const phoneInput = document.querySelector('[name="accountPhone"]');
  const submitButton = $('#account-submit');
  modeLabel.textContent =
    state.authMode === 'register'
      ? 'Crie sua conta para salvar pedidos e endereços.'
      : 'Entre para concluir a compra e acompanhar seus pedidos.';
  if (state.me) {
    authControls.hidden = true;
    modeLabel.hidden = true;
    form.hidden = true;
    summary.hidden = false;
    actions.hidden = false;
    summary.innerHTML = `<div class="info-card"><strong>${text(state.me.name)}</strong><span>${text(state.me.email)}</span><span>${text(state.me.phone || 'Celular não informado')}</span><span>${state.addresses.length} endereço(s) salvo(s)</span><span>${state.orders.length} pedido(s)</span></div>`;
    actions.innerHTML =
      '<button class="button button-secondary" id="account-manage-addresses" type="button">Gerenciar endereços</button><button class="button button-secondary" id="account-logout" type="button">Sair</button>';
    $('#account-manage-addresses').onclick = () => redirect('shipping');
    $('#account-logout').onclick = async () => {
      await apiClient.logout();
      state.me = null;
      state.addresses = [];
      state.orders = [];
      state.selectedAddressId = null;
      state.quote = null;
      renderHeader();
      renderAccountPage();
      setStatus('#account-page-status', 'Sessão encerrada.');
    };
  } else {
    authControls.hidden = false;
    modeLabel.hidden = false;
    form.hidden = false;
    summary.hidden = true;
    actions.hidden = true;
    nameField.hidden = state.authMode !== 'register';
    phoneField.hidden = state.authMode !== 'register';
    nameInput.required = state.authMode === 'register';
    phoneInput.required = state.authMode === 'register';
    submitButton.textContent = state.authMode === 'register' ? 'Criar conta' : 'Entrar';
    if (state.authMode !== 'register') {
      nameInput.value = '';
      phoneInput.value = '';
    }
  }
  renderOrders();
}

function addressCard(address) {
  const selected = address.id === state.selectedAddressId;
  return `<article class="address-card${selected ? ' is-selected' : ''}"><div><strong>${text(address.recipientName)}</strong><span>${text(`${address.street}, ${address.number}`)}</span><span>${text(`${address.city}/${address.state} · CEP ${address.postalCode}`)}</span>${address.complement ? `<span>${text(address.complement)}</span>` : ''}${address.reference ? `<span>Ref.: ${text(address.reference)}</span>` : ''}</div><div class="address-actions"><button type="button" data-address-action="select" data-address-id="${address.id}">${selected ? 'Selecionado' : 'Usar este'}</button><button type="button" data-address-action="default" data-address-id="${address.id}">${address.isDefault ? 'Padrão' : 'Tornar padrão'}</button><button type="button" data-address-action="edit" data-address-id="${address.id}">Editar</button><button type="button" data-address-action="delete" data-address-id="${address.id}">Excluir</button></div></article>`;
}

function fillAddressForm(address = null) {
  const form = $('#shipping-form');
  if (!form) return;
  form.reset();
  state.editingAddressId = address?.id || null;
  const values = address || {
    recipientName: state.me?.name || '',
    postalCode: '',
    street: '',
    number: '',
    complement: '',
    neighborhood: '',
    city: '',
    state: '',
    reference: '',
  };
  Object.entries(values).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field) field.value = value || '';
  });
  $('#shipping-form-title').textContent = state.editingAddressId
    ? 'Editar endereço'
    : 'Novo endereço';
  $('#shipping-save-address').textContent = state.editingAddressId
    ? 'Salvar alterações'
    : 'Salvar endereço';
}

function renderQuote() {
  const container = $('#shipping-quote-items');
  if (!container) return;
  if (!state.quote) {
    container.innerHTML =
      '<p class="empty-state-inline">Selecione um endereço para recalcular o pedido.</p>';
    $('#shipping-quote-total').textContent = money(cartSummary().subtotal);
    $('#shipping-quote-production').textContent = formatDuration(cartSummary().productionMinutes);
    $('#shipping-submit').disabled = !state.selectedAddressId || !cartSummary().lines.length;
    return;
  }
  container.innerHTML = state.quote.items
    .map(
      (item) =>
        `<div class="quote-item"><strong>${text(item.productNameSnapshot)} — ${text(item.optionName)}</strong><span>${item.quantity} un. · ${money(item.unitPrice)} por peça</span><span>${item.unitWeightGrams} g · ${money(item.lineTotal)}</span></div>`
    )
    .join('');
  $('#shipping-quote-total').textContent = money(state.quote.total);
  $('#shipping-quote-production').textContent = formatDuration(
    Number(state.quote.productionEstimateHours || 0) * 60
  );
  $('#shipping-submit').disabled = !state.selectedAddressId || !cartSummary().lines.length;
}

function renderShippingPage() {
  if (currentPage() !== 'shipping') return;
  if (!state.me) {
    redirect('account', { next: 'shipping' });
    return;
  }
  $('#shipping-addresses').innerHTML = state.addresses.length
    ? state.addresses.map(addressCard).join('')
    : '<p class="empty-state-inline">Nenhum endereço salvo ainda.</p>';
  $('#shipping-empty-cart').hidden = !!cartSummary().lines.length;
  renderQuote();
  $('#shipping-addresses')
    .querySelectorAll('[data-address-action]')
    .forEach((button) =>
      button.addEventListener('click', async () => {
        const addressId = button.dataset.addressId;
        const action = button.dataset.addressAction;
        if (action === 'select') {
          state.selectedAddressId = addressId;
          renderShippingPage();
          await refreshQuote();
        }
        if (action === 'default') {
          await apiClient.setDefaultAddress(addressId);
          await loadUserData();
          renderShippingPage();
        }
        if (action === 'edit')
          fillAddressForm(state.addresses.find((entry) => entry.id === addressId));
        if (action === 'delete') {
          await apiClient.deleteAddress(addressId);
          if (state.selectedAddressId === addressId) state.selectedAddressId = null;
          await loadUserData();
          renderShippingPage();
          await refreshQuote();
        }
      })
    );
}

async function refreshQuote() {
  if (
    currentPage() !== 'shipping' ||
    !state.me ||
    !state.selectedAddressId ||
    !cartSummary().lines.length
  ) {
    state.quote = null;
    renderQuote();
    return;
  }
  setStatus('#shipping-quote-status', 'Recalculando preços e estimativa...');
  try {
    const result = await apiClient.quoteOrder({
      addressId: state.selectedAddressId,
      items: state.cart,
    });
    state.quote = result.quote;
    setStatus(
      '#shipping-quote-status',
      `Preços confirmados pelo ${state.backendMode === 'live' ? 'backend' : 'mock local'}.`
    );
  } catch (error) {
    state.quote = null;
    setStatus('#shipping-quote-status', error.message || 'Não foi possível recalcular o pedido.');
  }
  renderQuote();
}

function renderStorePage() {
  const page = currentPage();
  document.querySelector('main').hidden = Boolean(page);
  document.querySelectorAll('.store-page').forEach((section) => {
    section.hidden = !page || section.id !== `${page}-page`;
  });
  if (!page) {
    $('#cart-panel')?.classList.remove('open');
  }
  renderCart();
  renderAccountPage();
  renderShippingPage();
}

function bindSpaLinks() {
  document.querySelectorAll('[data-spa-link]').forEach((link) =>
    link.addEventListener('click', (event) => {
      const href = link.getAttribute('href') || '/';
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      navigateTo(pageForPathname(url.pathname), {
        hash: url.hash.replace(/^#/, ''),
      });
    })
  );
}

function bindSearchBox() {
  const searchBox = $('#search-box');
  const searchInput = $('#search');
  const searchToggle = $('#search-toggle');
  if (!searchBox || !searchInput || !searchToggle) return;

  const openSearch = () => {
    searchBox.classList.add('is-open');
  };

  const closeSearch = () => {
    if (searchInput.value.trim()) return;
    searchBox.classList.remove('is-open');
  };

  searchToggle.addEventListener('click', () => {
    openSearch();
    searchInput.focus();
  });

  searchInput.addEventListener('focus', openSearch);
  searchInput.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!searchBox.contains(document.activeElement)) closeSearch();
    }, 0);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    searchInput.blur();
    closeSearch();
  });

  document.addEventListener('click', (event) => {
    if (searchBox.contains(event.target)) return;
    closeSearch();
  });
}

function bindEvents() {
  $('#search')?.addEventListener('input', (event) => {
    state.query = event.target.value;
    state.page = 1;
    refreshCatalog()
      .then(() => {
        renderCategories();
        renderCatalog();
      })
      .catch(console.error);
  });
  $('#per-page')?.addEventListener('change', (event) => {
    state.perPage = Math.max(1, Number(event.target.value) || 6);
    state.page = 1;
    refreshCatalog()
      .then(() => {
        renderCategories();
        renderCatalog();
      })
      .catch(console.error);
  });
  $('#sort')?.addEventListener('change', (event) => {
    state.sort = event.target.value;
    state.page = 1;
    refreshCatalog()
      .then(() => {
        renderCategories();
        renderCatalog();
      })
      .catch(console.error);
  });
  $('#category-filters')?.addEventListener('click', (event) => {
    const button = event.target.closest('.pill');
    if (!button) return;
    state.category = button.dataset.category;
    state.page = 1;
    refreshCatalog()
      .then(() => {
        renderCategories();
        renderCatalog();
      })
      .catch(console.error);
  });
  $('#cart-open')?.addEventListener('click', () => redirect('cart'));
  $('#account-open')?.addEventListener('click', () => redirect('account'));
  $('#cart-close')?.addEventListener('click', () => $('#cart-panel').classList.remove('open'));
  $('#cart-items')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cart-action]');
    if (!button) return;
    updateCart(Number(button.dataset.cartIndex), button.dataset.cartAction);
  });
  $('#page-cart-items')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page-cart]');
    if (!button) return;
    updateCart(Number(button.dataset.index), button.dataset.pageCart);
  });
  const checkout = () => {
    if (!cartSummary().lines.length) {
      setStatus('#form-status', 'Adicione pelo menos um item ao carrinho.');
      return;
    }
    if (!state.me) {
      redirect('account', { next: 'shipping' });
      return;
    }
    redirect('shipping');
  };
  $('#checkout-start')?.addEventListener('click', checkout);
  $('#page-checkout-start')?.addEventListener('click', checkout);
  document.querySelectorAll('[data-quantity-delta]').forEach((button) =>
    button.addEventListener('click', () => {
      $('#quantity-input').value = Math.max(
        1,
        Number($('#quantity-input').value || 1) + Number(button.dataset.quantityDelta)
      );
      updateQuantityPreview();
    })
  );
  $('#quantity-input')?.addEventListener('input', updateQuantityPreview);
  $('#quantity-close')?.addEventListener('click', () => $('#quantity-dialog').close());
  $('#quantity-confirm')?.addEventListener('click', () => {
    if (!state.pendingItem) return;
    addToCart(state.pendingItem.item.id, Math.max(1, Number($('#quantity-input').value) || 1));
    state.pendingItem = null;
    $('#quantity-dialog').close();
  });
  document.querySelectorAll('[data-auth-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      state.authMode = button.dataset.authMode;
      setStatus('#account-page-status', '');
      renderAccountPage();
    })
  );
  $('[name="accountPhone"]')?.addEventListener('input', (event) => {
    event.target.value = formatPhone(event.target.value);
  });
  $('[name="accountEmail"]')?.addEventListener('input', (event) => {
    const valid = isValidEmail(event.target.value);
    event.target.setCustomValidity(valid || !event.target.value ? '' : 'Informe um e-mail válido.');
  });
  $('#account-page-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('accountEmail') || '')
      .trim()
      .toLowerCase();
    if (!isValidEmail(email)) {
      const emailInput = $('[name="accountEmail"]');
      emailInput?.setCustomValidity('Informe um e-mail válido.');
      emailInput?.reportValidity();
      setStatus('#account-page-status', 'Informe um e-mail válido.');
      return;
    }
    $('[name="accountEmail"]')?.setCustomValidity('');
    const payload = {
      name: String(form.get('accountName') || '').trim(),
      email,
      password: String(form.get('accountPassword') || ''),
      phone: String(form.get('accountPhone') || '').trim(),
    };
    setStatus(
      '#account-page-status',
      state.authMode === 'register' ? 'Criando conta...' : 'Entrando...'
    );
    try {
      const result =
        state.authMode === 'register'
          ? await apiClient.register(payload)
          : await apiClient.login(payload);
      state.me = result.user;
      await loadUserData();
      renderHeader();
      renderAccountPage();
      setStatus(
        '#account-page-status',
        state.authMode === 'register' ? 'Conta criada com sucesso.' : 'Login realizado com sucesso.'
      );
      const nextPath = consumePostAuthPath();
      if (nextPath) {
        setTimeout(() => navigateTo(pageForPathname(nextPath)), 350);
      }
    } catch (error) {
      setStatus('#account-page-status', error.message || 'Não foi possível autenticar.');
    }
  });
  $('#shipping-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      recipientName: String(form.get('recipientName') || '').trim(),
      postalCode: normalizePostalCode(form.get('postalCode')),
      street: String(form.get('street') || '').trim(),
      number: String(form.get('number') || '').trim(),
      complement: String(form.get('complement') || '').trim(),
      neighborhood: String(form.get('neighborhood') || '').trim(),
      city: String(form.get('city') || '').trim(),
      state: String(form.get('state') || '')
        .trim()
        .toUpperCase(),
      reference: String(form.get('reference') || '').trim(),
      isDefault: !state.addresses.length,
    };
    setStatus(
      '#shipping-status',
      state.editingAddressId ? 'Atualizando endereço...' : 'Salvando endereço...'
    );
    try {
      if (state.editingAddressId) await apiClient.updateAddress(state.editingAddressId, payload);
      else await apiClient.createAddress(payload);
      fillAddressForm();
      await loadUserData();
      renderShippingPage();
      setStatus('#shipping-status', 'Endereço salvo com sucesso.');
      await refreshQuote();
    } catch (error) {
      setStatus('#shipping-status', error.message || 'Não foi possível salvar o endereço.');
    }
  });
  $('#shipping-cancel-edit')?.addEventListener('click', () => {
    fillAddressForm();
    setStatus('#shipping-status', '');
  });
  $('#shipping-postal-code')?.addEventListener('blur', async (event) => {
    const clean = normalizePostalCode(event.target.value);
    if (clean.length !== 8) return;
    setStatus('#shipping-status', 'Buscando endereço...');
    try {
      const response = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await response.json();
      if (data.erro) throw new Error('CEP não encontrado');
      $('#shipping-street').value = data.logradouro || '';
      $('#shipping-neighborhood').value = data.bairro || '';
      $('#shipping-city').value = data.localidade || '';
      $('#shipping-state').value = data.uf || '';
      setStatus('#shipping-status', 'Endereço encontrado.');
    } catch {
      setStatus('#shipping-status', 'Não foi possível preencher este CEP automaticamente.');
    }
  });
  $('#shipping-quote-refresh')?.addEventListener('click', () => refreshQuote());
  $('#shipping-submit')?.addEventListener('click', async () => {
    if (!state.selectedAddressId) {
      setStatus('#shipping-order-status', 'Selecione um endereço antes de confirmar.');
      return;
    }
    if (!cartSummary().lines.length) {
      setStatus('#shipping-order-status', 'Seu carrinho está vazio.');
      return;
    }
    const idempotencyKey = sessionStorage.getItem('napo3d-order-key') || crypto.randomUUID();
    sessionStorage.setItem('napo3d-order-key', idempotencyKey);
    setStatus('#shipping-order-status', 'Criando pedido...');
    try {
      const result = await apiClient.createOrder({
        addressId: state.selectedAddressId,
        items: state.cart,
        customer: { name: state.me.name, email: state.me.email, phone: state.me.phone },
        idempotencyKey,
      });
      sessionStorage.removeItem('napo3d-order-key');
      state.cart = [];
      state.quote = null;
      renderCart();
      await loadUserData();
      setStatus('#shipping-order-status', `Pedido ${result.order.id} confirmado com sucesso.`);
      renderShippingPage();
    } catch (error) {
      setStatus('#shipping-order-status', error.message || 'Não foi possível confirmar o pedido.');
    }
  });
}

async function init() {
  normalizeInitialLocation();
  await apiClient.init();
  state.backendMode = apiClient.getMode();
  await Promise.all([loadProducts(), refreshSession()]);
  if ($('#per-page')) $('#per-page').value = String(state.perPage);
  if (state.me) await loadUserData();
  renderCategories();
  renderCatalog();
  renderCart();
  bindSpaLinks();
  bindSearchBox();
  renderHeader();
  bindEvents();
  renderStorePage();
  fillAddressForm();
  await refreshQuote();
  window.addEventListener('popstate', () => {
    renderStorePage();
    if (currentPage() === 'shipping') refreshQuote().catch(console.error);
  });
  const floatingTop = $('#floating-top-button');
  window.addEventListener(
    'scroll',
    () => floatingTop?.classList.toggle('is-visible', window.scrollY > window.innerHeight * 0.65),
    { passive: true }
  );
}

init().catch((error) => {
  console.error('[napo3d] init error', error);
  $('#catalog-grid').innerHTML = '<p class="empty-state">Não foi possível carregar as peças.</p>';
});
