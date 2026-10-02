// Run in any makerworld.com tab (same origin => no Cloudflare block). Set window.__todo to the
// list of NEW model URLs first, e.g. window.__todo = ['https://makerworld.com/pt/models/1-x'];
// then run this file. It fetches each page politely (2 workers, ~1s apart), reads the page's
// __NEXT_DATA__ and builds the same payload shape the scraper service returns.
// Poll window.__done / window.__running; results are in window.__payloads (+ window.__errors).
window.__payloads = {};
window.__errors = {};
window.__done = 0;
const strip = (h) =>
  String(h || '')
    .replace(/<boostme>.*?<\/boostme>/gs, '')
    .replace(/<(br|\/p|\/h\d|\/li|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
const fmt = (s) => {
  let h = Math.floor(s / 3600);
  let m = Math.round((s % 3600) / 60);
  if (m === 60) {
    h++;
    m = 0;
  }
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};
async function one(url) {
  const r = await fetch(url.replace('https://makerworld.com', ''));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  const m = t.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error('no next data');
  const d = JSON.parse(m[1]).props.pageProps.design;
  if (!d || !d.id) throw new Error('no design');
  const profs = (d.instances || [])
    .filter((i) => Number(i.weight) > 0)
    .map((i) => ({
      id: String(i.id),
      name: i.title,
      rating: i.ratingCount > 0 ? Math.round((i.ratingScoreTotal / i.ratingCount) * 100) / 100 : null,
      rating_count: i.ratingCount || 0,
      print_time_seconds: Number(i.prediction) || null,
      weight_grams: Number(i.weight),
    }));
  profs.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.rating_count - a.rating_count);
  const b = profs[0] || null;
  const pics = ((d.designExtension && d.designExtension.design_pictures) || []).map((p) => p.url).filter(Boolean);
  return {
    url,
    model_id: String(d.id),
    name: d.title,
    description: strip(d.summary).slice(0, 4000),
    image_urls: [d.coverUrl, ...pics].filter(Boolean),
    best_profile: b && {
      id: b.id,
      name: b.name,
      rating: b.rating,
      rating_count: b.rating_count,
      print_time_seconds: b.print_time_seconds,
      print_time: b.print_time_seconds ? fmt(b.print_time_seconds) : null,
      weight_grams: b.weight_grams,
    },
  };
}
const queue = [...window.__todo];
window.__running = true;
(async () => {
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        window.__payloads[u] = await one(u);
      } catch (e) {
        window.__errors[u] = String(e.message);
      }
      window.__done++;
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
    }
  };
  await Promise.all([worker(), worker()]);
  window.__running = false;
})();
'started';
// To get the data out of the browser: focus the tab (click once with the computer tool), then
//   await navigator.clipboard.writeText(JSON.stringify(window.__payloads))
// and on the Mac: pbpaste > /tmp/payloads.json. (A second blob download is silently blocked,
// and localhost POSTs are blocked by the page CSP.)
