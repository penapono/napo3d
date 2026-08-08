const state = { items: [], filters: { query: '', category: 'all', source: 'all', material: 'all', sort: 'recommended', recommended: false, confirmed: false, ams: false } };
const $ = (selector) => document.querySelector(selector);
const catalog = $('#catalog');

const formatCurrency = (value) => value == null || Number.isNaN(value) ? 'Não informado' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const safeText = (value, fallback = 'Não informado') => value === null || value === undefined || value === '' ? fallback : String(value);
const escapeHtml = (value) => safeText(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const optionWeight = (option) => option.weight == null ? null : Number(option.weight);
const roundUpToFive = (value) => value == null || Number.isNaN(Number(value)) ? null : Math.ceil(Number(value) / 5) * 5;
const optionCost = (option) => roundUpToFive(optionWeight(option));
const optionScore = (option) => Number(option.score) || 0;
const isConfirmed = (option) => String(option.weight_kind || '').toLowerCase().includes('confirm');
const allOptions = () => state.items.flatMap((item) => item.options.map((option) => ({ ...option, product: item })));

function uniqueValues(key) {
  return [...new Set(allOptions().map((option) => option[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
}

function populateFilters() {
  const categories = [...new Set(state.items.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('#category').insertAdjacentHTML('beforeend', categories.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''));
  $('#material').insertAdjacentHTML('beforeend', uniqueValues('material').map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''));
}

function updateStats() {
  const options = allOptions();
  $('#stat-products').textContent = state.items.length;
  $('#stat-options').textContent = options.length;
  $('#stat-recommended').textContent = options.filter((option) => option.score === Math.max(...option.product.options.map(optionScore))).length;
  $('#stat-confirmed').textContent = options.filter(isConfirmed).length;
}

function getVisibleItems() {
  const { query, category, source, material, sort, recommended, confirmed, ams } = state.filters;
  const normalizedQuery = query.trim().toLowerCase();
  return state.items.map((item) => {
    let options = item.options.filter((option) => {
      const haystack = `${item.name} ${item.category} ${item.summary} ${option.name} ${option.source} ${option.material}`.toLowerCase();
      const productMatches = !normalizedQuery || haystack.includes(normalizedQuery);
      const matchesSource = source === 'all' || option.source === source;
      const matchesMaterial = material === 'all' || option.material === material;
      const matchesRecommended = !recommended || option.score === Math.max(...item.options.map(optionScore));
      const matchesConfirmed = !confirmed || isConfirmed(option);
      const matchesAms = !ams || String(option.ams).toLowerCase() === 'sim';
      return productMatches && matchesSource && matchesMaterial && matchesRecommended && matchesConfirmed && matchesAms;
    });
    const productMatches = !normalizedQuery || `${item.name} ${item.category} ${item.summary}`.toLowerCase().includes(normalizedQuery);
    if (productMatches && category !== 'all' && item.category !== category) options = [];
    return { ...item, options };
  }).filter((item) => item.options.length);
}

function sortedOptions(options) {
  const sort = state.filters.sort;
  return [...options].sort((a, b) => {
    if (sort === 'weight') return (optionWeight(a) ?? Infinity) - (optionWeight(b) ?? Infinity);
    if (sort === 'time') return (Number(a.time) || Infinity) - (Number(b.time) || Infinity);
    if (sort === 'rating') return optionScore(b) - optionScore(a);
    return optionScore(b) - optionScore(a) || (optionWeight(a) ?? Infinity) - (optionWeight(b) ?? Infinity);
  });
}

function imageMarkup(url, alt, className = '') {
  if (!url || url.startsWith('data:image')) return `<div class="reference-fallback ${className}">Imagem de referência<br><small>Não informada</small></div>`;
  return `<img class="${className}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="reference-fallback" hidden>Imagem indisponível</span>`;
}

function optionMarkup(option, index, item) {
  const best = option.score === Math.max(...item.options.map(optionScore));
  const weight = optionWeight(option);
  return `<article class="option${best ? ' recommended' : ''}">${best ? '<span class="recommend-label">RECOMENDADA</span>' : ''}<div class="option-image">${imageMarkup(option.imageUrl, option.name, 'option-thumb')}<span class="reference-fallback" hidden>Imagem indisponível</span></div><div class="option-body"><span class="option-source">${escapeHtml(option.source)} · opção ${index + 1}</span><h4>${escapeHtml(option.name)}</h4><div class="metric-grid"><div class="metric"><span class="metric-label">Medidas</span><span class="metric-value">${escapeHtml(option.dims)}</span></div><div class="metric"><span class="metric-label">Tempo</span><span class="metric-value">${escapeHtml(option.time)}${option.time && option.time !== 'N/I' ? ' min' : ''}</span></div><div class="metric"><span class="metric-label">Peso</span><span class="metric-value">${weight == null ? 'Não informado' : `${weight} g`}</span></div><div class="metric"><span class="metric-label">Material</span><span class="metric-value">${escapeHtml(option.material)}</span></div><div class="metric"><span class="metric-label">Cores / AMS</span><span class="metric-value">${escapeHtml(option.colors)} · ${escapeHtml(option.ams)}</span></div></div><p class="option-note">${isConfirmed(option) ? 'Peso confirmado' : 'Peso estimado para orçamento'} · ${escapeHtml(option.license)}</p><a class="model-link" href="${escapeHtml(option.url)}" target="_blank" rel="noopener noreferrer">Abrir modelo ↗</a></div></article>`;
}

function renderProduct(item) {
  const options = sortedOptions(item.options);
  return `<article class="product"><div class="product-reference">${imageMarkup(item.reference, `Referência: ${item.name}`, 'reference-image')}</div><div class="product-info"><span class="eyebrow">Referência do catálogo · Página ${escapeHtml(item.page)}</span><h3>${escapeHtml(item.name)}</h3><p class="product-summary">${escapeHtml(item.summary)}</p><div class="product-meta"><span class="pill">${escapeHtml(item.category)}</span><span class="pill">${options.length} ${options.length === 1 ? 'alternativa' : 'alternativas'}</span><span class="pill">R$ 0,40/g</span></div></div><div class="options">${options.map((option, index) => optionMarkup(option, index, item)).join('')}</div></article>`;
}

function renderTable(items) {
  $('#summary-table').innerHTML = items.map((item) => { const weights = item.options.map(optionWeight).filter((weight) => weight != null); const sources = [...new Set(item.options.map((option) => option.source))].join(' / '); const decision = item.options.find((option) => option.score === Math.max(...item.options.map(optionScore))); return `<tr><td>${escapeHtml(item.name)}</td><td>${item.options.length}</td><td>${weights.length ? `${roundUpToFive(Math.min(...weights))} g` : 'Não informado'}</td><td>${escapeHtml(sources)}</td><td class="decision">${decision ? 'Avaliar recomendada' : 'Sem indicação'}</td></tr>`; }).join('');
}

function render() {
  const visible = getVisibleItems();
  catalog.innerHTML = visible.map(renderProduct).join('');
  $('#empty-state').hidden = visible.length > 0;
  $('#result-count').textContent = `${visible.length} ${visible.length === 1 ? 'produto encontrado' : 'produtos encontrados'}`;
  renderTable(visible);
}

function bindEvents() {
  const map = { search: 'query', category: 'category', source: 'source', material: 'material', sort: 'sort' };
  Object.entries(map).forEach(([id, key]) => { $(`#${id}`).addEventListener('input', (event) => { state.filters[key] = event.target.value; render(); }); });
  [['only-recommended', 'recommended'], ['only-confirmed', 'confirmed'], ['only-ams', 'ams']].forEach(([id, key]) => { $(`#${id}`).addEventListener('change', (event) => { state.filters[key] = event.target.checked; render(); }); });
  $('#clear-filters').addEventListener('click', () => { Object.assign(state.filters, { query: '', category: 'all', source: 'all', material: 'all', sort: 'recommended', recommended: false, confirmed: false, ams: false }); $('#search').value = ''; ['category', 'source', 'material', 'sort'].forEach((id) => { $(`#${id}`).value = state.filters[id]; }); ['only-recommended', 'only-confirmed', 'only-ams'].forEach((id) => { $(`#${id}`).checked = false; }); render(); });
}

async function init() { try { const response = await fetch('./data/models.json'); if (!response.ok) throw new Error(`HTTP ${response.status}`); state.items = await response.json(); populateFilters(); updateStats(); bindEvents(); render(); } catch (error) { catalog.innerHTML = '<div class="empty-state"><strong>Não foi possível carregar o catálogo.</strong><span>Verifique se o site está sendo servido por um servidor HTTP.</span></div>'; console.error('[v0] Erro ao carregar models.json:', error); } }
init();
