---
name: makerworld-collection-import
description: Use when the user wants to add new MakerWorld models to napo3d.shop from a collection (makerworld.com/<locale>/collections/<id>-<slug>), or says to sync/import the napo3d collection. Works with no URL (uses the default napo3d collection). Finds models not yet on the site and adds them translated to Brazilian Portuguese, with self-hosted photos and categories.
---

# MakerWorld collection → napo3d products

Input: a MakerWorld collection URL (optional). **Default collection** when the user gives no
URL: `https://makerworld.com/pt/collections/33800388-napo3d` (the napo3d collection, 209 models
on 2026-09-30). If the user passes a different URL, use that one instead; say which collection
you are using at the start. Output: new products live on https://napo3d.shop with
Portuguese names/descriptions, categories, and self-hosted WebP photos.

Repo root: `/Users/pnaponoceno/projects/penapono/napo3d`. This skill is installed globally, so
the session may start in ANY directory: before step 1, `cd` to the repo root (and use absolute
paths when a command cannot `cd`); all `scripts/`, `makerworld_scraper/` and `product-images/`
paths below are relative to it. Read the project's `AGENTS.md` there once. Prefix shell
commands with `rtk` (project rule). Production: `ubuntu@napo3d.shop`, app dir `/srv/napo3d/current`, compose
command `docker compose --env-file .env.production -f compose.production.yml`.

## Why a browser is involved

MakerWorld sits behind Cloudflare: plain HTTP/Scrapy/curl (and the production scraper service)
get a 403 "Just a moment..." page. Do NOT try to bypass it. Everything that talks to
makerworld.com runs inside the user's Chrome via the `claude-in-chrome` tools (load them with
ToolSearch, call `tabs_context_mcp` first, open a NEW tab). If the extension is not connected,
stop and ask the user to connect it.

## Workflow

Ask before anything that publishes (steps 7–8). Steps 1–6 are local/read-only.

1. **Collect URLs.** Navigate a new tab to the collection URL. Read the total from the page
   text (e.g. "209 modelos"). Cards lazy-load 20 at a time and ONLY real wheel scrolling loads
   more: use `computer` `scroll` down 10 ticks at (700,500), wait 3s, repeat until the page
   says "Sem mais dados" and the link count equals the total. Then run `collect-urls.js`
   (this skill folder) and read the list back in slices of 14 (output truncates ~1000 chars).
   Write the URLs to `/tmp/collection-urls.json` (JSON array).
2. **Diff against production (read-only).**
   ```
   cat /tmp/collection-urls.json | rtk proxy ssh ubuntu@napo3d.shop 'cd /srv/napo3d/current && docker compose --env-file .env.production -f compose.production.yml exec -T api sh -c "cat > /tmp/u.json && node scripts/collection-diff.mjs /tmp/u.json"'
   ```
   Prints `{ total, existing, newUrls }`. Report the counts. If `newUrls` is empty, stop.
   (Use `rtk proxy` for ssh when output is JSON: plain `rtk ssh` truncates it.)
3. **Fetch details for the new models only.** In the same tab (any makerworld.com page works):
   set `window.__todo = [...newUrls]`, run `extract-payloads.js`, poll `window.__done` /
   `window.__running` with short JS calls (a single call that waits >45s times out). Check
   `window.__errors`. Get the data out via the clipboard (click the page once, then
   `navigator.clipboard.writeText(JSON.stringify(window.__payloads))`), then
   `pbpaste > /tmp/payloads.json`. Sanity-check the count with python/node.
4. **Review photos.** `cd makerworld_scraper && .venv/bin/python flag_images.py --payloads
   /tmp/payloads.json --out /tmp/review` (create the venv with `python3 -m venv .venv &&
   .venv/bin/pip install -r requirements.txt numpy` if missing; needs `tesseract`). Read the
   sheet_NN.jpg files; red headers = OCR text or green "Customize" label. Show the user the
   flagged ones (model, why) and ask which to drop. Save the chosen source URLs (index.json
   `url`) as `/tmp/drop.json`. Prefer dropping over auto-editing: inpainting only works on
   plain backgrounds. Never leave a model with zero images.
5. **Translate to Brazilian Portuguese (you do it).** For each model write
   `/tmp/pt.json`: `{ "<model_id>": { "name", "summary", "description", "categories": [...] } }`.
   - `name`: natural pt-BR title, keep brand/franchise names, "Sem AMS" (not "No AMS"),
     "tealight", "fidget"; drop creator tags/emoji noise and "(No AMS Required)" style
     marketing. Keep it under ~70 chars.
   - `summary`: 1–2 sentences (≤ 160 chars) in the store's tone. `description`: 2–4 short
     sentences from the MakerWorld description, translated, without links or "boost me" text.
   - `categories`: first = primary. Fetch the existing list first
     (`curl -s 'https://napo3d.shop/api/products?limit=1'` → `categories`) and REUSE names;
     create a new one only if nothing fits. A product may have several (e.g. nativity scene →
     `["Religioso", "Natal"]`; Christmas items go in "Natal", seasonal ones in their own).
   Show the user a table of old → new names + categories and wait for approval.
6. **Prepare.** `cd makerworld_scraper && .venv/bin/python prepare_import.py --payloads
   /tmp/payloads.json --translations /tmp/pt.json --drop-images /tmp/drop.json --out
   /tmp/ready.json`. It stores 1200px WebP copies in `product-images/` (+ manifest) and writes
   payloads with local `image_urls` and the `pt` block. Read its SKIP lines (missing
   translation / no image / no print profile with weight) and tell the user.
7. **Commit + deploy the photos first** (explicit `git add product-images`, never `-A`/`.`):
   gitmoji commit (`✨ feat(images): add photos for <n> new products`), push `main`, wait for
   the "Deploy production" run (`gh run watch`), then check a few
   `https://napo3d.shop/product-images/<hash>.webp` return 200.
8. **Import (writes to production DB — confirm with the user).**
   ```
   cat /tmp/ready.json | rtk proxy ssh ubuntu@napo3d.shop 'cd /srv/napo3d/current && docker compose --env-file .env.production -f compose.production.yml exec -T api sh -c "cat > /tmp/ready.json && node scripts/import-makerworld-urls.mjs --urls-file=/tmp/urls-new.json --payloads-file=/tmp/ready.json --delay-ms=0 --limit=1"'
   ```
   `--urls-file` = JSON array of the URLs in ready.json (write it the same way). Do `--limit=1`
   first, verify that product on the live site (name, price, images, category), then run
   without `--limit`. The importer skips models already present and prints one JSON line per
   model (`imported` / `skip` / `error`).
9. **Verify.** Re-fetch `https://napo3d.shop/api/products` (all pages, `limit=48&page=N`):
   new products have Portuguese names, categories, `/product-images/...` images, none
   uncategorized, every image URL returns 200. Report counts + errors. Delete temp files in
   the container (`/tmp/*.json`).

## Gotchas

- **Cloudflare 403 everywhere except the user's browser.** The prod scraper service
  (`makerworld-scraper`) cannot fetch model pages; that is why payloads come from Chrome.
- **Scroll must be real.** `scrollTo`/synthetic wheel events do not load more cards; the
  `computer` tool's `scroll` does. The DOM keeps all cards (no virtualization).
- **Tool output truncates ~1000 chars** and `rtk ssh` truncates long output (use
  `rtk proxy ssh`). Read URL lists in slices of 14; parse JSON with `rtk proxy`.
- **A second blob download from the page is blocked by Chrome**; localhost POSTs are blocked
  by the page CSP; the clipboard works but needs the page focused (click first). It overwrites
  the user's clipboard — mention it.
- **Remote shell writes may be refused by the auto-mode classifier** (docker exec writing
  files, `git checkout` on the server). Read-only ssh and piping into the api container
  worked here. If a write is denied, stop and ask the user to run it with `!` or to add a Bash
  allow rule; do not work around it.
- **Server checkout must stay clean.** Hand edits under `/srv/napo3d/current` make the
  GitHub deploy fail (`git pull` refuses). If a deploy fails, read `gh run view --log-failed`.
- **Models with no weight profile fail validation** (e.g. no instance with `weight > 0`);
  they are skipped and must be added by hand.
- **API pagination:** `/api/products` caps `limit` at 48; loop over pages. Products are
  grouped by family; `categories` counts are per category.
- **Category must be assigned in the payload `pt.categories`** — the importer leaves it empty
  otherwise. Re-run `scripts/update-product-images.mjs` / `apply-translations.mjs` only for
  fixes after the fact.
- **Images:** MakerWorld pictures are public hotlinks and creators' work — check licenses if
  the user asks. Storefront shows only the first 3; text overlays / "Customize" labels /
  slicer screenshots / infographics should not be shown (step 4). `isLocalProductImage`
  paths (`/product-images/...`) are preserved on later MakerWorld refreshes.
- **Do not store credentials.** Production checks need no login; never commit `.env*`.
- Keep `makerworld_scraper/.venv/` out of git (already ignored).
