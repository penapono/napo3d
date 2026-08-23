import {
  lineProductionMinutes,
  normalizePostalCode,
  sortProducts,
  unitPriceFromWeight,
  weightInGrams,
} from '../shared/contract.js';
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
  query: '',
  category: 'all',
  sort: 'recommended',
  page: 1,
  perPage: 6,
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

const $ = (selector) => document.querySelector(selector);
const currentPage = () => new URLSearchParams(location.search).get('page');
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

function redirect(page, params = {}) {
  const search = new URLSearchParams({ page, ...params });
  window.location.href = `./index.html?${search.toString()}`;
}

function productImage(item, option) {
  const local = localImages[item.name.trim()];
  const galleryPrimary = Array.isArray(option.imageGallery) ? option.imageGallery[0] : '';
  const candidate = option.imageUrl || galleryPrimary || item.reference;
  const candidateIsLocal = candidate && candidate.startsWith('assets/images/');
  return {
    primary: local || candidate,
    fallback: local ? candidate : candidateIsLocal ? item.reference : '',
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

function optionsFor(item) {
  return [...(item.options || [])].sort(
    (left, right) => (Number(right.score) || 0) - (Number(left.score) || 0)
  );
}

function visibleEntries() {
  const query = state.query.trim().toLowerCase();
  const products = sortProducts(
    state.items.filter((item) => {
      if (state.category !== 'all' && item.category !== state.category) return false;
      if (!query) return true;
      const haystack =
        `${item.name} ${item.category} ${item.summary || ''} ${(item.options || []).map((option) => `${option.name} ${option.colors || ''}`).join(' ')}`.toLowerCase();
      return haystack.includes(query);
    }),
    state.sort
  );
  return products.flatMap((item) =>
    optionsFor(item).map((option, index) => ({ item, option, index }))
  );
}

function findProduct(productId) {
  return state.items.find((item) => item.id === productId) || null;
}

function findOption(productId, optionName) {
  return findProduct(productId)?.options?.find((option) => option.name === optionName) || null;
}

function cartLine(entry) {
  const item = findProduct(entry.productId);
  const option = findOption(entry.productId, entry.optionName);
  if (!item || !option) return null;
  const unitPrice = unitPriceFromWeight(weightInGrams(option), entry.quantity) || 0;
  return {
    item,
    option,
    quantity: entry.quantity,
    label: `${item.name} — ${option.name}`,
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

function card(entry) {
  const { item, option, index } = entry;
  const description =
    copy[item.category] || 'Uma peça especial, feita para fazer parte da sua rotina.';
  const imageSource = productImage(item, option);
  const tierPrices = [
    { label: 'Até 50 un.', quantity: 1 },
    { label: '51 a 100 un.', quantity: 51 },
    { label: 'Mais de 100 un.', quantity: 101 },
  ]
    .map(
      (tier) =>
        `<div class="tier-price"><span>${tier.label}</span><strong>${money(unitPriceFromWeight(weightInGrams(option), tier.quantity))}</strong><small>por peça</small></div>`
    )
    .join('');
  return `<article class="product-card"><div class="product-image">${image(imageSource.primary, `${item.name} — ${option.name}`, imageSource.fallback)}<span class="product-tag">${text(item.category)}</span></div><div class="product-info"><span class="product-variant">Opção ${index + 1}</span><h3>${text(item.name)}</h3><p class="variant-name">${text(option.name)}</p><span class="product-category">${description}</span><div class="tier-prices" aria-label="Preços por quantidade">${tierPrices}</div><button class="quote-button add-to-cart icon-action" type="button" data-product-id="${text(item.id)}" data-option-name="${text(option.name)}" aria-label="Adicionar ${text(item.name)} — ${text(option.name)} ao carrinho" title="Adicionar ao carrinho"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 1.9-1.4L21 8H7"/><circle cx="10" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/><path d="M16 4v5M13.5 6.5h5"/></svg><span class="sr-only">Adicionar ao carrinho</span></button></div></article>`;
}

function renderPagination(total) {
  const pagination = $('#pagination');
  if (!pagination) return;
  const totalPages = Math.max(1, Math.ceil(total / state.perPage));
  if (total <= state.perPage) {
    pagination.innerHTML = '';
    return;
  }
  pagination.innerHTML = `<button class="page-button" type="button" data-page="prev" ${state.page === 1 ? 'disabled' : ''}>←</button>${Array.from({ length: totalPages }, (_, index) => `<button class="page-button${state.page === index + 1 ? ' active' : ''}" type="button" data-page="${index + 1}">${index + 1}</button>`).join('')}<button class="page-button" type="button" data-page="next" ${state.page === totalPages ? 'disabled' : ''}>→</button>`;
  pagination.querySelectorAll('.page-button').forEach((button) =>
    button.addEventListener('click', () => {
      const target = button.dataset.page;
      state.page =
        target === 'prev' ? state.page - 1 : target === 'next' ? state.page + 1 : Number(target);
      renderCatalog();
      $('#catalogo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );
}

function renderCatalog() {
  const grid = $('#catalog-grid');
  if (!grid) return;
  const entries = visibleEntries();
  const totalPages = Math.max(1, Math.ceil(entries.length / state.perPage));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.perPage;
  grid.innerHTML = entries
    .slice(start, start + state.perPage)
    .map(card)
    .join('');
  $('#empty-state').hidden = entries.length > 0;
  renderPagination(entries.length);
  grid
    .querySelectorAll('.add-to-cart')
    .forEach((button) =>
      button.addEventListener('click', () =>
        openQuantityDialog(button.dataset.productId, button.dataset.optionName)
      )
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
              `<div class="cart-item"><div><strong>${text(line.label)}</strong><span>${money(line.unitPrice)} por peça · ${line.quantity} un.</span></div><div class="cart-controls"><button type="button" data-cart-action="decrease" data-cart-index="${index}">−</button><span>${line.quantity}</span><button type="button" data-cart-action="increase" data-cart-index="${index}">+</button><button type="button" data-cart-action="remove" data-cart-index="${index}">Remover</button></div></div>`
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
              `<div class="page-cart-item"><div><strong>${text(line.label)}</strong><span>${line.quantity} un. · ${money(line.unitPrice)} por peça</span></div><div class="cart-controls"><button type="button" data-page-cart="decrease" data-index="${index}">−</button><span>${line.quantity}</span><button type="button" data-page-cart="increase" data-index="${index}">+</button><button type="button" data-page-cart="remove" data-index="${index}">Remover</button></div></div>`
          )
          .join('')
      : '<p class="cart-empty">Seu carrinho está vazio.</p>';
  }
  $('#page-cart-total') && ($('#page-cart-total').textContent = money(summary.subtotal));
  $('#page-production-total') &&
    ($('#page-production-total').textContent = formatDuration(summary.productionMinutes));
}

function openQuantityDialog(productId, optionName) {
  const item = findProduct(productId);
  const option = findOption(productId, optionName);
  if (!item || !option) return;
  state.pendingItem = { item, option };
  const source = productImage(item, option);
  $('#quantity-title').textContent = item.name;
  $('#quantity-description').textContent = option.name;
  $('#quantity-image').src = source.primary;
  $('#quantity-image').alt = `${item.name} — ${option.name}`;
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

function addToCart(productId, optionName, quantity) {
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
  const result = await apiClient.getProducts({ limit: 200, sort: state.sort });
  state.items = result.items;
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
  const categories = [...new Set(state.items.map((item) => item.category).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right, 'pt-BR')
  );
  node.innerHTML =
    '<button class="pill active" data-category="all">Tudo</button>' +
    categories
      .map(
        (category) =>
          `<button class="pill" data-category="${text(category)}">${text(category)}</button>`
      )
      .join('');
  node.querySelectorAll('.pill').forEach((button) =>
    button.addEventListener('click', () => {
      node.querySelectorAll('.pill').forEach((pill) => pill.classList.remove('active'));
      button.classList.add('active');
      state.category = button.dataset.category;
      state.page = 1;
      renderCatalog();
    })
  );
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
  $('#backend-badge').textContent =
    state.backendMode === 'live' ? 'Backend ativo' : 'Modo mock local';
  const authControls = $('#account-auth-controls');
  const modeLabel = $('#account-mode-label');
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.authMode === state.authMode);
  });
  const form = $('#account-page-form');
  const summary = $('#account-summary');
  const actions = $('#account-actions');
  const nameField = $('#account-name-field');
  const nameInput = document.querySelector('[name="accountName"]');
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
    summary.innerHTML = `<div class="info-card"><strong>${text(state.me.name)}</strong><span>${text(state.me.email)}</span><span>${text(state.me.phone || 'Telefone não informado')}</span><span>${state.addresses.length} endereço(s) salvo(s)</span><span>${state.orders.length} pedido(s)</span></div>`;
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
    nameInput.required = state.authMode === 'register';
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
  $('#shipping-backend-badge').textContent =
    state.backendMode === 'live' ? 'Backend ativo' : 'Modo mock local';
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
  if (!page) return;
  document.querySelector('main').hidden = true;
  document.querySelectorAll('.store-page').forEach((section) => {
    section.hidden = section.id !== `${page}-page`;
  });
  renderCart();
  renderAccountPage();
  renderShippingPage();
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
    renderCatalog();
  });
  $('#sort')?.addEventListener('change', (event) => {
    state.sort = event.target.value;
    state.page = 1;
    renderCatalog();
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
    addToCart(
      state.pendingItem.item.id,
      state.pendingItem.option.name,
      Math.max(1, Number($('#quantity-input').value) || 1)
    );
    state.pendingItem = null;
    $('#quantity-dialog').close();
  });
  document.querySelectorAll('[data-auth-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      state.authMode = button.dataset.authMode;
      renderAccountPage();
    })
  );
  $('#account-page-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get('accountName') || '').trim(),
      email: String(form.get('accountEmail') || '')
        .trim()
        .toLowerCase(),
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
      const next = new URLSearchParams(location.search).get('next');
      if (next === 'shipping') setTimeout(() => redirect('shipping'), 350);
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
  await apiClient.init();
  state.backendMode = apiClient.getMode();
  await Promise.all([loadProducts(), refreshSession()]);
  if (state.me) await loadUserData();
  renderCategories();
  renderCatalog();
  renderCart();
  bindSearchBox();
  renderHeader();
  bindEvents();
  renderStorePage();
  fillAddressForm();
  await refreshQuote();
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
