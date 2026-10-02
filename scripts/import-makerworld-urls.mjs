import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { validateProductInput } from '../shared/contract.js';
import {
  applyPortugueseContent,
  mergeMakerWorldProductData,
  normalizeMakerWorldUrl,
  scrapeMakerWorldModel,
} from '../server/makerworld.js';
import { createPostgresStore } from '../server/store.js';

function parseArgs(argv = []) {
  const options = {
    urlsFile: '',
    payloadsFile: '',
    delayMs: 60_000,
    limit: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--urls-file=')) options.urlsFile = arg.slice('--urls-file='.length);
    else if (arg.startsWith('--payloads-file='))
      options.payloadsFile = arg.slice('--payloads-file='.length);
    else if (arg.startsWith('--delay-ms='))
      options.delayMs = Number(arg.slice('--delay-ms='.length));
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
  }

  if (!options.urlsFile) {
    throw new Error('Use --urls-file=/path/to/urls.json');
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error('delay-ms inválido');
  }

  if (options.limit != null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error('limit inválido');
  }

  return options;
}

// Payloads collected from an authorized browser session (MakerWorld blocks the
// server-side scraper behind Cloudflare). JSON object keyed by model URL, each value
// shaped like the scraper service's `model` response.
async function readPayloads(filePath) {
  if (!filePath) return null;
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const byModelId = new Map();
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  for (const payload of entries) {
    const modelId = String(payload?.model_id || '').trim();
    if (modelId) byModelId.set(modelId, payload);
  }
  return byModelId;
}

async function readUrls(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('O arquivo de URLs deve conter um array JSON.');
  return parsed.map((value) => normalizeMakerWorldUrl(value)).filter(Boolean);
}

function makerWorldModelIdFromUrl(url) {
  const match = String(url || '').match(/\/models\/(\d+)/);
  return match ? match[1] : '';
}

function buildDraftProduct(url) {
  return {
    name: '',
    category: '',
    summary: '',
    description: '',
    productionTime: undefined,
    options: [{ name: '', url, weight: 0, score: 0 }],
  };
}

async function importProduct(store, url, payloads) {
  const payload = payloads
    ? payloads.get(makerWorldModelIdFromUrl(url))
    : await scrapeMakerWorldModel(url, { scraperUrl: process.env.MAKERWORLD_SCRAPER_URL });
  if (!payload) throw new Error(`Sem payload para ${url} em --payloads-file.`);
  const merged = applyPortugueseContent(
    mergeMakerWorldProductData(buildDraftProduct(url), [{ target: { index: 0, url }, payload }]),
    payload.pt
  );
  const validation = validateProductInput(merged);
  if (!validation.ok) {
    throw new Error(
      `Importação incompleta para ${url}: ${validation.message || 'produto inválido.'}`
    );
  }

  const now = new Date().toISOString();
  const product = {
    id: crypto.randomUUID(),
    ...validation.product,
    createdAt: now,
    updatedAt: now,
  };
  await store.createProduct(product);
  return product;
}

function existingMakerWorldIndex(products = []) {
  const modelIds = new Set();
  const urls = new Set();
  for (const product of products) {
    for (const option of Array.isArray(product?.options) ? product.options : []) {
      const modelId = String(option?.makerworldModelId || '').trim();
      if (modelId) modelIds.add(modelId);
      const url = normalizeMakerWorldUrl(option?.url);
      if (url) urls.add(url);
    }
  }
  return { modelIds, urls };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const urls = await readUrls(options.urlsFile);
  const payloads = await readPayloads(options.payloadsFile);
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });

  try {
    const existing = existingMakerWorldIndex(await store.listProducts());
    const queue = [];
    for (const url of urls) {
      const modelId = makerWorldModelIdFromUrl(url);
      if (existing.urls.has(url) || (modelId && existing.modelIds.has(modelId))) {
        console.log(JSON.stringify({ status: 'skip', reason: 'already_exists', modelId, url }));
        continue;
      }
      queue.push(url);
      if (options.limit != null && queue.length >= options.limit) break;
    }

    console.log(
      JSON.stringify({
        status: 'start',
        totalUrls: urls.length,
        toImport: queue.length,
        delayMs: options.delayMs,
      })
    );

    let processed = 0;
    for (const url of queue) {
      const modelId = makerWorldModelIdFromUrl(url);
      try {
        const product = await importProduct(store, url, payloads);
        processed += 1;
        existing.urls.add(url);
        if (modelId) existing.modelIds.add(modelId);
        console.log(
          JSON.stringify({
            status: 'imported',
            index: processed,
            remaining: queue.length - processed,
            modelId,
            productId: product.id,
            name: product.name,
            url,
          })
        );
      } catch (error) {
        processed += 1;
        console.log(
          JSON.stringify({
            status: 'error',
            index: processed,
            remaining: queue.length - processed,
            modelId,
            url,
            error: error.message || String(error),
          })
        );
      }

      if (processed < queue.length && options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    console.log(JSON.stringify({ status: 'done', attempted: processed, total: queue.length }));
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'fatal', error: error.message || String(error) }));
  process.exitCode = 1;
});
