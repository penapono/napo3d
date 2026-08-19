# Contrato de backend da loja napo3d

## Objetivo

Este documento descreve o backend que deve ser implementado posteriormente para transformar o front-end estático em uma loja virtual simples, leve e completa. O front-end atual já possui catálogo, variações, carrinho, quantidade por item, cadastro local, endereço de entrega e formulário de pedido. O backend deve substituir as persistências locais e o endpoint temporário de e-mail sem alterar o fluxo visual.

## Contexto do projeto

- Front-end atual: HTML, CSS e JavaScript sem framework.
- Hospedagem futura: AWS Lightsail.
- Dados de catálogo: `data/models.json`.
- Produtos: possuem `id`, `name`, `category`, `reference`, `summary` e `options`.
- Variações: possuem `name`, `url` (MakerWorld), `imageUrl`, `colors`, `weight` e `score`.
- Preços: calculados pelo peso e quantidade:
  - 1–50 unidades: `peso_em_gramas * 375 / 100`.
  - 51–100 unidades: `peso_em_gramas * 325 / 100`.
  - 101+ unidades: `peso_em_gramas * 275 / 100`.
  - Arredondar para cima em múltiplos de R$ 5, como no front-end atual.
- Destinatário temporário dos pedidos: `pedro.gnaponoceno@gmail.com`.

## Recomendação de stack

Implementar uma API REST pequena em Node.js/TypeScript (Fastify ou Express), PostgreSQL e um worker de e-mail. Usar Docker Compose no Lightsail, HTTPS via Caddy/Nginx, variáveis de ambiente e migrações versionadas. Não confiar em preços, totais, IDs ou endereço enviados pelo navegador: o servidor deve reconsultar produto, peso e preço.

## Entidades

### User

```ts
type User = {
  id: string;                 // UUID
  name: string;
  email: string;              // único, normalizado em lowercase
  phone?: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}
```

### Address

```ts
type Address = {
  id: string;
  userId: string;
  recipientName: string;
  postalCode: string;         // somente dígitos, 8 caracteres
  street: string;
  number: string;
  complement?: string;
  neighborhood?: string;
  city: string;
  state: string;              // 2 letras
  reference?: string;
  isDefault: boolean;
}
```

### Order

```ts
type Order = {
  id: string;
  userId?: string;
  status: 'pending' | 'confirmed' | 'in_production' | 'shipped' | 'completed' | 'cancelled';
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  addressSnapshot: Address;  // cópia imutável no momento do pedido
  subtotal: number;
  shipping?: number;
  total: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
```

### OrderItem

```ts
type OrderItem = {
  id: string;
  orderId: string;
  productId: string;
  optionName: string;
  productNameSnapshot: string;
  unitWeightGrams: number;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}
```

## Endpoints esperados

Todas as respostas devem ser JSON. Usar `Authorization: Bearer <token>` para rotas autenticadas.

### Autenticação

- `POST /api/auth/register`
  - body: `{ name, email, phone?, password }`
  - `201`: `{ user, accessToken }`
  - `409`: e-mail já cadastrado
  - Validar senha com no mínimo 8 caracteres; usar Argon2id ou bcrypt.

- `POST /api/auth/login`
  - body: `{ email, password }`
  - `200`: `{ user, accessToken }`
  - `401`: credenciais inválidas

- `POST /api/auth/logout`
  - invalidar sessão/token
  - `204`

- `GET /api/me`
  - retorna o usuário autenticado sem `passwordHash`

### Endereços

- `GET /api/me/addresses`
- `POST /api/me/addresses`
- `PATCH /api/me/addresses/:id`
- `DELETE /api/me/addresses/:id`
- `POST /api/me/addresses/:id/default`

Garantir que o usuário só consiga ler ou alterar seus próprios endereços.

### Catálogo

- `GET /api/products?query=&category=&page=1&limit=12&sort=recommended`
- `GET /api/products/:productId`

O backend pode continuar lendo `data/models.json` inicialmente, mas deve validar que `productId` e `optionName` existem. Depois, migrar o catálogo para tabela versionada se houver necessidade de painel administrativo.

### Pedidos

- `POST /api/orders`

Body:

```json
{
  "items": [
    { "productId": "produto-01-exemplo", "optionName": "Laranja", "quantity": 12 }
  ],
  "addressId": "uuid",
  "customer": { "name": "Nome", "email": "cliente@email.com", "phone": "..." },
  "notes": "Observações"
}
```

Processamento obrigatório no servidor:

1. Validar sessão ou aceitar pedido convidado com rate limit.
2. Validar quantidade inteira positiva e limite máximo configurável.
3. Buscar cada produto e variação no catálogo oficial.
4. Buscar peso oficial da variação.
5. Escolher a faixa pela quantidade de cada item.
6. Calcular `unitPrice`, `lineTotal`, `subtotal` e `total` novamente.
7. Persistir snapshot do produto, preço e endereço.
8. Criar pedido com status `pending`.
9. Enfileirar e-mail para o cliente e para `pedro.gnaponoceno@gmail.com`.
10. Retornar `201` com o pedido e totais calculados.

Resposta:

```json
{
  "order": {
    "id": "uuid",
    "status": "pending",
    "items": [],
    "subtotal": 125.00,
    "shipping": 0,
    "total": 125.00,
    "createdAt": "2026-08-19T12:00:00.000Z"
  }
}
```

- `GET /api/me/orders`
- `GET /api/me/orders/:id`

## E-mail

Usar um provedor com plano gratuito, como Resend, Brevo ou Amazon SES após configurar domínio. Nunca colocar chave de e-mail no JavaScript do navegador. O e-mail interno deve conter: ID do pedido, cliente, telefone, endereço completo, itens, quantidade, peso, preço unitário, total por linha, subtotal, frete, total e observações. Enviar confirmação ao cliente somente após persistir o pedido.

Variáveis sugeridas:

```env
DATABASE_URL=
APP_URL=https://loja.seudominio.com
JWT_SECRET=
EMAIL_PROVIDER=resend
RESEND_API_KEY=
ORDER_RECIPIENT=pedro.gnaponoceno@gmail.com
FROM_EMAIL=pedidos@seudominio.com
```

## Segurança e operação

- HTTPS obrigatório.
- Hash de senha com Argon2id/bcrypt.
- Cookies HttpOnly, Secure e SameSite=Lax se usar sessão web.
- CORS limitado ao domínio da loja.
- Rate limit em login, cadastro e criação de pedidos.
- Validação com Zod ou equivalente.
- Sanitizar texto antes do e-mail e do painel.
- Nunca confiar em `total`, `unitPrice`, `weight` ou `role` enviados pelo cliente.
- Logs sem senha, token ou dados completos de pagamento.
- Backup diário do PostgreSQL.
- Idempotency-Key em `POST /api/orders` para impedir pedidos duplicados.
- Não implementar cartão neste escopo; adicionar Stripe somente em uma etapa posterior.

## Migração do front-end

Substituir gradualmente:

1. `localStorage('napo3d-cart')` por `GET/PUT /api/me/cart` ou manter carrinho anônimo em cookie assinado.
2. `localStorage('napo3d-account')` por `GET /api/me`.
3. Formulário atual por seleção de endereço salvo e `POST /api/orders`.
4. `fetch('https://formspree.io/...')` por `POST /api/orders`.
5. Após login, sincronizar carrinho anônimo com o carrinho da conta.

## Critérios de aceite

- Usuário consegue cadastrar, entrar e sair.
- Usuário consegue criar, editar, excluir e selecionar endereço padrão.
- Carrinho sobrevive a refresh e login.
- Adicionar o mesmo produto/variação incrementa quantidade.
- Alterar quantidade recalcula a faixa e o preço no servidor.
- Pedido inválido não é persistido.
- Pedido válido é persistido uma única vez.
- E-mails interno e de confirmação são enviados após persistência.
- Usuário autenticado só acessa seus próprios pedidos e endereços.
- Testes cobrem autenticação, cálculo de preço, autorização, idempotência e criação de pedido.

## Nota para o agente implementador

Preserve o HTML/CSS atual e transforme as funções de persistência em uma camada `apiClient`. Mantenha os nomes dos campos e os IDs acima para reduzir mudanças visuais. O front-end atual é uma referência de UX, não uma fonte confiável de preço ou autorização. A implementação final deve introduzir loading, erro, estado vazio e confirmação de pedido sem bloquear a navegação do catálogo.
