import fs from 'node:fs/promises';

import { createPostgresStore } from '../server/store.js';

// Applies Portuguese names to products and their options. A field is only changed when it
// still equals the recorded old text, so manual edits made since are never overwritten.
//   node scripts/apply-translations.mjs translations.json [--apply]
// translations.json: { products: { <id>: { old, new } }, options: { <old name>: <new name> } }
const file = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--'));
const apply = process.argv.includes('--apply');
const { products: byId = {}, options: optionNames = {} } = JSON.parse(
  await fs.readFile(file, 'utf8')
);

const store = createPostgresStore({ connectionString: process.env.DATABASE_URL });
try {
  let changedProducts = 0;
  let renamedProducts = 0;
  let renamedOptions = 0;
  for (const product of await store.listProducts()) {
    const rule = byId[product.id];
    const patch = {};
    if (rule && product.name === rule.old) {
      patch.name = rule.new;
      renamedProducts += 1;
    }
    const swap = (value) => {
      if (rule && value === rule.old) return rule.new;
      return optionNames[value] ?? value;
    };
    const options = (product.options || []).map((option) => {
      const next = { ...option };
      for (const key of ['name', 'model']) {
        if (option[key] && swap(option[key]) !== option[key]) {
          next[key] = swap(option[key]);
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(option)) renamedOptions += 1;
      return next;
    });
    if (JSON.stringify(options) !== JSON.stringify(product.options)) patch.options = options;
    if (!Object.keys(patch).length) continue;
    changedProducts += 1;
    if (apply) await store.updateProduct(product.id, patch);
  }
  console.log(JSON.stringify({ apply, changedProducts, renamedProducts, renamedOptions }));
} finally {
  await store.close();
}
