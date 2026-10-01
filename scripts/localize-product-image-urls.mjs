import fs from 'node:fs/promises';

import { localizeProductImages } from '../server/makerworld.js';
import { createPostgresStore } from '../server/store.js';

// Points product images at the self-hosted copies in /product-images/ using the manifest
// written by makerworld_scraper/localize_images.py. Dry run unless --apply is passed.
//   node scripts/localize-product-image-urls.mjs [--manifest=product-images/manifest.json] [--apply]
const manifestArg = process.argv.find((arg) => arg.startsWith('--manifest='));
const manifestPath = manifestArg
  ? manifestArg.slice('--manifest='.length)
  : 'product-images/manifest.json';
const apply = process.argv.includes('--apply');

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });
try {
  const products = await store.listProducts();
  let changedProducts = 0;
  let replaced = 0;
  const unmapped = new Set();
  for (const product of products) {
    const result = localizeProductImages(product, manifest);
    result.unmapped.forEach((url) => unmapped.add(url));
    if (!result.replaced) continue;
    changedProducts += 1;
    replaced += result.replaced;
    if (apply) await store.updateProduct(product.id, { options: result.options });
  }
  console.log(
    JSON.stringify({
      apply,
      products: products.length,
      changedProducts,
      replacedUrls: replaced,
      unmappedRemoteUrls: unmapped.size,
      unmappedSample: [...unmapped].slice(0, 5),
    })
  );
} finally {
  await store.close();
}
