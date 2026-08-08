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
pnpm dev
```

O servidor estático publica a raiz do projeto. Para GitHub Pages, mantenha `index.html` na raiz e publique o conteúdo do repositório com Pages.

## Observações

- Os dados foram preservados do catálogo anterior fornecido.
- Pesos marcados como estimados devem ser validados no Bambu Studio e são exibidos arredondados para cima em múltiplos de 5 g.
- As capas MakerWorld são resolvidas no navegador pelo endpoint público de metadados; se a capa não carregar, o link “Abrir modelo” continua disponível.
