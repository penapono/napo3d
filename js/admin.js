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

function optionDraft(option = {}) {
  return {
    model: option.model || (option.name && option.name !== 'Única' ? option.name : ''),
    size: option.size || '',
    weight: option.weight || '',
    productionTime: option.productionTime || '',
    colors: option.colors || '',
    score: Number.isFinite(Number(option.score)) ? Number(option.score) : '',
    url: option.url || '',
    imageUrl: option.imageUrl || '',
    imageGallery: Array.isArray(option.imageGallery)
      ? option.imageGallery.filter(Boolean).join('\n')
      : '',
  };
}

function renderProductOptionRows(options = [{}]) {
  const node = $('#admin-product-options');
  if (!node) return;
  const drafts = (options.length ? options : [{}]).map(optionDraft);
  node.innerHTML = drafts
    .map(
      (option, index) => `<article class="admin-option-row" data-option-row>
        <div class="admin-option-header">
          <div>
            <strong>Variação ${index + 1}</strong>
            <span>Defina tamanho, peso, tempo e imagens próprias desta variação.</span>
          </div>
        </div>
        <div class="form-row">
          <label>Modelo / versão<input data-option-field="model" value="${text(option.model)}" /></label>
          <label>Tamanho / subtipo<input data-option-field="size" value="${text(option.size)}" placeholder="Ex.: 200 mm, versão compacta" /></label>
        </div>
        <div class="form-row">
          <label>Peso (g)<input data-option-field="weight" type="number" min="1" step="1" value="${text(option.weight)}" /></label>
          <label>Tempo de produção (min)<input data-option-field="productionTime" type="number" min="1" step="1" value="${text(option.productionTime)}" /></label>
        </div>
        <div class="form-row">
          <label>Cor(es)<input data-option-field="colors" value="${text(option.colors)}" /></label>
          <label>Pontuação<input data-option-field="score" type="number" step="1" value="${text(option.score)}" /></label>
        </div>
        <div class="form-row">
          <label>URL do MakerWorld<input data-option-field="url" value="${text(option.url)}" /></label>
          <label>URL da imagem<input data-option-field="imageUrl" value="${text(option.imageUrl)}" /></label>
        </div>
        <label>Galeria da variação (uma URL por linha)<textarea data-option-field="imageGallery" rows="4" placeholder="https://...\nhttps://...">${text(option.imageGallery)}</textarea></label>
        <div class="inline-actions">
          <button class="button button-danger" data-option-remove="${index}" type="button">Remover variação</button>
        </div>
      </article>`
    )
    .join('');
  node.querySelectorAll('[data-option-remove]').forEach((button) => {
    button.disabled = drafts.length === 1;
  });
}

function readProductOptions() {
  return [...document.querySelectorAll('[data-option-row]')].map((row) => {
    const read = (field) =>
      String(row.querySelector(`[data-option-field="${field}"]`)?.value || '').trim();
    return {
      model: read('model'),
      size: read('size'),
      weight: read('weight'),
      productionTime: read('productionTime'),
      colors: read('colors'),
      score: read('score'),
      url: read('url'),
      imageUrl: read('imageUrl'),
      imageGallery: read('imageGallery'),
    };
  });
}

function formatDate(value) {
  return new Date(value).toLocaleString('pt-BR');
}

function makerWorldOptionCount(product) {
  return (Array.isArray(product?.options) ? product.options : []).filter((option) =>
    /https?:\/\/(?:www\.)?makerworld\.com\//i.test(option?.url || '')
  ).length;
}

function makerWorldRefreshSummary(product) {
  const refresh = product.makerworldRefresh;
  const option = primaryProductOption(product) || {};
  if (!refresh) {
    const count = makerWorldOptionCount(product);
    if (!count) return '';
    if (option?.makerworldSyncedAt) {
      return `MakerWorld sincronizado em ${formatDate(option.makerworldSyncedAt)}.`;
    }
    return 'MakerWorld disponível para sincronização.';
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
  const option = primaryProductOption(product) || {};
  if (!refresh) return option?.makerworldSyncedAt ? 'success' : '';
  if (refresh.status === 'failed') return 'error';
  if (refresh.status === 'succeeded') return 'success';
  return '';
}

function aiEnrichmentSummary(product) {
  const enrichment = product.aiEnrichment;
  if (!enrichment) {
    return product.aiData?.generatedAt
      ? `Descrição enriquecida por IA em ${formatDate(product.aiData.generatedAt)}.`
      : '';
  }
  if (enrichment.status === 'queued') {
    return 'Na fila para enriquecer descrição e categoria com IA...';
  }
  if (enrichment.status === 'running') {
    return 'Gerando descrição e categoria com IA...';
  }
  if (enrichment.status === 'failed') {
    return enrichment.error || 'Falha ao enriquecer este produto com IA.';
  }
  if (enrichment.status === 'succeeded') {
    return `IA atualizada em ${formatDate(enrichment.finishedAt)}.`;
  }
  return '';
}

function aiEnrichmentTone(product) {
  const enrichment = product.aiEnrichment;
  if (!enrichment) return '';
  if (enrichment.status === 'failed') return 'error';
  if (enrichment.status === 'succeeded') return 'success';
  return '';
}

function manualCurationSummary(product) {
  const curation = product.manualCuration || {};
  if (!curation.curatedAt) return '';
  return `Curadoria manual aplicada em ${formatDate(curation.curatedAt)}.`;
}

function manualCurationTone(product) {
  return product.manualCuration?.curatedAt ? 'success' : '';
}

function scheduleProductRefreshPoll() {
  clearTimeout(productRefreshPollTimer);
  if (
    state.activeTab !== 'products' ||
    !state.products.some((product) => {
      return (
        ['queued', 'running'].includes(product.makerworldRefresh?.status) ||
        ['queued', 'running'].includes(product.aiEnrichment?.status)
      );
    })
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
  form.elements.namedItem('name').value = product?.name || '';
  form.elements.namedItem('category').value = product?.category || '';
  form.elements.namedItem('summary').value = product?.summary || '';
  form.elements.namedItem('description').value = product?.description || '';
  form.elements.namedItem('productionTime').value = product?.productionTime || '';
  renderProductOptionRows(product?.options || [{}]);
  setStatus('#admin-product-status', '');
  $('#admin-product-dialog').showModal();
}

function productRow(product) {
  const option = primaryProductOption(product);
  const optionCount = Array.isArray(product?.options) ? product.options.length : 0;
  const makerWorldCount = makerWorldOptionCount(product);
  const refresh = product.makerworldRefresh;
  const refreshSummary = makerWorldRefreshSummary(product);
  const refreshTone = makerWorldRefreshTone(product);
  const enrichment = product.aiEnrichment;
  const enrichmentSummary = aiEnrichmentSummary(product);
  const enrichmentTone = aiEnrichmentTone(product);
  const manualSummary = manualCurationSummary(product);
  const manualTone = manualCurationTone(product);
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
      <span>${text(product.category || 'Sem categoria')} · ${optionCount || 0} variação(ões)${Number(option?.weight || 0) > 0 ? ` · ${Number(option.weight)} g` : ''}${rating ? ` · ${text(`${rating}${ratingCount}`)}` : ''}${text(makerWorldId)}</span>
      ${refreshSummary ? `<span class="admin-refresh-note" data-tone="${text(refreshTone)}">${text(refreshSummary)}</span>` : ''}
      ${manualSummary ? `<span class="admin-refresh-note" data-tone="${text(manualTone)}">${text(manualSummary)}</span>` : ''}
      ${enrichmentSummary ? `<span class="admin-refresh-note" data-tone="${text(enrichmentTone)}">${text(enrichmentSummary)}</span>` : ''}
    </div>
    <div class="admin-list-row-actions">
      ${makerWorldCount ? `<button class="admin-icon-button${['queued', 'running'].includes(refresh?.status) ? ' is-loading' : ''}" data-product-refresh="${text(product.id)}" type="button" aria-label="Atualizar dados do MakerWorld" title="Atualizar dados do MakerWorld" ${['queued', 'running'].includes(refresh?.status) ? 'disabled' : ''}><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>` : ''}
      ${product.aiEnrichmentEnabled && product.hasAiEnrichmentCandidate ? `<button class="admin-icon-button${['queued', 'running'].includes(enrichment?.status) ? ' is-loading' : ''}" data-product-enrich="${text(product.id)}" type="button" aria-label="Enriquecer descrição com IA" title="Enriquecer descrição com IA" ${['queued', 'running'].includes(enrichment?.status) ? 'disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>` : ''}
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
    list.querySelectorAll('[data-product-enrich]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await adminClient.enrichProductAi(button.dataset.productEnrich);
          await loadProducts();
        } catch (error) {
          alert(error.message || 'Não foi possível enriquecer este produto com IA.');
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
  $('#admin-option-add')?.addEventListener('click', () => {
    const options = readProductOptions();
    const lastOption = options[options.length - 1];
    options.push(
      lastOption
        ? {
            ...lastOption,
            size: '',
            weight: '',
            productionTime: '',
            imageUrl: '',
            imageGallery: '',
          }
        : {}
    );
    renderProductOptionRows(options);
  });
  $('#admin-product-options')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-option-remove]');
    if (!button) return;
    const index = Number(button.dataset.optionRemove);
    const options = readProductOptions();
    options.splice(index, 1);
    renderProductOptionRows(options.length ? options : [{}]);
  });
  $('#admin-product-dialog-close')?.addEventListener('click', () =>
    $('#admin-product-dialog').close()
  );
  $('#admin-product-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const existingProduct = state.products.find((product) => product.id === state.editingProductId);
    const options = readProductOptions();
    const meaningfulOptions = options.filter((option) =>
      Object.values(option).some((value) => String(value || '').trim())
    );
    const firstOption = meaningfulOptions[0] || {};
    const submittedUrl = String(firstOption.url || '').trim();
    const hasManualOptionData = meaningfulOptions.some((option) =>
      ['model', 'size', 'weight', 'productionTime', 'colors', 'score', 'imageUrl', 'imageGallery'].some(
        (field) => String(option[field] || '').trim()
      )
    );
    const urlOnlyCreate =
      !state.editingProductId &&
      submittedUrl &&
      !hasManualOptionData &&
      !['name', 'category', 'summary', 'description', 'productionTime'].some((fieldName) =>
        String(form.elements.namedItem(fieldName).value || '').trim()
      );
    const payload = urlOnlyCreate
      ? { options: [{ url: submittedUrl }] }
      : {
          name:
            form.elements.namedItem('name').value.trim() ||
            String(firstOption.model || '').trim() ||
            existingProduct?.name ||
            '',
          category: form.elements.namedItem('category').value.trim(),
          summary: form.elements.namedItem('summary').value.trim(),
          description: form.elements.namedItem('description').value.trim(),
          productionTime: form.elements.namedItem('productionTime').value
            ? Number(form.elements.namedItem('productionTime').value)
            : undefined,
          options: meaningfulOptions.map((option) => ({
            model: option.model || undefined,
            size: option.size || undefined,
            weight: Number(option.weight),
            productionTime: option.productionTime ? Number(option.productionTime) : undefined,
            colors: option.colors || undefined,
            score: Number(option.score) || 0,
            url: option.url || undefined,
            imageUrl: option.imageUrl || undefined,
            imageGallery: option.imageGallery
              ? option.imageGallery
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean)
              : undefined,
          })),
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
      window.location.href = './minha-conta';
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
