import fs from 'node:fs/promises';
import { Pool } from 'pg';

import { groupCatalogProducts, productFamilyKey } from '../shared/catalog.js';

const STORE_LOCK_KEY = 3345103;

function mapProductRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category ?? undefined,
    maglev: Boolean(row.maglev),
    reference: row.reference ?? undefined,
    summary: row.summary ?? undefined,
    description: row.description ?? undefined,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    aiData: row.ai_data && typeof row.ai_data === 'object' ? row.ai_data : {},
    manualCuration:
      row.manual_curation && typeof row.manual_curation === 'object' ? row.manual_curation : {},
    page: row.page == null ? undefined : Number(row.page),
    productionTime: row.production_time == null ? undefined : Number(row.production_time),
    options: Array.isArray(row.options) ? row.options : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function cleanOption(option = {}) {
  const { sourceProductId, sourceOptionName, sourceOptionIndex, ...rest } = option;
  return rest;
}

function buildPlans(products) {
  const groups = new Map();
  for (const product of products) {
    const key = productFamilyKey(product) || product.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }

  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => {
      const family = groupCatalogProducts(items)[0];
      const keeper = items.find((item) => item.id === key) || items[0];
      const duplicates = items.filter((item) => item.id !== keeper.id);
      const optionCount = (family.options || []).length;

      return {
        key,
        familyName: family.name || keeper.name,
        keeperId: keeper.id,
        duplicateIds: duplicates.map((item) => item.id),
        optionCount,
        patch: {
          name: family.name || keeper.name,
          category: family.category || keeper.category || '',
          maglev: items.some((item) => item.maglev),
          reference: family.reference || keeper.reference || '',
          summary: family.summary || keeper.summary || '',
          description: family.description || keeper.description || '',
          keywords: [...new Set(items.flatMap((item) => item.keywords || []).filter(Boolean))],
          aiData: keeper.aiData || {},
          manualCuration: {
            ...(keeper.manualCuration || {}),
            legacyConsolidatedAt: new Date().toISOString(),
            legacySourceProductIds: items.map((item) => item.id),
            legacySourceCount: items.length,
          },
          page: firstDefined(...items.map((item) => item.page)),
          productionTime: family.productionTime || keeper.productionTime || null,
          options: (family.options || []).map(cleanOption),
        },
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key, 'pt-BR'));
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.');
  }

  const dryRun = process.argv.includes('--dry-run');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    const beforeResult = await client.query('SELECT * FROM products ORDER BY created_at ASC, id ASC');
    const beforeProducts = beforeResult.rows.map(mapProductRow);
    const plans = buildPlans(beforeProducts);

    const summary = {
      familiesConsolidated: plans.length,
      deletedProducts: plans.reduce((sum, plan) => sum + plan.duplicateIds.length, 0),
      productCountBefore: beforeProducts.length,
      families: plans.map((plan) => ({
        key: plan.key,
        familyName: plan.familyName,
        keeperId: plan.keeperId,
        deleted: plan.duplicateIds,
        optionCount: plan.optionCount,
      })),
    };

    if (!plans.length) {
      console.log(JSON.stringify({ changed: false, reason: 'no-legacy-groups', ...summary }, null, 2));
      return;
    }

    const legacyOrderItems = await client.query(
      "SELECT order_id, product_id, option_name FROM order_items WHERE product_id LIKE '%--%' ORDER BY order_id ASC"
    );
    if (legacyOrderItems.rows.length) {
      throw new Error(`Existem ${legacyOrderItems.rows.length} itens de pedido ainda usando IDs legados.`);
    }

    const backupPath = `/tmp/napo3d-legacy-products-backup-${Date.now()}.json`;
    const backupPayload = {
      createdAt: new Date().toISOString(),
      plans: summary.families,
      products: beforeProducts.filter((product) =>
        plans.some((plan) => plan.keeperId === product.id || plan.duplicateIds.includes(product.id))
      ),
    };
    await fs.writeFile(backupPath, JSON.stringify(backupPayload, null, 2));

    if (dryRun) {
      console.log(JSON.stringify({ changed: false, dryRun: true, backupPath, ...summary }, null, 2));
      return;
    }

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [STORE_LOCK_KEY]);

    for (const plan of plans) {
      await client.query(
        `UPDATE products
            SET name = $2,
                category = $3,
                maglev = $4,
                reference = $5,
                summary = $6,
                description = $7,
                keywords = $8::jsonb,
                ai_data = $9::jsonb,
                manual_curation = $10::jsonb,
                page = $11,
                production_time = $12,
                options = $13::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [
          plan.keeperId,
          plan.patch.name,
          plan.patch.category || null,
          Boolean(plan.patch.maglev),
          plan.patch.reference || null,
          plan.patch.summary || null,
          plan.patch.description || null,
          JSON.stringify(plan.patch.keywords || []),
          JSON.stringify(plan.patch.aiData || {}),
          JSON.stringify(plan.patch.manualCuration || {}),
          plan.patch.page ?? null,
          plan.patch.productionTime ?? null,
          JSON.stringify(plan.patch.options || []),
        ]
      );

      if (plan.duplicateIds.length) {
        await client.query('DELETE FROM products WHERE id = ANY($1::text[])', [plan.duplicateIds]);
      }
    }

    await client.query('COMMIT');

    const afterResult = await client.query('SELECT count(*)::int AS count FROM products');
    console.log(
      JSON.stringify(
        {
          changed: true,
          backupPath,
          productCountAfter: afterResult.rows[0].count,
          ...summary,
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
