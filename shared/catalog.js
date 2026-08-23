export function primaryProductOption(product = {}) {
  const options = Array.isArray(product?.options) ? product.options : [];
  return options[0] || null;
}

export function hasLegacyProductVariations(product = {}) {
  const options = Array.isArray(product?.options) ? product.options : [];
  return options.length > 1;
}

export function flattenCatalogProducts(products = []) {
  return products.flatMap(flattenLegacyProduct);
}

export function flattenLegacyProduct(product = {}) {
  const options = Array.isArray(product?.options) ? product.options.filter(Boolean) : [];
  if (!options.length) return [{ ...product, options: [] }];

  const multipleOptions = options.length > 1;
  return options.map((option, index) => {
    const suffix = slugSuffix(option?.name, index);
    const id = multipleOptions && index > 0 ? `${product.id}--${suffix}` : product.id;
    const name = multipleOptions
      ? joinName(product.name, option?.name)
      : String(product.name || '').trim();
    const imageUrl = firstFilled(
      option?.imageUrl,
      Array.isArray(option?.imageGallery) ? option.imageGallery[0] : '',
      option?.thumb,
      product.reference
    );
    const summary = firstFilled(option?.notes, product.summary);
    const productionTime =
      numberOrUndefined(option?.productionTime) ?? numberOrUndefined(product.productionTime);

    return {
      ...product,
      id,
      name: name || String(option?.name || '').trim() || String(product.id || '').trim(),
      summary: summary || '',
      productionTime,
      options: [{ ...option, imageUrl: imageUrl || option?.imageUrl || '' }],
    };
  });
}

export function buildCategoryCounts(products = []) {
  const counts = new Map();
  for (const product of products) {
    const category = String(product?.category || '').trim();
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0], 'pt-BR'))
    .map(([name, count]) => ({ name, count }));
}

function joinName(productName, optionName) {
  const base = String(productName || '').trim();
  const option = String(optionName || '').trim();
  if (!base) return option;
  if (!option || option === base) return base;
  return `${base} — ${option}`;
}

function slugSuffix(value, index) {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'item'}-${index + 1}`;
}

function firstFilled(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
