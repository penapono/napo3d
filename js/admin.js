import { apiClient, adminClient } from './api-client.js';

const $ = (selector) => document.querySelector(selector);
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

const ORDER_STATUS_LABELS = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  in_production: 'Em produção',
  shipped: 'Enviado',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};

const state = {
  me: null,
  activeTab: 'products',
  products: [],
  editingProductId: null,
  editingOrderId: null,
  editingUserId: null,
};

function setStatus(selector, message, tone = '') {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || '';
  node.dataset.tone = tone;
}

function formatDate(value) {
  return new Date(value).toLocaleString('pt-BR');
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.adminTab === tab);
  });
  document.querySelectorAll('.admin-panel').forEach((panel) => {
    panel.hidden = panel.id !== `admin-panel-${tab}`;
  });
  if (tab === 'products') loadProducts();
  if (tab === 'orders') loadOrders();
  if (tab === 'users') loadUsers();
}

function optionRowValues(row) {
  const field = (name) => row.querySelector(`[data-option-field="${name}"]`)?.value || '';
  return {
    name: field('name'),
    weight: Number(field('weight')),
    colors: field('colors'),
    score: Number(field('score')) || 0,
    url: field('url'),
    imageUrl: field('imageUrl'),
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
    state.products = result.products || [];
    list.innerHTML = state.products.length
      ? state.products.map(productRow).join('')
      : '<p class="empty-state-inline">Nenhum produto cadastrado ainda.</p>';
    list.querySelectorAll('[data-product-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        openProductDialog(
          state.products.find((product) => product.id === button.dataset.productEdit)
        );
      });
    });
    list.querySelectorAll('[data-product-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!confirm('Excluir este produto? Pedidos antigos que o referenciam não são afetados.'))
          return;
        await adminClient.deleteProduct(button.dataset.productDelete);
        await loadProducts();
      });
    });
  } catch (error) {
    list.innerHTML = `<p class="empty-state-inline">${text(error.message || 'Não foi possível carregar os produtos.')}</p>`;
  }
}

function bindProductEvents() {
  $('#admin-product-new')?.addEventListener('click', () => openProductDialog());
  $('#admin-product-dialog-close')?.addEventListener('click', () =>
    $('#admin-product-dialog').close()
  );
  $('#admin-option-add')?.addEventListener('click', () => addOptionRow());
  $('#admin-product-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      name: form.elements.namedItem('name').value.trim(),
      category: form.elements.namedItem('category').value.trim(),
      page: form.elements.namedItem('page').value
        ? Number(form.elements.namedItem('page').value)
        : undefined,
      summary: form.elements.namedItem('summary').value.trim(),
      reference: form.elements.namedItem('reference').value.trim(),
      options: [...$('#admin-options-list').children].map(optionRowValues),
    };
    setStatus('#admin-product-status', 'Salvando...');
    try {
      if (state.editingProductId) await adminClient.updateProduct(state.editingProductId, payload);
      else await adminClient.createProduct(payload);
      $('#admin-product-dialog').close();
      await loadProducts();
    } catch (error) {
      setStatus(
        '#admin-product-status',
        error.message || 'Não foi possível salvar o produto.',
        'error'
      );
    }
  });
}

function orderRow(order) {
  return `<article class="admin-list-row">
    <div class="admin-list-row-info">
      <strong>Pedido ${text(order.id)}</strong>
      <span>${text(order.customerName)} · ${formatDate(order.createdAt)}</span>
      <span>${text(ORDER_STATUS_LABELS[order.status] || order.status)} · ${money(order.total)}</span>
    </div>
    <div class="admin-list-row-actions">
      <button class="button button-secondary" data-order-detail="${text(order.id)}" type="button">Ver detalhe</button>
    </div>
  </article>`;
}

function openOrderDialog(order) {
  state.editingOrderId = order.id;
  $('#admin-order-dialog-title').textContent = `Pedido ${order.id}`;
  $('#admin-order-detail').innerHTML = `
    <div class="info-card"><strong>Cliente</strong><span>${text(order.customerName)} · ${text(order.customerEmail)}</span><span>${text(order.customerPhone || 'Telefone não informado')}</span></div>
    <div class="info-card"><strong>Endereço de entrega</strong><span>${text(order.addressSnapshot?.street || '')}, ${text(order.addressSnapshot?.number || '')}</span><span>${text(order.addressSnapshot?.city || '')}/${text(order.addressSnapshot?.state || '')} · CEP ${text(order.addressSnapshot?.postalCode || '')}</span></div>
    ${(order.items || []).map((item) => `<div class="info-card"><strong>${text(item.productNameSnapshot)} — ${text(item.optionName)}</strong><span>${item.quantity} un. · ${item.unitWeightGrams} g · ${money(item.unitPrice)} por peça</span><span>Total da linha: ${money(item.lineTotal)}</span></div>`).join('')}
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
    const orders = result.orders || [];
    list.innerHTML = orders.length
      ? orders.map(orderRow).join('')
      : '<p class="empty-state-inline">Nenhum pedido encontrado.</p>';
    list.querySelectorAll('[data-order-detail]').forEach((button) => {
      button.addEventListener('click', async () => {
        const detail = await adminClient.getOrder(button.dataset.orderDetail);
        openOrderDialog(detail.order);
      });
    });
  } catch (error) {
    list.innerHTML = `<p class="empty-state-inline">${text(error.message || 'Não foi possível carregar os pedidos.')}</p>`;
  }
}

function bindOrderEvents() {
  $('#admin-orders-filter')?.addEventListener('change', () => loadOrders());
  $('#admin-order-dialog-close')?.addEventListener('click', () => $('#admin-order-dialog').close());
  $('#admin-order-status-save')?.addEventListener('click', async () => {
    if (!state.editingOrderId) return;
    setStatus('#admin-order-status-message', 'Salvando...');
    try {
      await adminClient.updateOrderStatus(
        state.editingOrderId,
        $('#admin-order-status-select').value
      );
      setStatus('#admin-order-status-message', 'Status atualizado.', 'success');
      await loadOrders();
    } catch (error) {
      setStatus(
        '#admin-order-status-message',
        error.message || 'Não foi possível atualizar o status.',
        'error'
      );
    }
  });
}

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
  return `<div class="info-card"><strong>Pedido ${text(order.id)}</strong><span>${text(ORDER_STATUS_LABELS[order.status] || order.status)} · ${money(order.total)}</span><span>${formatDate(order.createdAt)}</span></div>`;
}

async function openUserDialog(userId) {
  const detail = await adminClient.getUser(userId);
  state.editingUserId = detail.user.id;
  $('#admin-user-dialog-title').textContent = detail.user.name;
  $('#admin-user-profile').innerHTML =
    `<div class="info-card"><strong>${text(detail.user.email)}</strong><span>Cadastrado em ${new Date(detail.user.createdAt).toLocaleDateString('pt-BR')}</span></div>`;
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
    const users = result.users || [];
    list.innerHTML = users.length
      ? users.map(userRow).join('')
      : '<p class="empty-state-inline">Nenhum usuário encontrado.</p>';
    list.querySelectorAll('[data-user-detail]').forEach((button) => {
      button.addEventListener('click', () => openUserDialog(button.dataset.userDetail));
    });
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
    if (!state.editingUserId) return;
    setStatus('#admin-user-status', 'Salvando...');
    try {
      await adminClient.updateUser(state.editingUserId, {
        name: $('#admin-user-name').value.trim(),
        phone: $('#admin-user-phone').value.trim(),
        role: $('#admin-user-role').disabled ? undefined : $('#admin-user-role').value,
      });
      setStatus('#admin-user-status', 'Usuário atualizado.', 'success');
      await loadUsers();
      await openUserDialog(state.editingUserId);
    } catch (error) {
      setStatus(
        '#admin-user-status',
        error.message || 'Não foi possível salvar as alterações.',
        'error'
      );
    }
  });
  $('#admin-user-delete')?.addEventListener('click', async () => {
    if (!state.editingUserId) return;
    if (
      !confirm(
        'Excluir este usuário? Endereços e sessões dele são removidos; pedidos são mantidos sem o vínculo com a conta.'
      )
    )
      return;
    try {
      await adminClient.deleteUser(state.editingUserId);
      $('#admin-user-dialog').close();
      await loadUsers();
    } catch (error) {
      setStatus(
        '#admin-user-status',
        error.message || 'Não foi possível excluir este usuário.',
        'error'
      );
    }
  });
}

async function init() {
  await apiClient.init();
  const result = await apiClient.getMe().catch(() => ({ user: null }));
  state.me = result.user;
  if (!state.me) {
    setStatus(
      '#admin-guard-status',
      'Você precisa entrar com uma conta de administrador. Redirecionando...'
    );
    setTimeout(() => {
      window.location.href = './index.html?page=account';
    }, 800);
    return;
  }
  if (state.me.role !== 'admin') {
    setStatus('#admin-guard-status', 'Sua conta não tem acesso ao painel administrativo.', 'error');
    return;
  }
  setStatus('#admin-guard-status', '');
  $('#admin-app').hidden = false;
  $('#admin-logout').hidden = false;
  $('#admin-logout').addEventListener('click', async () => {
    await apiClient.logout();
    window.location.href = './index.html';
  });
  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.adminTab));
  });
  bindProductEvents();
  bindOrderEvents();
  bindUserEvents();
  switchTab('products');
}

init().catch((error) => {
  console.error('[napo3d-admin] init error', error);
  setStatus('#admin-guard-status', 'Não foi possível carregar o painel administrativo.', 'error');
});
