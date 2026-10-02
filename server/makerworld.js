const DEFAULT_MAKERWORLD_SCRAPER_URL = 'http://127.0.0.1:8010';
const MAKERWORLD_HOSTS = new Set(['makerworld.com', 'www.makerworld.com']);
const MAGLEV_PATTERN = /\bmaglev\b/i;
const MAGLEV_NEGATION_PATTERN = /\b(?:sem|without|no)\s+maglev\b/i;

export function normalizeMakerWorldUrl(value) {
  if (!value) return '';
  try {
    const url = toPortugueseMakerWorldUrl(new URL(String(value).trim()));
    const host = url.hostname.toLowerCase();
    if (!MAKERWORLD_HOSTS.has(host)) return '';
    if (!/\/models\/\d+/i.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function makerWorldOptionTargets(product = {}) {
  const options = Array.isArray(product.options) ? product.options : [];
  return options.flatMap((option, index) => {
    const url = normalizeMakerWorldUrl(option?.url);
    return url ? [{ index, option, url }] : [];
  });
}

export function hasMakerWorldOptions(product = {}) {
  return makerWorldOptionTargets(product).length > 0;
}

export async function scrapeMakerWorldModel(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const scraperUrl = String(
    options.scraperUrl || process.env.MAKERWORLD_SCRAPER_URL || DEFAULT_MAKERWORLD_SCRAPER_URL
  )
    .trim()
    .replace(/\/+$/, '');

  if (!scraperUrl) {
    throw makeScraperError(
      'MAKERWORLD_SCRAPER_UNAVAILABLE',
      'Serviço do scraper MakerWorld não está configurado.'
    );
  }

  let response;
  try {
    response = await fetchImpl(`${scraperUrl}/scrape`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: normalizeMakerWorldUrl(url) || String(url || '').trim() }),
    });
  } catch (error) {
    throw makeScraperError(
      'MAKERWORLD_SCRAPER_UNAVAILABLE',
      'Não foi possível acessar o serviço do scraper MakerWorld.',
      error
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw makeScraperError(
      payload?.error?.code || 'MAKERWORLD_SCRAPER_FAILED',
      payload?.error?.message || 'Falha ao atualizar dados do MakerWorld.'
    );
  }

  return payload?.model || null;
}

export function mergeMakerWorldProductData(product, refreshes) {
  const now = new Date().toISOString();
  const refreshesByIndex = new Map(refreshes.map((entry) => [entry.target.index, entry]));
  const makerWorldTargetCount = makerWorldOptionTargets(product).length;
  let name = String(product.name || '').trim();
  let summary = String(product.summary || '').trim();
  let maglev = Boolean(product.maglev);
  let productionTime = Number(product.productionTime) || undefined;

  const options = (product.options || []).map((option, index) => {
    const refresh = refreshesByIndex.get(index);
    if (!refresh) return { ...option };

    if (refresh.error) {
      return {
        ...option,
        makerworldLastError: refresh.error.message || 'Falha ao consultar o MakerWorld.',
      };
    }

    const payload = refresh.payload || {};
    maglev = maglev || payloadRequiresMaglev(payload);
    const bestProfile = payload.best_profile || {};
    // Self-hosted copies (/product-images/...) win over remote MakerWorld URLs so a
    // refresh never swaps them back to hotlinked images.
    const keepLocalImages = hasLocalProductImages(option);
    const imageGallery = keepLocalImages
      ? [...option.imageGallery]
      : selectMakerWorldModelImages(payload.image_urls);
    const imageUrl = keepLocalImages
      ? firstText(option.imageUrl, imageGallery[0])
      : firstText(imageGallery[0]) || firstText(option.imageUrl);
    const modelName = firstText(payload.name) || firstText(option.name);
    const weightGrams = Number(bestProfile.weight_grams);
    const rating = normalizeRating(bestProfile.rating);
    const ratingCount = normalizeRatingCount(bestProfile.rating_count);
    const printTimeMinutes = secondsToMinutes(bestProfile.print_time_seconds);
    const next = {
      ...option,
      name: modelName || option.name,
      url: normalizeMakerWorldUrl(payload.url) || normalizeMakerWorldUrl(option.url) || option.url,
      imageUrl: imageUrl || option.imageUrl || '',
      imageGallery,
      source: 'MakerWorld',
      time: firstText(bestProfile.print_time) || option.time || '',
      rating,
      ratingCount,
      thumb: imageUrl || option.thumb || '',
      weight:
        Number.isFinite(weightGrams) && weightGrams > 0
          ? Math.max(1, Math.round(weightGrams))
          : option.weight,
      productionTime: printTimeMinutes || option.productionTime,
      weight_kind:
        Number.isFinite(weightGrams) && weightGrams > 0 ? 'makerworld' : option.weight_kind,
      makerworldModelId: firstText(payload.model_id) || option.makerworldModelId || '',
      makerworldSyncedAt: now,
      makerworldLastError: '',
    };

    if (makerWorldTargetCount === 1) {
      name = modelName || name;
      productionTime = printTimeMinutes || productionTime;
    }

    return next;
  });

  return {
    name,
    maglev,
    summary,
    productionTime,
    options,
  };
}

// Applies reviewed Brazilian Portuguese content (payload.pt) on top of a merged product:
// { name, summary, description, categories: [primary, ...] }. Empty fields are ignored.
export function applyPortugueseContent(product = {}, pt = {}) {
  const name = firstText(pt?.name);
  const categories = (Array.isArray(pt?.categories) ? pt.categories : [])
    .map((entry) => firstText(entry))
    .filter(Boolean);
  const next = { ...product };
  if (name) {
    next.name = name;
    next.options = (product.options || []).map((option, index) =>
      index === 0 ? { ...option, name } : option
    );
  }
  if (firstText(pt?.summary)) next.summary = firstText(pt.summary);
  if (firstText(pt?.description)) next.description = firstText(pt.description);
  if (categories.length) {
    next.category = categories[0];
    next.categories = categories;
  }
  return next;
}

function toPortugueseMakerWorldUrl(url) {
  const normalized = new URL(url.toString());
  const segments = normalized.pathname.split('/').filter(Boolean);
  if (segments[0] && /^[a-z]{2}(?:-[A-Z]{2})?$/i.test(segments[0])) {
    segments[0] = 'pt';
  } else {
    segments.unshift('pt');
  }
  normalized.hostname = 'makerworld.com';
  normalized.pathname = `/${segments.join('/')}`;
  normalized.hash = '';
  return normalized;
}

export const LOCAL_PRODUCT_IMAGE_PREFIX = '/product-images/';

// Replace remote image URLs on a product's options with self-hosted copies using a
// `{ remoteUrl: '/product-images/<hash>.webp' }` manifest. Unknown remote URLs are kept
// and reported so nothing silently breaks.
export function localizeProductImages(product = {}, manifest = {}) {
  let replaced = 0;
  const unmapped = new Set();
  const swap = (url) => {
    const value = firstText(url);
    if (!value || isLocalProductImage(value)) return value;
    const local = manifest[value];
    if (local) {
      replaced += 1;
      return local;
    }
    if (/^https?:/i.test(value)) unmapped.add(value);
    return value;
  };
  const options = (Array.isArray(product.options) ? product.options : []).map((option) => {
    const next = { ...option };
    if (option?.imageUrl) next.imageUrl = swap(option.imageUrl);
    if (option?.thumb) next.thumb = swap(option.thumb);
    if (Array.isArray(option?.imageGallery)) {
      next.imageGallery = [...new Set(option.imageGallery.map(swap).filter(Boolean))];
    }
    return next;
  });
  return { options, replaced, unmapped: [...unmapped] };
}

export function isLocalProductImage(url) {
  return firstText(url).startsWith(LOCAL_PRODUCT_IMAGE_PREFIX);
}

function hasLocalProductImages(option = {}) {
  const gallery = Array.isArray(option.imageGallery) ? option.imageGallery : [];
  return gallery.length > 0 && gallery.every(isLocalProductImage);
}

function selectMakerWorldModelImages(imageUrls) {
  const values = Array.isArray(imageUrls) ? imageUrls : [];
  const filtered = values.map(firstText).filter((url) => {
    if (isLocalProductImage(url)) return true;
    return (
      url &&
      /makerworld\.bblmw\.com/i.test(url) &&
      /\/model\//i.test(url) &&
      !/\/user\//i.test(url) &&
      !/\/static\//i.test(url)
    );
  });
  const seen = new Set();
  return filtered
    .filter((url) => {
      try {
        const parsed = new URL(url, 'https://napo3d.shop');
        const key = `${parsed.origin}${parsed.pathname}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 3);
}

function secondsToMinutes(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.max(1, Math.round(seconds / 60));
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function payloadRequiresMaglev(payload = {}) {
  const description = firstText(payload.description);
  if (!description) return false;
  return MAGLEV_PATTERN.test(description) && !MAGLEV_NEGATION_PATTERN.test(description);
}

function normalizeRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating) || rating <= 0) return undefined;
  return Math.round(rating * 10) / 10;
}

function normalizeRatingCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return Math.round(count);
}

function makeScraperError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}
