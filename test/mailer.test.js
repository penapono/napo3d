import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store.js';
import {
  buildCustomerConfirmationEmail,
  buildInternalOrderEmail,
  escapeHtml,
  processPendingEmails
} from '../server/mailer.js';

function sampleOrder(overrides = {}) {
  return {
    id: 'order-1',
    customerName: 'Ana <script>alert(1)</script>',
    customerEmail: 'ana@example.com',
    customerPhone: '11999999999',
    addressSnapshot: {
      recipientName: 'Ana',
      street: 'Rua A',
      number: '10',
      city: 'Campinas',
      state: 'SP',
      postalCode: '13010111'
    },
    items: [
      {
        productNameSnapshot: 'Produto',
        optionName: 'Laranja',
        unitWeightGrams: 40,
        quantity: 10,
        unitPrice: 15,
        lineTotal: 150
      }
    ],
    subtotal: 150,
    shipping: 0,
    total: 150,
    productionEstimateHours: 1,
    notes: '',
    ...overrides
  };
}

test('escapeHtml neutralizes HTML special characters', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

test('buildInternalOrderEmail escapes customer-controlled text', () => {
  const email = buildInternalOrderEmail(sampleOrder());
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
});

test('buildCustomerConfirmationEmail includes order id and total', () => {
  const email = buildCustomerConfirmationEmail(sampleOrder());
  assert.match(email.subject, /order-1/);
  assert.match(email.html, /R\$\s*150/);
});

test('processPendingEmails skips sending when the mailer is not configured', async () => {
  const store = createMemoryStore();
  await store.update((nextStore) => {
    nextStore.orders.push(sampleOrder());
    nextStore.emails.push({
      id: 'email-1',
      type: 'customer_confirmation',
      to: 'ana@example.com',
      orderId: 'order-1',
      createdAt: new Date(0).toISOString()
    });
    return nextStore;
  });

  const result = await processPendingEmails(store, { config: { configured: false } });
  assert.equal(result.skipped, true);

  const after = await store.read();
  assert.equal(after.emails[0].sentAt, undefined);
});

test('processPendingEmails sends pending emails and marks them sent', async () => {
  const store = createMemoryStore();
  await store.update((nextStore) => {
    nextStore.orders.push(sampleOrder());
    nextStore.emails.push(
      {
        id: 'email-1',
        type: 'customer_confirmation',
        to: 'ana@example.com',
        orderId: 'order-1',
        createdAt: new Date(0).toISOString()
      },
      {
        id: 'email-2',
        type: 'internal_order',
        to: 'owner@example.com',
        orderId: 'order-1',
        createdAt: new Date(0).toISOString()
      }
    );
    return nextStore;
  });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, text: async () => '' };
  };

  const config = {
    configured: true,
    apiKey: 'test-key',
    from: 'pedidos@napo3d.shop',
    orderRecipient: 'owner@example.com'
  };
  const result = await processPendingEmails(store, { config, fetchImpl });

  assert.equal(result.sent, 2);
  assert.equal(calls.length, 2);

  const after = await store.read();
  assert.ok(after.emails.every((email) => email.sentAt));
});

test('processPendingEmails records the error and keeps the email pending on failure', async () => {
  const store = createMemoryStore();
  await store.update((nextStore) => {
    nextStore.orders.push(sampleOrder());
    nextStore.emails.push({
      id: 'email-1',
      type: 'customer_confirmation',
      to: 'ana@example.com',
      orderId: 'order-1',
      createdAt: new Date(0).toISOString()
    });
    return nextStore;
  });

  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const config = {
    configured: true,
    apiKey: 'test-key',
    from: 'pedidos@napo3d.shop',
    orderRecipient: 'owner@example.com'
  };
  const result = await processPendingEmails(store, { config, fetchImpl });

  assert.equal(result.sent, 0);
  const after = await store.read();
  assert.equal(after.emails[0].sentAt, undefined);
  assert.equal(after.emails[0].attempts, 1);
  assert.match(after.emails[0].lastError, /500/);
  assert.equal(after.emails[0].processingStartedAt, undefined);
});

test('processPendingEmails does not send the same email twice when workers overlap', async () => {
  const store = createMemoryStore();
  await store.update((nextStore) => {
    nextStore.orders.push(sampleOrder());
    nextStore.emails.push({
      id: 'email-1',
      type: 'customer_confirmation',
      to: 'ana@example.com',
      orderId: 'order-1',
      createdAt: new Date(0).toISOString()
    });
    return nextStore;
  });

  const calls = [];
  let releaseSend;
  const sendBlocked = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    await sendBlocked;
    return { ok: true, text: async () => '' };
  };

  const config = {
    configured: true,
    apiKey: 'test-key',
    from: 'pedidos@napo3d.shop',
    orderRecipient: 'owner@example.com'
  };

  const workerA = processPendingEmails(store, { config, fetchImpl });
  const workerB = processPendingEmails(store, { config, fetchImpl });
  await Promise.resolve();
  releaseSend();

  const [resultA, resultB] = await Promise.all([workerA, workerB]);
  assert.equal(resultA.sent + resultB.sent, 1);
  assert.equal(calls.length, 1);

  const after = await store.read();
  assert.equal(after.emails[0].sentAt != null, true);
  assert.equal(after.emails[0].processingStartedAt, undefined);
});

test('processPendingEmails retries emails with stale processing claims', async () => {
  const store = createMemoryStore();
  await store.update((nextStore) => {
    nextStore.orders.push(sampleOrder());
    nextStore.emails.push({
      id: 'email-1',
      type: 'customer_confirmation',
      to: 'ana@example.com',
      orderId: 'order-1',
      createdAt: new Date(0).toISOString(),
      processingStartedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString()
    });
    return nextStore;
  });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, text: async () => '' };
  };
  const config = {
    configured: true,
    apiKey: 'test-key',
    from: 'pedidos@napo3d.shop',
    orderRecipient: 'owner@example.com'
  };

  const result = await processPendingEmails(store, {
    config,
    fetchImpl,
    now: new Date(Date.UTC(2026, 0, 1, 0, 10, 0))
  });

  assert.equal(result.sent, 1);
  assert.equal(calls.length, 1);

  const after = await store.read();
  assert.equal(after.emails[0].processingStartedAt, undefined);
  assert.ok(after.emails[0].sentAt);
});
