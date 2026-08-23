import { apiClient, adminClient } from './api-client.js';
import { primaryProductOption } from '../shared/catalog.js';

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
let productRefreshPollTimer = null;

function setStatus(selector, message, tone = '') {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || '';
  node.dataset.tone = tone;
}

function formatDate(value) {
  return new Date(value).toLocaleString('pt-BR');
}

function makerWorldOptionCount(product) {
  const option = primaryProductOption(product);
  return /https?:\/\/(?:www\.)?makerworld\.com\//i.test(option?.url || '') ? 1 : 0;
}

function makerWorldRefreshSummary(product) {
  const refresh = product.makerworldRefresh;
  if (!refresh) {
    const count = makerWorldOptionCount(product);
    return count ? `${count} URL(s) do MakerWorld disponíveis para atualização.` : '';
  }
  if (refresh.status === 'queued') {
    return 'Na fila para atualizar dados do MakerWorld...';
  }
  if (refresh.status === 'running') {
    const progress = refresh.totalCount
      ? ` ${refresh.successCount + refresh.failureCount}/${refresh.totalCount}`
      : '';
    return `Atualizando dados do MakerWorld${progress}...`;
  }
  if (refresh.status === 'failed') {
    return refresh.error || 'Falha ao atualizar dados do MakerWorld.';
  }
  if (refresh.status === 'succeeded') {
    return `MakerWorld atualizado em ${formatDate(refresh.finishedAt)}.`;
  }
  return '';
}

function makerWorldRefreshTone(product) {
  const refresh = product.makerworldRefresh;
  if (!refresh) return '';
  if (refresh.status === 'failed') return 'error';
  if (refresh.status === 'succeeded') return 'success';
  return '';
}

function scheduleProductRefreshPoll() {
  clearTimeout(productRefreshPollTimer);
  if (
    state.activeTab !== 'products' ||
    !state.products.some((product) =>
      ['queued', 'running'].includes(product.makerworldRefresh?.status)
    )
  ) {
    productRefreshPollTimer = null;
    return;
  }
  productRefreshPollTimer = setTimeout(() => {
    loadProducts().catch(() => null);
  }, 2000);
}

function switchTab(tab) {
  state.activeTab = tab;
  clearTimeout(productRefreshPollTimer);
  productRefreshPollTimer = null;
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

function openProductDialog(product = null) {
  state.editingProductId = product?.id || null;
  $('#admin-product-dialog-eyebrow').textContent = product ? 'Editar produto' : 'Novo produto';
  $('#admin-product-dialog-title').textContent = product ? product.name : 'Cadastrar produto';
  const form = $('#admin-product-form');
  form.reset();
  const option = primaryProductOption(product) || {};
  form.elements.namedItem('name').value = product?.name || '';
  form.elements.namedItem('category').value = product?.category || '';
  form.elements.namedItem('page').value = product?.page || '';
  form.elements.namedItem('summary').value = product?.summary || '';
  form.elements.namedItem('weight').value = option.weight || '';
  form.elements.namedItem('productionTime').value =
    option.productionTime || product?.productionTime || '';
  form.elements.namedItem('colors').value = option.colors || '';
  form.elements.namedItem('score').value = option.score || '';
  form.elements.namedItem('url').value = option.url || '';
  form.elements.namedItem('imageUrl').value = option.imageUrl || '';
  setStatus('#admin-product-status', '');
  $('#admin-product-dialog').showModal();
}

function productRow(product) {
  const option = primaryProductOption(product);
  const makerWorldCount = makerWorldOptionCount(product);
  const refresh = product.makerworldRefresh;
  const refreshSummary = makerWorldRefreshSummary(product);
  const refreshTone = makerWorldRefreshTone(product);
  const rating =
    Number.isFinite(Number(option?.rating)) && Number(option.rating) > 0
      ? `${Number(option.rating).toFixed(1).replace('.', ',')}★`
      : '';
  const ratingCount =
    Number.isFinite(Number(option?.ratingCount)) && Number(option.ratingCount) > 0
      ? ` (${Number(option.ratingCount).toLocaleString('pt-BR')})`
      : '';
  const makerWorldId = option?.makerworldModelId ? ` · MW ${option.makerworldModelId}` : '';
  return `<article class="admin-list-row">
    <div class="admin-list-row-info">
      <strong>${text(product.name)}</strong>
      <span>${text(product.category || 'Sem categoria')} · ${Number(option?.weight || 0)} g${rating ? ` · ${text(`${rating}${ratingCount}`)}` : ''}${text(makerWorldId)}</span>
      ${refreshSummary ? `<span class="admin-refresh-note" data-tone="${text(refreshTone)}">${text(refreshSummary)}</span>` : ''}
    </div>
    <div class="admin-list-row-actions">
      ${makerWorldCount ? `<button class="admin-icon-button${['queued', 'running'].includes(refresh?.status) ? ' is-loading' : ''}" data-product-refresh="${text(product.id)}" type="button" aria-label="Atualizar dados do MakerWorld" title="Atualizar dados do MakerWorld" ${['queued', 'running'].includes(refresh?.status) ? 'disabled' : ''}><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>` : ''}
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
    list.querySelectorAll('[data-product-refresh]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await adminClient.refreshProductMakerWorld(button.dataset.productRefresh);
          await loadProducts();
        } catch (error) {
          alert(
            error.message || 'Não foi possível atualizar este produto com dados do MakerWorld.'
          );
          button.disabled = false;
        }
      });
    });
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
  } finally {
    scheduleProductRefreshPoll();
  }
}

function bindProductEvents() {
  $('#admin-product-new')?.addEventListener('click', () => openProductDialog());
  $('#admin-product-dialog-close')?.addEventListener('click', () =>
    $('#admin-product-dialog').close()
  );
  $('#admin-product-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const existingProduct = state.products.find((product) => product.id === state.editingProductId);
    const existingOption = primaryProductOption(existingProduct) || {};
    const submittedUrl = form.elements.namedItem('url').value.trim();
    const urlOnlyCreate =
      !state.editingProductId &&
      submittedUrl &&
      ![
        'name',
        'category',
        'page',
        'summary',
        'weight',
        'productionTime',
        'colors',
        'score',
        'imageUrl',
      ].some((fieldName) => String(form.elements.namedItem(fieldName).value || '').trim());
    const optionName = form.elements.namedItem('name').value.trim();
    const payload = urlOnlyCreate
      ? { options: [{ url: submittedUrl }] }
      : {
          name: optionName,
          category: form.elements.namedItem('category').value.trim(),
          page: form.elements.namedItem('page').value
            ? Number(form.elements.namedItem('page').value)
            : undefined,
          summary: form.elements.namedItem('summary').value.trim(),
          productionTime: form.elements.namedItem('productionTime').value
            ? Number(form.elements.namedItem('productionTime').value)
            : undefined,
          options: [
            {
              ...existingOption,
              name: optionName,
              weight: Number(form.elements.namedItem('weight').value),
              productionTime: form.elements.namedItem('productionTime').value
                ? Number(form.elements.namedItem('productionTime').value)
                : undefined,
              colors: form.elements.namedItem('colors').value.trim(),
              score: Number(form.elements.namedItem('score').value) || 0,
              url: submittedUrl,
              imageUrl: form.elements.namedItem('imageUrl').value.trim(),
            },
          ],
        };
    setStatus(
      '#admin-product-status',
      urlOnlyCreate ? 'Buscando dados do MakerWorld...' : 'Salvando...'
    );
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
