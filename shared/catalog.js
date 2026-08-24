export function primaryProductOption(product = {}) {
  const options = Array.isArray(product?.options) ? product.options : [];
  return options[0] || null;
}

export function productFamilyKey(product = {}) {
  const explicit = firstFilled(product?.groupKey, product?.familyKey);
  if (explicit) return explicit;
  const id = String(product?.id || '').trim();
  if (!id) return '';
  return id.includes('--') ? id.split('--')[0] : id;
}

export function hasLegacyProductVariations(product = {}) {
  const options = Array.isArray(product?.options) ? product.options : [];
  return options.length > 1;
}

export function groupCatalogProducts(products = []) {
  const grouped = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const key = productFamilyKey(product) || String(product?.id || '').trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(product);
  }

  return [...grouped.values()].map(buildCatalogFamily);
}

export function flattenCatalogProducts(products = []) {
  return products.flatMap(flattenLegacyProduct);
}

export function optionDisplayName(option = {}) {
  return buildVariantName(
    firstFilled(option?.model, option?.name),
    firstFilled(option?.size, option?.variant)
  );
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

function buildCatalogFamily(products = []) {
  const members = products.filter(Boolean);
  const representative = members[0] || {};
  const familyName =
    firstFilled(representative.groupName, representative.familyName) ||
    commonNamePrefix(members.map((product) => product.name)) ||
    String(representative.name || '').trim();

  const options = dedupeOptionNames(
    members.flatMap((product) => buildFamilyOptions(product, familyName, members.length > 1))
  );
  const updatedAt =
    members
      .map((product) => String(product?.updatedAt || '').trim())
      .filter(Boolean)
      .sort()
      .at(-1) || representative.updatedAt;
  const createdAt =
    members
      .map((product) => String(product?.createdAt || '').trim())
      .filter(Boolean)
      .sort()[0] || representative.createdAt;

  return {
    ...representative,
    id: productFamilyKey(representative) || representative.id,
    groupKey: productFamilyKey(representative) || representative.id,
    name: familyName || representative.name,
    summary:
      firstFilled(...members.map((product) => product.summary)) ||
      String(representative.summary || ''),
    description:
      firstFilled(...members.map((product) => product.description)) ||
      String(representative.description || ''),
    reference:
      firstFilled(...members.map((product) => product.reference)) ||
      String(representative.reference || ''),
    productionTime:
      numberOrUndefined(representative.productionTime) ??
      numberOrUndefined(primaryProductOption({ options })?.productionTime),
    options,
    sourceProductIds: members.map((product) => product.id).filter(Boolean),
    grouped: members.length > 1 || options.length > 1,
    createdAt,
    updatedAt,
  };
}

function buildFamilyOptions(product = {}, familyName, multipleMembers) {
  const options = Array.isArray(product?.options) ? product.options.filter(Boolean) : [];
  if (!options.length) return [];
  return options.map((option, index) => {
    const model =
      firstFilled(option?.model) ||
      deriveModelLabel(product, option, familyName, multipleMembers) ||
      firstFilled(option?.name, product?.name);
    const size = firstFilled(option?.size, option?.variant);
    const name = buildVariantName(model, size) || firstFilled(option?.name, product?.name);
    const imageUrl = firstFilled(
      option?.imageUrl,
      Array.isArray(option?.imageGallery) ? option.imageGallery[0] : '',
      option?.thumb,
      product?.reference
    );

    return {
      ...option,
      name,
      model: model || undefined,
      size: size || undefined,
      imageUrl: imageUrl || option?.imageUrl || '',
      sourceProductId: product.id,
      sourceOptionName: firstFilled(option?.name),
      sourceOptionIndex: index,
    };
  });
}

function deriveModelLabel(product = {}, option = {}, familyName, multipleMembers) {
  if (!multipleMembers) return firstFilled(option?.name);
  const strippedProductName = stripFamilyNamePrefix(product?.name, familyName);
  const strippedOptionName = stripFamilyNamePrefix(option?.name, familyName);
  return strippedProductName || strippedOptionName || firstFilled(option?.name, product?.name);
}

function stripFamilyNamePrefix(value, familyName) {
  const text = String(value || '').trim();
  const family = String(familyName || '').trim();
  if (!text || !family) return '';
  const lowerText = text.toLocaleLowerCase('pt-BR');
  const lowerFamily = family.toLocaleLowerCase('pt-BR');
  if (lowerText === lowerFamily) return '';
  if (!lowerText.startsWith(lowerFamily)) return '';
  return text
    .slice(family.length)
    .replace(/^[\s:|–—-]+/, '')
    .trim();
}

function buildVariantName(model, size) {
  const values = [String(model || '').trim(), String(size || '').trim()].filter(Boolean);
  return values.join(' · ');
}

function dedupeOptionNames(options = []) {
  const seen = new Map();
  return options.map((option) => {
    const key = String(option?.name || '').trim() || String(option?.sourceProductId || '').trim();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 1) return option;
    return {
      ...option,
      name: `${key} (${count})`,
    };
  });
}

function commonNamePrefix(values = []) {
  const names = values.map((value) => String(value || '').trim()).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  const normalized = names.map((value) =>
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .toLocaleLowerCase('pt-BR')
      .split(/\s+/)
      .filter(Boolean)
  );
  const first = normalized[0];
  let prefixLength = 0;
  while (
    prefixLength < first.length &&
    normalized.every((tokens) => tokens[prefixLength] === first[prefixLength])
  ) {
    prefixLength += 1;
  }
  if (prefixLength < 2) return '';
  return names[0].split(/\s+/).slice(0, prefixLength).join(' ').trim();
}
