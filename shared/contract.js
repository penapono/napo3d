import { primaryProductOption } from './catalog.js';

export const PRICE_TIERS = [
  { label: 'Até 50 un.', maxQuantity: 50, rate: 375 },
  { label: '51 a 100 un.', maxQuantity: 100, rate: 325 },
  { label: 'Mais de 100 un.', maxQuantity: Infinity, rate: 275 },
];

export const ADDRESS_REQUIRED_FIELDS = [
  'recipientName',
  'postalCode',
  'street',
  'number',
  'city',
  'state',
];

export const DEFAULT_PRODUCTION_TIME_MINUTES = 60;
export const DEFAULT_MAX_ITEM_QUANTITY = 1000;
export const USER_ROLES = ['customer', 'admin'];
export const DEFAULT_USER_ROLE = 'customer';
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'in_production',
  'shipped',
  'completed',
  'cancelled',
];

export function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

export function normalizePostalCode(value) {
  return digitsOnly(value).slice(0, 8);
}

export function normalizeState(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);
}

export function normalizeOptionalText(value) {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

export function normalizeOptionalTextList(values) {
  if (!Array.isArray(values)) return [];
  return values.map(normalizeOptionalText).filter(Boolean);
}

export function normalizeOptionalObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

export function normalizeRequiredText(value) {
  return String(value || '').trim();
}

export function normalizeRatingValue(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) {
    return Math.round(Number(value) * 10) / 10;
  }
  const text = String(value || '')
    .trim()
    .replace(',', '.');
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const rating = Number(match[1]);
  if (!Number.isFinite(rating) || rating <= 0) return undefined;
  return Math.round(rating * 10) / 10;
}

export function normalizeRatingCount(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) {
    return Math.round(Number(value));
  }
  const text = String(value || '').trim();
  const match = text.match(/\((\d+)\)/) || text.match(/(\d+)$/);
  if (!match) return undefined;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return Math.round(count);
}

export function normalizeUserRole(value) {
  return USER_ROLES.includes(value) ? value : DEFAULT_USER_ROLE;
}

export function normalizeAddressInput(address = {}) {
  return {
    recipientName: normalizeRequiredText(address.recipientName),
    postalCode: normalizePostalCode(address.postalCode),
    street: normalizeRequiredText(address.street),
    number: normalizeRequiredText(address.number),
    complement: normalizeOptionalText(address.complement),
    neighborhood: normalizeOptionalText(address.neighborhood),
    city: normalizeRequiredText(address.city),
    state: normalizeState(address.state),
    reference: normalizeOptionalText(address.reference),
    isDefault: Boolean(address.isDefault),
  };
}

export function validateAddressInput(address = {}) {
  const normalized = normalizeAddressInput(address);
  for (const field of ADDRESS_REQUIRED_FIELDS) {
    if (!normalized[field]) {
      return {
        ok: false,
        code: 'INVALID_ADDRESS',
        message: `Campo obrigatório ausente: ${field}`,
        address: normalized,
      };
    }
  }
  if (normalized.postalCode.length !== 8) {
    return {
      ok: false,
      code: 'INVALID_ADDRESS',
      message: 'CEP deve conter 8 dígitos.',
      address: normalized,
    };
  }
  if (normalized.state.length !== 2) {
    return {
      ok: false,
      code: 'INVALID_ADDRESS',
      message: 'UF deve conter 2 letras.',
      address: normalized,
    };
  }
  return { ok: true, address: normalized };
}

export function normalizeProductOptionInput(option = {}, product = {}) {
  const fallbackImageUrl = normalizeOptionalText(product.reference);
  return {
    name: normalizeRequiredText(option.name),
    url: normalizeOptionalText(option.url),
    imageUrl: normalizeOptionalText(option.imageUrl) || fallbackImageUrl,
    imageGallery: normalizeOptionalTextList(option.imageGallery),
    source: normalizeOptionalText(option.source),
    dims: normalizeOptionalText(option.dims),
    time: normalizeOptionalText(option.time),
    rating: normalizeRatingValue(option.rating),
    ratingCount: normalizeRatingCount(option.ratingCount ?? option.rating_count ?? option.rating),
    material: normalizeOptionalText(option.material),
    colors: normalizeOptionalText(option.colors),
    ams: normalizeOptionalText(option.ams),
    support: normalizeOptionalText(option.support),
    weight: Number(option.weight),
    weight_kind: normalizeOptionalText(option.weight_kind),
    license: normalizeOptionalText(option.license),
    notes: normalizeOptionalText(option.notes),
    score: Number.isFinite(Number(option.score)) ? Number(option.score) : 0,
    cost: Number.isFinite(Number(option.cost)) ? Number(option.cost) : undefined,
    thumb: normalizeOptionalText(option.thumb),
    free: Boolean(option.free),
    makerworldModelId: normalizeOptionalText(option.makerworldModelId),
    makerworldSyncedAt: normalizeOptionalText(option.makerworldSyncedAt),
    makerworldLastError: normalizeOptionalText(option.makerworldLastError),
    productionTime: Number.isFinite(Number(option.productionTime))
      ? Number(option.productionTime)
      : undefined,
  };
}

export function validateProductInput(product = {}) {
  const name = normalizeRequiredText(product.name);
  if (!name) {
    return { ok: false, code: 'INVALID_PRODUCT', message: 'Nome do produto é obrigatório.' };
  }
  const rawOptions = Array.isArray(product.options) ? product.options : [];
  if (!rawOptions.length) {
    return {
      ok: false,
      code: 'INVALID_PRODUCT',
      message: 'Cadastre ao menos uma variação (opção).',
    };
  }
  const options = rawOptions.map((option) => normalizeProductOptionInput(option, product));
  for (const option of options) {
    if (!option.name) {
      return { ok: false, code: 'INVALID_PRODUCT', message: 'Toda variação precisa de um nome.' };
    }
    if (!Number.isFinite(option.weight) || option.weight <= 0) {
      return {
        ok: false,
        code: 'INVALID_PRODUCT',
        message: `Peso inválido para a variação "${option.name}".`,
      };
    }
  }
  return {
    ok: true,
    product: {
      name,
      category: normalizeOptionalText(product.category) || '',
      reference: normalizeOptionalText(product.reference) || '',
      summary: normalizeOptionalText(product.summary) || '',
      description: normalizeOptionalText(product.description) || '',
      keywords: normalizeOptionalTextList(product.keywords),
      aiData: normalizeOptionalObject(product.aiData),
      page: Number.isFinite(Number(product.page)) ? Number(product.page) : undefined,
      productionTime: Number.isFinite(Number(product.productionTime))
        ? Number(product.productionTime)
        : undefined,
      options,
    },
  };
}

export function resolvePriceTier(quantity) {
  return (
    PRICE_TIERS.find((tier) => quantity <= tier.maxQuantity) || PRICE_TIERS[PRICE_TIERS.length - 1]
  );
}

export function weightInGrams(option) {
  const grams = Number(option?.weight);
  return Number.isFinite(grams) ? grams : null;
}

export function unitPriceFromWeight(weight, quantity) {
  if (!Number.isFinite(weight)) return null;
  return Math.round((weight * resolvePriceTier(quantity).rate) / 1000);
}

export function productionTimeMinutes(product, option) {
  const optionMinutes = Number(option?.productionTime);
  if (Number.isFinite(optionMinutes) && optionMinutes > 0) return optionMinutes;
  const minutes = Number(product?.productionTime);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PRODUCTION_TIME_MINUTES;
}

export function lineProductionMinutes(product, quantity, option) {
  return (productionTimeMinutes(product, option) * quantity) / 10;
}

export function buildQuote(items, resolveProduct, options = {}) {
  const maxQuantity = options.maxQuantity || DEFAULT_MAX_ITEM_QUANTITY;
  const normalizedItems = Array.isArray(items) ? items : [];
  if (!normalizedItems.length) {
    return {
      items: [],
      subtotal: 0,
      shipping: 0,
      total: 0,
      productionEstimateHours: 0,
      productionEstimateMinutes: 0,
    };
  }

  const quotedItems = normalizedItems.map((entry) => {
    const quantity = Number(entry?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > maxQuantity) {
      const error = new Error('Quantidade inválida.');
      error.code = 'INVALID_QUANTITY';
      throw error;
    }

    const product = resolveProduct(entry?.productId);
    if (!product) {
      const error = new Error(`Produto não encontrado: ${entry?.productId}`);
      error.code = 'PRODUCT_NOT_FOUND';
      throw error;
    }

    const matchedOption = (product.options || []).find(
      (candidate) => candidate.name === entry?.optionName
    );
    const option =
      matchedOption ||
      ((product.options || []).length === 1 ? primaryProductOption(product) : null);
    if (!option) {
      const error = new Error(`Produto não encontrado: ${entry?.optionName || product.name}`);
      error.code = 'OPTION_NOT_FOUND';
      throw error;
    }

    const unitWeightGrams = weightInGrams(option);
    if (!Number.isFinite(unitWeightGrams)) {
      const error = new Error(`Peso inválido para ${product.name} - ${option.name}`);
      error.code = 'INVALID_WEIGHT';
      throw error;
    }

    const unitPrice = unitPriceFromWeight(unitWeightGrams, quantity);
    const lineTotal = unitPrice * quantity;
    const productionMinutes = lineProductionMinutes(product, quantity, option);

    return {
      productId: product.id,
      optionName: option.name || product.name,
      productNameSnapshot: product.name,
      unitWeightGrams,
      quantity,
      unitPrice,
      lineTotal,
      productionTimeMinutes: productionTimeMinutes(product, option),
      productionLineMinutes: productionMinutes,
      imageUrl: option.imageUrl || '',
      category: product.category || '',
      reference: product.reference || '',
    };
  });

  const subtotal = quotedItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const productionEstimateMinutes = quotedItems.reduce(
    (sum, item) => sum + item.productionLineMinutes,
    0
  );

  return {
    items: quotedItems,
    subtotal,
    shipping: 0,
    total: subtotal,
    productionEstimateHours: Number((productionEstimateMinutes / 60).toFixed(2)),
    productionEstimateMinutes: Math.round(productionEstimateMinutes),
  };
}

export function sortProducts(products, sort = 'recommended') {
  const list = [...products];
  if (sort === 'name') {
    return list.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  }
  if (sort === 'price') {
    return list.sort((left, right) => {
      const leftPrice = minProductPrice(left);
      const rightPrice = minProductPrice(right);
      return leftPrice - rightPrice;
    });
  }
  return list.sort((left, right) => productScore(right) - productScore(left));
}

function productScore(product) {
  const option = primaryProductOption(product);
  return Number(option?.score) || 0;
}

function minProductPrice(product) {
  const option = primaryProductOption(product);
  const price = unitPriceFromWeight(weightInGrams(option), 1);
  return Number.isFinite(price) ? price : Infinity;
}
