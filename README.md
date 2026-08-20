# Catálogo de equivalentes 3D — 

Catálogo estático em HTML, CSS e JavaScript, com 12 produtos, 39 alternativas, busca, filtros técnicos, ordenação, recomendações e resumo comparativo. A interface segue uma direção corporativa premium: base clara, tipografia editorial, bordas discretas e laranja  como acento.

## Estrutura

- `index.html`: shell semântico e acessível
- `css/styles.css`: tokens, layout e responsividade
- `js/app.js`: carregamento, filtros, arredondamento de pesos e renderização
- `data/models.json`: dados dos modelos preservados do catálogo anterior

## Executar localmente

```bash
pnpm install
docker compose up --build
```

Agora o projeto roda desacoplado com persistencia em PostgreSQL:

- Front-end estatico em `http://localhost:3000`
- API em `http://localhost:3001`
- PostgreSQL em container `db`, com volume Docker persistente

Scripts disponíveis:

- `pnpm dev`: sobe front e back em processos separados
- `pnpm dev:front`: sobe apenas o front-end estático
- `pnpm dev:back`: sobe apenas a API, esperando PostgreSQL em `DATABASE_URL`
- `pnpm docker:up`: sobe front, API e PostgreSQL com Docker Compose
- `pnpm docker:down`: derruba a stack local

O front tenta encontrar a API nesta ordem:

1. `window.NAPO3D_API_BASE_URL`
2. `<meta name="napo3d-api-base-url">`
3. URL salva no `localStorage`
4. mesma origem
5. `http://localhost:3001`
6. `http://127.0.0.1:3001`

Se nenhuma API responder em `/api/health`, o front cai para o mock local.

### API e CORS

Por padrão, a API aceita CORS destes front-ends de desenvolvimento:

- `http://localhost:3000`
- `http://127.0.0.1:3000`

Para outro host, defina `CORS_ORIGINS`:

```bash
CORS_ORIGINS=https://loja.exemplo.com,https://admin.exemplo.com pnpm dev:back
```

### Docker e producao

- `compose.yml`: ambiente local com `front`, `api` e `db`
- `compose.production.yml`: publica o front em `127.0.0.1:3500` e a API em `127.0.0.1:3501`, pronto para proxy reverso no mesmo host Lightsail dos outros projetos
- `.env.production.example`: variaveis minimas para o deploy
- `script/deploy_production`: fluxo de deploy semelhante ao usado no ambiente Corus

A API nao persiste mais em `.data/store.json`: os dados de usuarios, sessoes, enderecos, pedidos, itens, idempotencia e fila de e-mails ficam no PostgreSQL.

## Observações

- Os dados foram preservados do catálogo anterior fornecido.
- Pesos marcados como estimados devem ser validados no Bambu Studio e são exibidos arredondados para cima em múltiplos de 5 g.
- As capas MakerWorld são resolvidas no navegador pelo endpoint público de metadados; se a capa não carregar, o link “Abrir modelo” continua disponível.
