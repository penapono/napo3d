const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_PROCESSING_LEASE_MS = 5 * 60 * 1000;

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
    configured: provider === 'resend' && Boolean(apiKey) && Boolean(from),
  };
}

function formatCurrency(value) {
  return `R$ ${Number(value || 0).toLocaleString('pt-BR')}`;
}

function renderItemsRows(items = []) {
  return items
    .map(
      (item) => `
    <tr>
      <td>${escapeHtml(item.productNameSnapshot)} - ${escapeHtml(item.optionName)}</td>
      <td style="text-align:right">${Number(item.quantity || 0)}</td>
      <td style="text-align:right">${Number(item.unitWeightGrams || 0)} g</td>
      <td style="text-align:right">${formatCurrency(item.unitPrice)}</td>
      <td style="text-align:right">${formatCurrency(item.lineTotal)}</td>
    </tr>
  `
    )
    .join('');
}

function renderAddressBlock(address = {}) {
  const line2 = [address.complement, address.neighborhood]
    .filter(Boolean)
    .map((value) => escapeHtml(value))
    .join(' - ');

  return [
    escapeHtml(address.recipientName),
    `${escapeHtml(address.street)}, ${escapeHtml(address.number)}`,
    line2,
    `${escapeHtml(address.city)} - ${escapeHtml(address.state)}`,
    `CEP ${escapeHtml(address.postalCode)}`,
    address.reference ? `Referencia: ${escapeHtml(address.reference)}` : '',
  ]
    .filter(Boolean)
    .join('<br>');
}

export function buildInternalOrderEmail(order) {
  const subject = `Novo pedido #${order.id} - ${order.customerName}`;
  const html = `
    <h1>Novo pedido recebido</h1>
    <p><strong>Pedido:</strong> ${escapeHtml(order.id)}</p>
    <p><strong>Cliente:</strong> ${escapeHtml(order.customerName)} (${escapeHtml(order.customerEmail)})</p>
    <p><strong>Telefone:</strong> ${escapeHtml(order.customerPhone || 'nao informado')}</p>
    <p><strong>Endereco de entrega:</strong><br>${renderAddressBlock(order.addressSnapshot)}</p>
    <table cellpadding="6" cellspacing="0" border="1">
      <thead>
        <tr><th>Item</th><th>Qtd.</th><th>Peso</th><th>Preco unit.</th><th>Total</th></tr>
      </thead>
      <tbody>${renderItemsRows(order.items)}</tbody>
    </table>
    <p><strong>Subtotal:</strong> ${formatCurrency(order.subtotal)}</p>
    <p><strong>Frete:</strong> ${formatCurrency(order.shipping)}</p>
    <p><strong>Total:</strong> ${formatCurrency(order.total)}</p>
    <p><strong>Estimativa de producao:</strong> ${Number(order.productionEstimateHours || 0)}h</p>
    ${order.notes ? `<p><strong>Observacoes:</strong> ${escapeHtml(order.notes)}</p>` : ''}
  `;
  const text = `Novo pedido ${order.id} de ${order.customerName} (${order.customerEmail}). Total: ${formatCurrency(order.total)}.`;
  return { subject, html, text };
}

export function buildCustomerConfirmationEmail(order) {
  const subject = `Recebemos seu pedido #${order.id}`;
  const html = `
    <h1>Pedido confirmado</h1>
    <p>Ola, ${escapeHtml(order.customerName)}! Recebemos seu pedido <strong>${escapeHtml(order.id)}</strong>.</p>
    <table cellpadding="6" cellspacing="0" border="1">
      <thead>
        <tr><th>Item</th><th>Qtd.</th><th>Peso</th><th>Preco unit.</th><th>Total</th></tr>
      </thead>
      <tbody>${renderItemsRows(order.items)}</tbody>
    </table>
    <p><strong>Total:</strong> ${formatCurrency(order.total)}</p>
    <p>Assim que a producao avancar, atualizaremos voce por e-mail.</p>
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
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend respondeu ${response.status}: ${body.slice(0, 200)}`);
  }
}

function resolveNow(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : options.now || new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hasExpiredLease(email, claimedAt, leaseMs) {
  if (!email.processingStartedAt) return true;
  return claimedAt - Date.parse(email.processingStartedAt) >= leaseMs;
}

async function claimNextPendingEmail(store, options = {}) {
  const leaseMs = Number(options.leaseMs || EMAIL_PROCESSING_LEASE_MS);
  const excludedIds = options.excludeIds || new Set();
  const claimedAt = resolveNow(options);
  const claimedAtMs = Date.parse(claimedAt);
  let claimedEmail = null;

  await store.update((nextStore) => {
    const target = nextStore.emails.find(
      (email) =>
        !excludedIds.has(email.id) && !email.sentAt && hasExpiredLease(email, claimedAtMs, leaseMs)
    );
    if (!target) return nextStore;

    claimedEmail = { ...target, processingStartedAt: claimedAt };
    nextStore.emails = nextStore.emails.map((email) =>
      email.id === target.id ? claimedEmail : email
    );
    return nextStore;
  });

  return claimedEmail;
}

async function releaseEmailClaim(store, emailId, mutator) {
  await store.update((nextStore) => {
    nextStore.emails = nextStore.emails.map((entry) => {
      if (entry.id !== emailId) return entry;
      return mutator(entry);
    });
    return nextStore;
  });
}

export async function processPendingEmails(store, options = {}) {
  const config = options.config || resolveMailerConfig();
  const fetchImpl = options.fetchImpl || fetch;
  if (!config.configured) {
    return { sent: 0, skipped: true };
  }

  let sent = 0;
  const processedIds = new Set();

  while (true) {
    const email = await claimNextPendingEmail(store, { ...options, excludeIds: processedIds });
    if (!email) break;
    processedIds.add(email.id);

    const currentStore = await store.read();
    const order = currentStore.orders.find((entry) => entry.id === email.orderId);
    if (!order) {
      await releaseEmailClaim(store, email.id, (entry) => ({
        ...entry,
        processingStartedAt: undefined,
      }));
      continue;
    }

    const to = email.type === 'internal_order' ? config.orderRecipient : email.to;

    try {
      const content = buildEmailContent(email.type, order);
      await sendViaResend({ to, from: config.from, ...content }, config.apiKey, fetchImpl);
      await releaseEmailClaim(store, email.id, (entry) => ({
        ...entry,
        sentAt: resolveNow(options),
        lastError: undefined,
        processingStartedAt: undefined,
      }));
      sent += 1;
    } catch (error) {
      await releaseEmailClaim(store, email.id, (entry) => ({
        ...entry,
        attempts: Number(entry.attempts || 0) + 1,
        lastError: String(error?.message || error),
        processingStartedAt: undefined,
      }));
    }
  }

  return { sent, skipped: false };
}
