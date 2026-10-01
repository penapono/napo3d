import fs from 'node:fs/promises';

import { createPostgresStore } from '../server/store.js';

// Removes or replaces self-hosted product image paths on every product option.
//   node scripts/update-product-images.mjs changes.json [--apply]
// changes.json: { "remove": ["/product-images/a.webp"], "replace": { "/product-images/b.webp": "/product-images/c.webp" } }
// A product never ends up without images: if a removal would empty an option, it is skipped.
const file = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--'));
const apply = process.argv.includes('--apply');
const { remove = [], replace = {} } = JSON.parse(await fs.readFile(file, 'utf8'));
const removed = new Set(remove);

function updateOption(option, stats) {
  const swap = (url) => replace[url] || url;
  const gallery = (Array.isArray(option.imageGallery) ? option.imageGallery : []).map(swap);
  const kept = gallery.filter((url) => !removed.has(url));
  const first = swap(option.imageUrl || '');
  if (!kept.length && !(first && !removed.has(first))) {
    stats.skippedEmpty += 1;
    return option;
  }
  const next = { ...option, imageGallery: [...new Set(kept)] };
  const cover = removed.has(first) || !first ? next.imageGallery[0] : first;
  next.imageUrl = cover;
  const thumb = swap(option.thumb || '');
  next.thumb = removed.has(thumb) || !thumb ? cover : thumb;
  stats.touched += JSON.stringify(next) !== JSON.stringify(option) ? 1 : 0;
  return next;
}

const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });
try {
  const stats = { touched: 0, skippedEmpty: 0 };
  let products = 0;
  for (const product of await store.listProducts()) {
    const options = (product.options || []).map((option) => updateOption(option, stats));
    if (JSON.stringify(options) === JSON.stringify(product.options)) continue;
    products += 1;
    if (apply) await store.updateProduct(product.id, { options });
  }
  console.log(JSON.stringify({ apply, changedProducts: products, ...stats }));
} finally {
  await store.close();
}
