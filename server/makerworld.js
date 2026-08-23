const DEFAULT_MAKERWORLD_SCRAPER_URL = 'http://127.0.0.1:8010';
const MAKERWORLD_HOSTS = new Set(['makerworld.com', 'www.makerworld.com']);

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
  let reference = '';
  let summary = String(product.summary || '').trim();
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
    const bestProfile = payload.best_profile || {};
    const imageGallery = selectMakerWorldModelImages(payload.image_urls);
    const imageUrl = firstText(imageGallery[0]) || firstText(option.imageUrl);
    const weightGrams = Number(bestProfile.weight_grams);
    const printTimeMinutes = secondsToMinutes(bestProfile.print_time_seconds);
    const next = {
      ...option,
      url: normalizeMakerWorldUrl(payload.url) || normalizeMakerWorldUrl(option.url) || option.url,
      imageUrl: imageUrl || option.imageUrl || '',
      imageGallery,
      source: 'MakerWorld',
      time: firstText(bestProfile.print_time) || option.time || '',
      rating: formatMakerWorldRating(bestProfile) || option.rating || '',
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

    if (!reference && next.imageUrl) {
      reference = next.imageUrl;
    }

    if (makerWorldTargetCount === 1) {
      summary = firstText(payload.description) || summary;
      productionTime = printTimeMinutes || productionTime;
    }

    return next;
  });

  return {
    reference: reference || String(product.reference || '').trim(),
    summary,
    productionTime,
    options,
  };
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

function selectMakerWorldModelImages(imageUrls) {
  const values = Array.isArray(imageUrls) ? imageUrls : [];
  const filtered = values.map(firstText).filter((url) => {
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
        const parsed = new URL(url);
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

function firstText(value) {
  const text = String(value || '').trim();
  return text || '';
}

function formatMakerWorldRating(profile = {}) {
  const rating = Number(profile.rating);
  const ratingCount = Number(profile.rating_count);
  if (!Number.isFinite(rating) || rating <= 0) return '';
  if (Number.isFinite(ratingCount) && ratingCount > 0) {
    return `${rating.toFixed(1)} (${ratingCount})`;
  }
  return rating.toFixed(1);
}

function makeScraperError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}
