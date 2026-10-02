import fs from 'node:fs/promises';

import { normalizeMakerWorldUrl } from '../server/makerworld.js';
import { createPostgresStore } from '../server/store.js';

// Lists which MakerWorld URLs of a collection are not in the catalog yet (read-only).
//   node scripts/collection-diff.mjs urls.json
// Prints JSON: { total, existing, newUrls: [...] }. A model counts as existing when any
// product option has the same MakerWorld model id (or the same normalized URL).
const file = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--'));
const urls = JSON.parse(await fs.readFile(file, 'utf8'))
  .map((value) => normalizeMakerWorldUrl(value))
  .filter(Boolean);
const modelId = (url) => String(url).match(/\/models\/(\d+)/)?.[1] || '';

const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });
try {
  const ids = new Set();
  const known = new Set();
  for (const product of await store.listProducts()) {
    for (const option of product.options || []) {
      if (option?.makerworldModelId) ids.add(String(option.makerworldModelId));
      const url = normalizeMakerWorldUrl(option?.url);
      if (url) {
        known.add(url);
        ids.add(modelId(url));
      }
    }
  }
  const newUrls = [...new Set(urls)].filter((url) => !known.has(url) && !ids.has(modelId(url)));
  console.log(
    JSON.stringify({
      total: new Set(urls).size,
      existing: new Set(urls).size - newUrls.length,
      newUrls,
    })
  );
} finally {
  await store.close();
}
