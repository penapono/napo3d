// Run in the MakerWorld collection tab (javascript_tool) AFTER every card is loaded.
// Cards load by infinite scroll and only REAL mouse-wheel scrolling triggers it, so scroll
// with the computer tool (scroll down 10 ticks, wait 3s, repeat) until the page text shows
// "Sem mais dados" / "No more data" and the count equals the collection total.
const urls = [
  ...new Set(
    [...document.querySelectorAll('a[href*="/models/"]')].map((a) => a.href.split('?')[0])
  ),
];
window.__urls = urls;
({ count: urls.length, ids: new Set(urls.map((u) => u.match(/models\/(\d+)/)[1])).size });
// Then read the list back in slices of <= 14 URLs (tool output truncates near 1000 chars):
//   window.__urls.slice(0, 14).map(u => u.split('/models/')[1]).join('\n')
