# Napo3D Agent Notes

## Shell

- Prefix shell commands with `rtk`.
- Repo root: `/Users/pnaponoceno/projects/penapono/napo3d`

## Production

- Public site: `https://napo3d.shop`
- Production host: `ubuntu@napo3d.shop`
- Production app dir on host: `/srv/napo3d/current`
- Production frontend/API inside the host:
  - `http://127.0.0.1:3500`
  - `http://127.0.0.1:3501/api/health`
- Production compose command:
  - `docker compose --env-file .env.production -f compose.production.yml`

## Production Testing

- Default completion workflow for this repository:
  - when a code/config change is finished, commit the intended scope;
  - push it to `main`;
  - wait for the production deploy triggered by `main`;
  - validate the deployed result through SSH and/or the public production site before considering the task done.
- Prefer both checks when feasible:
  - SSH-side deploy/health confirmation on `ubuntu@napo3d.shop`
  - public-site/API confirmation on `https://napo3d.shop`
- If production validation is blocked, say exactly what was not verified and why.
- Do not commit permanent production credentials to the repo.
- For production checks, create disposable test users, promote one to `admin`, run the checks, then delete both test users.
- Keep `pedro.naponoceno@gmail.com` as an `admin` user in production unless the user explicitly asks otherwise.

### Disposable login bootstrap

Run these locally from the repo root:

```bash
export PROD_BASE_URL="https://napo3d.shop"
export PROD_TEST_PASSWORD="$(openssl rand -base64 18 | tr -d '\n' | cut -c1-20)"
export PROD_ADMIN_EMAIL="codex-prod-admin-$(date +%s)@example.com"
export PROD_CUSTOMER_EMAIL="codex-prod-customer-$(date +%s)@example.com"
```

Create the disposable admin candidate:

```bash
rtk node --input-type=module - <<'NODE'
const res = await fetch(`${process.env.PROD_BASE_URL}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    name: 'Codex Prod Admin',
    email: process.env.PROD_ADMIN_EMAIL,
    password: process.env.PROD_TEST_PASSWORD,
    phone: '11999999999',
  }),
});
const text = await res.text();
if (!res.ok) throw new Error(`${res.status} ${text}`);
console.log(text);
NODE
```

Promote that user on the production host:

```bash
rtk ssh ubuntu@napo3d.shop \
  "docker exec -i corus-production-db-1 psql -U napo3d -d napo3d_production -c \
  \"update users set role = 'admin', updated_at = now() where lower(email)=lower('${PROD_ADMIN_EMAIL}');\""
```

Create the disposable customer:

```bash
rtk node --input-type=module - <<'NODE'
const res = await fetch(`${process.env.PROD_BASE_URL}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    name: 'Codex Prod Customer',
    email: process.env.PROD_CUSTOMER_EMAIL,
    password: process.env.PROD_TEST_PASSWORD,
    phone: '11999999998',
  }),
});
const text = await res.text();
if (!res.ok) throw new Error(`${res.status} ${text}`);
console.log(text);
NODE
```

### Production login checks

Admin login:

```bash
rtk node --input-type=module - <<'NODE'
const res = await fetch(`${process.env.PROD_BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    email: process.env.PROD_ADMIN_EMAIL,
    password: process.env.PROD_TEST_PASSWORD,
  }),
});
const text = await res.text();
if (!res.ok) throw new Error(`${res.status} ${text}`);
console.log(text);
NODE
```

Customer login:

```bash
rtk node --input-type=module - <<'NODE'
const res = await fetch(`${process.env.PROD_BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    email: process.env.PROD_CUSTOMER_EMAIL,
    password: process.env.PROD_TEST_PASSWORD,
  }),
});
const text = await res.text();
if (!res.ok) throw new Error(`${res.status} ${text}`);
console.log(text);
NODE
```

Common production checks:

- `rtk curl -sf https://napo3d.shop/api/health`
- `rtk curl -I https://napo3d.shop/`
- `rtk ssh ubuntu@napo3d.shop 'cd /srv/napo3d/current && docker compose --env-file .env.production -f compose.production.yml ps'`

If the task is specifically about the logged-in storefront account page, confirm the deployed `index.html` / `js/app.js` contain the expected UI logic and, when browser tooling is available, verify the account page visually as both admin and customer.

### Production cleanup

Delete both disposable users after testing:

```bash
rtk ssh ubuntu@napo3d.shop \
  "docker exec -i corus-production-db-1 psql -U napo3d -d napo3d_production -c \
  \"delete from sessions where user_id in (select id from users where lower(email) in (lower('${PROD_ADMIN_EMAIL}'), lower('${PROD_CUSTOMER_EMAIL}'))); \
    delete from addresses where user_id in (select id from users where lower(email) in (lower('${PROD_ADMIN_EMAIL}'), lower('${PROD_CUSTOMER_EMAIL}'))); \
    update orders set user_id = null where user_id in (select id from users where lower(email) in (lower('${PROD_ADMIN_EMAIL}'), lower('${PROD_CUSTOMER_EMAIL}'))); \
    delete from users where lower(email) in (lower('${PROD_ADMIN_EMAIL}'), lower('${PROD_CUSTOMER_EMAIL}'));\""
```
