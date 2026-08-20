# Deploy do `napo3d` no mesmo host do Corus

Este guia cobre o deploy do `napo3d` no **mesmo host AWS já usado pelos
serviços `corus-*`**, mas com **domínio próprio**, **portas próprias**,
**diretórios próprios** e **PostgreSQL próprio**.

O modelo operacional é o mesmo dos guias do Corus: um único host com Nginx
na borda, múltiplos projetos Docker Compose publicados apenas em
`127.0.0.1`, e um `script/deploy_production` local por repositório.

Nota de contexto: os guias compartilhados do Corus ainda usam "Lightsail"
no nome por histórico, mas o guia-base do `corus-tracker` registra que o
host atual foi tratado como EC2 em 2026-08-05. Para este projeto isso não
muda o procedimento prático: este documento assume apenas que o host já
existe, já roda Docker e Nginx, e já está em produção com os serviços do
Corus.

## 0. Pré-requisitos

| Nome | Exemplo/valor |
|---|---|
| Host | mesma máquina já usada por `corus-tracker`, `corus-back`, `corus-front` e `corus-tracker-mcp` |
| Domínio público | `loja.napo3d.com.br` |
| Repositório | `git@github.com:<org>/<repo>.git` |
| Branch | `main` |
| Diretório do app | `/srv/napo3d/current` |
| Diretório de dados | `/srv/napo3d-data/postgres` |
| Porta host do frontend | `127.0.0.1:3500` |
| Porta host da API | `127.0.0.1:3501` |
| Banco | `napo3d_production` |
| Usuário PostgreSQL | `napo3d` |

Este projeto **não** compartilha rede Docker, banco ou volumes com o
Corus. O único componente compartilhado é o host: Ubuntu, Docker, Nginx,
Certbot e o IP público.

## 1. Arquitetura final

```text
Internet
   |
   | HTTPS 443
   v
Nginx no host
   |                     \
   | location /           \ location /api
   v                       v
127.0.0.1:3500         127.0.0.1:3501
frontend estático       API Node
                             |
                             v
                        PostgreSQL do napo3d
                        /srv/napo3d-data/postgres
```

Os mapeamentos atuais do projeto já refletem isso em
`compose.production.yml`:

- `db` persiste em `/srv/napo3d-data/postgres`
- `api` publica `127.0.0.1:3501:3001`
- `front` publica `127.0.0.1:3500:3000`

Não abra as portas `3500`, `3501` ou `5432` no firewall do host nem no
firewall da AWS. O único caminho externo deve continuar sendo o Nginx em
`80/443`.

## 2. Preparar diretórios no host

Se o host do Corus já está provisionado, não reinstale Docker, Nginx ou
Certbot. Crie apenas os diretórios desta aplicação:

```bash
sudo mkdir -p /srv/napo3d/current
sudo mkdir -p /srv/napo3d-data/postgres
sudo chown -R ubuntu:ubuntu /srv/napo3d /srv/napo3d-data
chmod 700 /srv/napo3d-data/postgres
```

Se quiser guardar dumps ou exportações manuais:

```bash
sudo mkdir -p /srv/napo3d-backups/{daily,manual}
sudo chown -R ubuntu:ubuntu /srv/napo3d-backups
```

## 3. Dar acesso ao repositório privado

No host, gere uma chave de deploy dedicada:

```bash
ssh-keygen -t ed25519 -C 'napo3d-production' \
  -f ~/.ssh/id_ed25519_napo3d -N ''
cat ~/.ssh/id_ed25519_napo3d.pub
```

No GitHub, adicione a chave pública em **Settings → Deploy keys** do
repositório, somente leitura.

Adicione um alias no `~/.ssh/config` do usuário `ubuntu`:

```sshconfig
Host github.com-napo3d
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_napo3d
  IdentitiesOnly yes
```

Se `github.com` ainda não estiver em `~/.ssh/known_hosts`:

```bash
ssh-keyscan github.com >> ~/.ssh/known_hosts
```

Clone o projeto:

```bash
git clone git@github.com-napo3d:<org>/<repo>.git /srv/napo3d/current
cd /srv/napo3d/current
git checkout main
```

## 4. Criar `.env.production`

O repositório já contém `.env.production.example`. No host:

```bash
cd /srv/napo3d/current
umask 077
cp .env.production.example .env.production
nano .env.production
chmod 600 .env.production
```

Valores mínimos esperados:

```dotenv
POSTGRES_DB=napo3d_production
POSTGRES_USER=napo3d
POSTGRES_PASSWORD=<senha-forte-e-unica>
CORS_ORIGINS=https://loja.napo3d.com.br
```

Observações:

- `DATABASE_URL` não precisa ser escrita manualmente; `compose.production.yml`
  a monta a partir de `POSTGRES_*`.
- Mesmo usando o mesmo host do Corus, esta senha e este banco devem ser
  exclusivos do `napo3d`.
- O frontend atual tenta descobrir a API pela mesma origem antes de cair
  para o mock. Em produção, o Nginx deve garantir que `/api/*` funcione
  no mesmo domínio para evitar qualquer fallback silencioso para mock.

## 5. Primeiro `up`

Antes de subir:

```bash
df -h
docker system df
```

Depois:

```bash
cd /srv/napo3d/current
docker compose --env-file .env.production \
  -f compose.production.yml build --pull front api
docker compose --env-file .env.production \
  -f compose.production.yml up -d
docker compose --env-file .env.production \
  -f compose.production.yml ps
docker compose --env-file .env.production \
  -f compose.production.yml logs --tail=100 api front db
```

Valide por dentro do host:

```bash
curl -I http://127.0.0.1:3500/
curl http://127.0.0.1:3501/api/health
```

O esperado é:

- frontend respondendo `200`
- API respondendo `{"status":"ok"}`

## 6. Configurar Nginx para o domínio próprio

Crie um bloco separado do Corus. Não misture este app com o arquivo
`corus-app`; ele não é parte do produto Corus.

```bash
sudo nano /etc/nginx/sites-available/napo3d
```

Conteúdo:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name loja.napo3d.com.br www.loja.napo3d.com.br;

    client_max_body_size 10M;
    proxy_read_timeout 120s;
    proxy_connect_timeout 15s;
    proxy_send_timeout 120s;

    location /api/ {
        proxy_pass http://127.0.0.1:3501;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
    }

    location / {
        proxy_pass http://127.0.0.1:3500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
    }
}
```

Ative e recarregue:

```bash
sudo ln -sfn /etc/nginx/sites-available/napo3d \
  /etc/nginx/sites-enabled/napo3d
sudo nginx -t
sudo systemctl reload nginx
```

Teste pelo próprio host:

```bash
curl -I http://127.0.0.1/ -H 'Host: loja.napo3d.com.br'
curl http://127.0.0.1/api/health -H 'Host: loja.napo3d.com.br'
```

## 7. DNS e HTTPS

No provedor DNS, crie registros `A` para:

- `loja.napo3d.com.br`
- `www.loja.napo3d.com.br`

Ambos devem apontar para o **mesmo IP público** já usado pelo host do
Corus.

Confira:

```bash
dig +short loja.napo3d.com.br
dig +short www.loja.napo3d.com.br
```

Emita o certificado:

```bash
sudo certbot --nginx \
  --cert-name loja.napo3d.com.br \
  -d loja.napo3d.com.br \
  -d www.loja.napo3d.com.br
sudo certbot renew --dry-run
sudo certbot certificates
```

## 8. Deploy manual recorrente

O repositório já tem `script/deploy_production`. No host:

```bash
cd /srv/napo3d/current
chmod +x script/deploy_production
./script/deploy_production
```

Esse script:

- usa `compose.production.yml`
- rebuilda `front` e `api`
- sobe os containers
- valida `http://127.0.0.1:3500/`
- valida `http://127.0.0.1:3501/api/health`

Para um deploy normal depois do primeiro:

```bash
cd /srv/napo3d/current
git fetch origin main
git checkout main
git merge --ff-only origin/main
./script/deploy_production
```

## 9. GitHub Actions

Diferente do Corus, este repositório **ainda não tem** workflow de deploy
por GitHub Actions. Hoje o caminho documentado e suportado aqui é o deploy
manual por SSH no host.

Se depois você quiser igualar o modelo do Corus, o próximo passo é criar um
`.github/workflows/deploy-production.yml` que:

1. receba `LIGHTSAIL_HOST`, `LIGHTSAIL_SSH_PRIVATE_KEY` e
   `LIGHTSAIL_KNOWN_HOSTS` como secrets;
2. faça SSH no host;
3. execute:

```bash
cd /srv/napo3d/current
git fetch origin main
git checkout main
git merge --ff-only "$deploy_sha"
./script/deploy_production
```

## 10. Backups

Como o `napo3d` agora tem PostgreSQL próprio, ele precisa de backup próprio.
Uma base mínima:

```bash
docker compose --env-file /srv/napo3d/current/.env.production \
  -f /srv/napo3d/current/compose.production.yml exec -T db \
  sh -lc 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > /srv/napo3d-backups/manual/napo3d-$(date +%F-%H%M%S).sql
```

Recomendação operacional:

- não dependa apenas do disco do host
- copie dumps para fora da instância
- teste restauração antes de considerar o processo seguro

## 11. Validação final

1. Acesse `https://loja.napo3d.com.br/`.
2. Confirme que o catálogo carrega normalmente.
3. Abra o DevTools e confirme que `/api/health` e `/api/products` respondem
   no domínio público.
4. Faça cadastro e login.
5. Crie um endereço.
6. Gere um pedido de teste.
7. No banco, confirme que existem linhas em `users`, `sessions`,
   `addresses`, `orders` e `order_items`.
8. Confirme que o frontend **não** caiu no mock em produção.

## 12. Checklist final

- [ ] Diretórios `/srv/napo3d/current` e `/srv/napo3d-data/postgres`
  criados com permissões corretas.
- [ ] Repositório clonado com chave de deploy própria.
- [ ] `.env.production` criado a partir de `.env.production.example`,
  protegido com permissão `600`.
- [ ] `compose.production.yml` subindo `db`, `api` e `front`.
- [ ] Frontend respondendo em `127.0.0.1:3500`.
- [ ] API respondendo em `127.0.0.1:3501/api/health`.
- [ ] Nginx com arquivo separado de Corus, usando domínio próprio.
- [ ] DNS apontando para o mesmo IP público do host compartilhado.
- [ ] Certificado TLS emitido e renovação validada.
- [ ] `script/deploy_production` testado manualmente no host.
- [ ] Fluxo público validado sem fallback para mock.
