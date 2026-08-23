import { primaryProductOption } from '../shared/catalog.js';

const DEFAULT_OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const NEW_CATEGORY_SENTINEL = '__new__';

export function isAiProductEnrichmentConfigured(options = {}) {
  return Boolean(resolveApiKey(options));
}

export function collectProductImageUrls(product = {}) {
  const option = primaryProductOption(product) || {};
  const candidates = [
    ...(Array.isArray(option.imageGallery) ? option.imageGallery : []),
    option.imageUrl,
    option.thumb,
    product.reference,
  ];
  const seen = new Set();
  return candidates
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!/^https?:\/\//i.test(value)) return false;
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, 3);
}

export async function enrichProductWithOpenAi(product, catalogCategories, options = {}) {
  const apiKey = resolveApiKey(options);
  if (!apiKey) {
    throw makeAiError(
      'AI_ENRICHMENT_UNAVAILABLE',
      'OpenAI não está configurada para enriquecer os produtos.'
    );
  }

  const imageUrls = collectProductImageUrls(product);
  const title = String(product?.name || '').trim();
  if (!title || !imageUrls.length) {
    throw makeAiError(
      'AI_ENRICHMENT_INPUT_INVALID',
      'O produto precisa ter nome e ao menos uma imagem para enriquecimento por IA.'
    );
  }

  const categories = normalizeCategories(catalogCategories);
  const model = resolveModel(options);
  const payload = await createResponsePayload(product, imageUrls, categories, model);
  const responsePayload = await requestOpenAi(payload, {
    apiKey,
    apiUrl: resolveApiUrl(options),
    fetchImpl: options.fetchImpl || fetch,
  });

  const parsed = parseResponseJson(responsePayload);
  return buildProductEnrichment(parsed, {
    product,
    categories,
    model,
    imageCount: imageUrls.length,
  });
}

async function createResponsePayload(product, imageUrls, categories, model) {
  const option = primaryProductOption(product) || {};
  const rating = Number(option.rating);
  const ratingCount = Number(option.ratingCount);
  const weight = Number(option.weight);
  const productionTime = Number(option.productionTime || product.productionTime);
  const currentCategory = String(product.category || '').trim();
  const currentSummary = String(product.summary || '').trim();
  const currentDescription = String(product.description || '').trim();

  return {
    model,
    input: [
      {
        role: 'system',
        content:
          'Você escreve fichas comerciais em português do Brasil para um catálogo de impressão 3D. Use somente o que for visível nas imagens e nos dados fornecidos. Não invente materiais, dimensões, mecanismos internos nem promessas não verificáveis. Prefira texto curto, claro e comercial.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Analise este produto e devolva um JSON válido.',
              `Título do modelo: ${titleLine(product.name)}`,
              currentCategory
                ? `Categoria atual: ${currentCategory}`
                : 'Categoria atual: não definida',
              currentSummary ? `Resumo atual: ${currentSummary}` : 'Resumo atual: vazio',
              currentDescription
                ? `Descrição atual: ${currentDescription}`
                : 'Descrição atual: vazia',
              Number.isFinite(weight) && weight > 0 ? `Peso em gramas: ${Math.round(weight)}` : '',
              Number.isFinite(productionTime) && productionTime > 0
                ? `Tempo de produção em minutos: ${Math.round(productionTime)}`
                : '',
              Number.isFinite(rating) && rating > 0 ? `Nota: ${rating.toFixed(1)}` : '',
              Number.isFinite(ratingCount) && ratingCount > 0
                ? `Quantidade de avaliações: ${Math.round(ratingCount)}`
                : '',
              categories.length
                ? `Categorias existentes: ${categories.join(', ')}`
                : 'Categorias existentes: nenhuma',
              `Regras:
- escreva tudo em português do Brasil
- shortDescription: 1 frase, até 140 caracteres
- richDescription: 2 a 4 frases, atraente e específica
- selectedCategory: escolha uma das categorias existentes quando houver encaixe claro
- se nenhuma categoria existente servir bem, use "${NEW_CATEGORY_SENTINEL}" e preencha newCategory
- keywords: 3 a 6 palavras ou expressões curtas úteis para busca
- confidence: número de 0 a 1`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
          ...imageUrls.map((url) => ({
            type: 'input_image',
            image_url: url,
            detail: 'auto',
          })),
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'product_enrichment',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'shortDescription',
            'richDescription',
            'selectedCategory',
            'newCategory',
            'keywords',
            'confidence',
          ],
          properties: {
            shortDescription: { type: 'string' },
            richDescription: { type: 'string' },
            selectedCategory: {
              type: 'string',
              enum: [...categories, NEW_CATEGORY_SENTINEL],
            },
            newCategory: { type: 'string' },
            keywords: {
              type: 'array',
              minItems: 3,
              maxItems: 6,
              items: { type: 'string' },
            },
            confidence: { type: 'number' },
          },
        },
      },
    },
  };
}

async function requestOpenAi(payload, options) {
  let response;
  try {
    response = await options.fetchImpl(options.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw makeAiError(
      'AI_ENRICHMENT_UNAVAILABLE',
      'Não foi possível acessar a OpenAI para enriquecer o produto.',
      error
    );
  }

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const message = parsed?.error?.message || 'A OpenAI recusou a geração da descrição do produto.';
    throw makeAiError('AI_ENRICHMENT_FAILED', message);
  }

  return parsed;
}

function parseResponseJson(payload = {}) {
  const outputText = firstTextCandidate(payload);
  if (!outputText) {
    throw makeAiError(
      'AI_ENRICHMENT_FAILED',
      'A OpenAI não devolveu um conteúdo utilizável para o enriquecimento.'
    );
  }
  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw makeAiError(
      'AI_ENRICHMENT_FAILED',
      'A OpenAI devolveu um JSON inválido para o enriquecimento.',
      error
    );
  }
}

function firstTextCandidate(payload = {}) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const entry of content) {
      const candidate =
        typeof entry?.text === 'string'
          ? entry.text
          : typeof entry?.content?.[0]?.text === 'string'
            ? entry.content[0].text
            : '';
      if (candidate.trim()) return candidate.trim();
    }
  }
  return '';
}

function buildProductEnrichment(result, context) {
  const selectedCategory = normalizeChosenCategory(
    result?.selectedCategory,
    result?.newCategory,
    context.categories,
    context.product?.category
  );
  const summary = clampSentence(result?.shortDescription, 140);
  const description = clampParagraph(result?.richDescription, 560);
  const keywords = normalizeKeywordList(result?.keywords);
  const confidence = normalizeConfidence(result?.confidence);
  return {
    summary,
    description: description || summary,
    category: selectedCategory,
    keywords,
    aiData: {
      provider: 'openai',
      model: context.model,
      generatedAt: new Date().toISOString(),
      confidence,
      tags: keywords,
      imageCount: context.imageCount,
      selectedCategory,
      source: 'images_and_title',
      lastError: '',
    },
  };
}

function normalizeChosenCategory(selectedCategory, newCategory, categories, fallback) {
  const selected = String(selectedCategory || '').trim();
  if (selected && selected !== NEW_CATEGORY_SENTINEL) {
    return matchExistingCategory(selected, categories) || selected;
  }
  const created = String(newCategory || '').trim();
  if (created) return created;
  return String(fallback || '').trim();
}

function matchExistingCategory(candidate, categories) {
  const normalized = candidate.toLocaleLowerCase('pt-BR');
  return categories.find((entry) => entry.toLocaleLowerCase('pt-BR') === normalized) || '';
}

function normalizeCategories(categories) {
  const seen = new Set();
  return (Array.isArray(categories) ? categories : [])
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value) return false;
      const key = value.toLocaleLowerCase('pt-BR');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

function normalizeKeywordList(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => clampSentence(value, 40))
    .filter((value) => {
      if (!value) return false;
      const key = value.toLocaleLowerCase('pt-BR');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.min(1, Math.round(number * 100) / 100));
}

function clampSentence(value, maxLength) {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function clampParagraph(value, maxLength) {
  return clampSentence(value, maxLength);
}

function titleLine(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function resolveApiKey(options) {
  return String(options.apiKey || process.env.OPENAI_API_KEY || '').trim();
}

function resolveApiUrl(options) {
  return String(options.apiUrl || process.env.OPENAI_API_URL || DEFAULT_OPENAI_API_URL).trim();
}

function resolveModel(options) {
  return String(
    options.model || process.env.OPENAI_PRODUCT_ENRICHMENT_MODEL || DEFAULT_OPENAI_MODEL
  ).trim();
}

function makeAiError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}
