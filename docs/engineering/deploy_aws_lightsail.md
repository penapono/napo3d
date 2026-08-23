# Deploy do `napo3d` no mesmo host do Corus

Este guia cobre o deploy do `napo3d` no **mesmo host AWS já usado pelos
serviços `corus-*`**, com **domínios próprios** (dois: `napo3d.shop` e
`napo3d.store`, cada um com o alias `www.`), **portas próprias** e
**PostgreSQL compartilhado com o Corus** (instância única, banco lógico
próprio).

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
| Domínios públicos | `napo3d.shop`, `www.napo3d.shop`, `napo3d.store`, `www.napo3d.store` |
| Repositório | `git@github.com:penapono/napo3d.git` |
| Branch | `main` |
| Diretório do app | `/srv/napo3d/current` |
| Porta host do frontend | `127.0.0.1:3500` |
| Porta host da API | `127.0.0.1:3501` |
| Banco | `napo3d_production` (na mesma instância Postgres do `corus-tracker`) |
| Usuário PostgreSQL | `napo3d` (role dedicada, dona apenas de `napo3d_production`) |

Este projeto **compartilha a instância física de PostgreSQL** com o Corus
(mesmo container `corus-production-db-1`, mesma rede Docker `corus`) — mas
com um banco lógico e uma role dedicados, exatamente como `corus-back` já
faz em relação a `corus-tracker` (ver
`corus-shared-knowledge/docs/engineering/infra/README.md`, seção "Por que
corus-back reusa o Postgres do corus-tracker"). O `napo3d` **não** roda
seu próprio container `db` em produção. Os únicos outros componentes
compartilhados com o Corus são o host (Ubuntu, Docker, Nginx, Certbot) e o
IP público — o front-end e a API do `napo3d` continuam isolados em seus
próprios containers/portas.

## 1. Arquitetura final

```text
Internet
   |
   | HTTPS 443 (napo3d.shop / napo3d.store + www.)
   v
Nginx no host
   |                     \
   | location /           \ location /api/
   v                       v
127.0.0.1:3500         127.0.0.1:3501
frontend estático       API Node
                             |
                             v (rede Docker externa "corus")
                        corus-production-db-1 (Postgres 16)
                        banco napo3d_production, role napo3d
```

Não abra as portas `3500`, `3501` ou `5432` no firewall do host nem no
firewall da AWS. O único caminho externo deve continuar sendo o Nginx em
`80/443`.

## 2. Preparar diretórios no host

Se o host do Corus já está provisionado, não reinstale Docker, Nginx ou
Certbot. Crie apenas os diretórios desta aplicação (não há mais um
diretório de dados do Postgres próprio, já que o banco vive na instância
compartilhada):

```bash
sudo mkdir -p /srv/napo3d/current
sudo chown -R ubuntu:ubuntu /srv/napo3d
sudo mkdir -p /srv/napo3d-backups/daily
sudo chown -R ubuntu:ubuntu /srv/napo3d-backups
```

## 3. Criar a role e o banco do `napo3d` no Postgres compartilhado

Execute isso **uma única vez**, direto no container Postgres do
`corus-tracker` (que é quem roda o `db` físico), usando o superusuário
`corus_tracker` já autenticado via socket local — não é preciso saber a
senha dele para isso:

```bash
NEW_PW=$(openssl rand -hex 24)
docker exec -i corus-production-db-1 \
  psql -U corus_tracker -d corus_tracker_production -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE napo3d WITH LOGIN PASSWORD '${NEW_PW}';
CREATE DATABASE napo3d_production OWNER napo3d;
SQL
echo "Guarde a senha gerada (\$NEW_PW) apenas no .env.production do napo3d — não a deixe em histórico de shell."
```

Isso cria uma role dedicada, dona **apenas** de `napo3d_production` — sem
acesso a `corus_tracker_production` nem `corus_production`. Guarde a senha
gerada apenas no `.env.production` do `napo3d` (seção 5); não copie o
superusuário do tracker como `corus-back` historicamente fez.

## 4. Dar acesso ao repositório privado

No host, gere uma chave de deploy dedicada:

```bash
ssh-keygen -t ed25519 -C 'napo3d-production' \
  -f ~/.ssh/id_ed25519_napo3d -N ''
cat ~/.ssh/id_ed25519_napo3d.pub
```

No GitHub, adicione a chave pública em **Settings → Deploy keys** do
repositório `penapono/napo3d`, somente leitura.

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
git clone git@github.com-napo3d:penapono/napo3d.git /srv/napo3d/current
cd /srv/napo3d/current
git checkout main
```

## 5. Criar `.env.production`

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
DATABASE_URL=postgresql://napo3d:<senha-gerada-na-secao-3>@db:5432/napo3d_production
CORS_ORIGINS=https://napo3d.shop,https://www.napo3d.shop,https://napo3d.store,https://www.napo3d.store
EMAIL_PROVIDER=resend
RESEND_API_KEY=<chave-da-conta-resend>
FROM_EMAIL=pedidos@napo3d.shop
ORDER_RECIPIENT=pedro.gnaponoceno@gmail.com
# Somente para script/backup_napo3d (pg_dump) — a aplicação em si só lê DATABASE_URL acima.
POSTGRES_DB=napo3d_production
POSTGRES_USER=napo3d
```

Observações:

- `DATABASE_URL` usa `db` como hostname porque esse é o nome do serviço
  `db` do stack do `corus-tracker` na rede Docker externa `corus` — não é
  um container próprio do `napo3d`. `compose.production.yml` declara essa
  rede como `external: true, name: corus` e conecta o serviço `api` a
  ela; nenhum outro serviço do `napo3d` precisa dessa rede.
- Se `RESEND_API_KEY`/`FROM_EMAIL` ficarem vazios, o worker de e-mail fica
  "desconfigurado" de propósito (`resolveMailerConfig().configured ===
  false`): pedidos continuam sendo criados e persistidos normalmente, só
  não saem e-mails até essas variáveis serem preenchidas.
- O frontend atual tenta descobrir a API pela mesma origem antes de cair
  para o mock. Em produção, o Nginx deve garantir que `/api/*` funcione
  no mesmo domínio para evitar qualquer fallback silencioso para mock.

## 6. Primeiro `up`

Confirme que a rede `corus` existe no host antes de subir (ela é criada
pelo stack de produção do `corus-tracker`, não pelo `napo3d`):

```bash
docker network inspect corus --format '{{range .Containers}}{{.Name}} {{end}}'
```

O esperado é ver `corus-production-db-1` na saída. Se a rede não existir,
pare aqui — não crie uma rede `corus` vazia a partir deste repositório;
isso quebraria a resolução de `db` (ver
`corus-shared-knowledge/docs/engineering/infra/deploys/corus-back.md`,
seção 1, para o mesmo problema já documentado no lado do Corus).

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
  -f compose.production.yml logs --tail=100 api front
```

Valide por dentro do host:

```bash
curl -I http://127.0.0.1:3500/
curl http://127.0.0.1:3501/api/health
```

O esperado é:

- frontend respondendo `200`
- API respondendo `{"status":"ok"}`

## 7. Configurar Nginx para os domínios próprios

Crie um bloco separado do Corus. Não misture este app com o arquivo
`corus-app`; ele não é parte do produto Corus. Os dois domínios
(`napo3d.shop` e `napo3d.store`) servem o mesmo conteúdo — mesmo
`server{}`, todos os hostnames em `server_name`:

```bash
sudo nano /etc/nginx/sites-available/napo3d
```

Conteúdo:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name napo3d.shop www.napo3d.shop napo3d.store www.napo3d.store;

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

Todos os quatro hostnames precisam estar listados em `server_name` — um
`www.` esquecido cai, por padrão do Nginx, no primeiro `server{}` do
arquivo (não necessariamente este), servindo o certificado/app errado.
Isso já aconteceu em produção com `corus.app.br`/`www.corus.app.br` (ver
`corus-shared-knowledge/docs/engineering/infra/03-lightsail-nginx-deploy.md`,
nota de 2026-08-11) — confira sempre o `server_name` real via SSH em vez
de assumir que bate com este documento.

Ative e recarregue:

```bash
sudo ln -sfn /etc/nginx/sites-available/napo3d \
  /etc/nginx/sites-enabled/napo3d
sudo nginx -t
sudo systemctl reload nginx
```

Teste pelo próprio host:

```bash
curl -I http://127.0.0.1/ -H 'Host: napo3d.shop'
curl -I http://127.0.0.1/ -H 'Host: napo3d.store'
curl http://127.0.0.1/api/health -H 'Host: napo3d.shop'
```

## 8. DNS e HTTPS

No provedor DNS de cada domínio, crie registros `A` para:

- `napo3d.shop` e `www.napo3d.shop`
- `napo3d.store` e `www.napo3d.store`

Todos devem apontar para o **mesmo IP público** já usado pelo host do
Corus.

Confira antes de emitir o certificado:

```bash
dig +short napo3d.shop
dig +short www.napo3d.shop
dig +short napo3d.store
dig +short www.napo3d.store
```

Emita **um único certificado com os quatro hostnames como SAN**:

```bash
sudo certbot --nginx \
  --cert-name napo3d \
  -d napo3d.shop \
  -d www.napo3d.shop \
  -d napo3d.store \
  -d www.napo3d.store
sudo certbot renew --dry-run
sudo certbot certificates
```

Se preferir emitir em duas etapas (por exemplo, se o DNS de um dos
domínios ainda não propagou), rode o comando acima só com os hostnames já
resolvendo e adicione o resto depois com `--expand`:

```bash
sudo certbot --nginx --cert-name napo3d \
  -d napo3d.shop -d www.napo3d.shop -d napo3d.store -d www.napo3d.store \
  --expand
```

## 9. Deploy manual recorrente

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

## 10. GitHub Actions

O repositório já tem `.github/workflows/deploy-production.yml`, que faz
deploy automático a cada push em `main` via SSH, executando
`script/deploy_production` no host.

Esse workflow depende dos seguintes secrets/variáveis do repositório
(**Settings → Secrets and variables → Actions**) associados a um
environment chamado **`Production`** (com `P` maiúsculo — o nome precisa
bater exatamente com o environment já criado no repositório):

| Secret | Conteúdo |
|---|---|
| `LIGHTSAIL_HOST` | IP público ou hostname do host compartilhado com o Corus |
| `LIGHTSAIL_SSH_PRIVATE_KEY` | Chave privada **exclusiva do GitHub Actions** (diferente da chave de deploy git da seção 4) |
| `LIGHTSAIL_KNOWN_HOSTS` | Saída de `ssh-keyscan <host>` para esse mesmo host |

Depois de configurar os secrets, qualquer push em `main` dispara o
deploy. Para forçar manualmente, use **Actions → Deploy production → Run
workflow**.

## 11. Backups

`script/backup_napo3d` faz um `pg_dump` diário direto no container
Postgres compartilhado (`corus-production-db-1`, não um container próprio
do `napo3d`) e apaga dumps com mais de 14 dias. No host, registre no
crontab do usuário `ubuntu`:

```bash
crontab -e
# adicionar:
0 3 * * * /srv/napo3d/current/script/backup_napo3d >> /var/log/napo3d-backup.log 2>&1
```

Os dumps ficam em `/srv/napo3d-backups/daily/`. Recomendação operacional:

- não dependa apenas do disco do host — copie os dumps periodicamente para
  fora da instância (S3, outro host, etc.);
- teste a restauração de um dump antes de considerar o processo confiável;
- como o Postgres é compartilhado com o Corus, um backup diário do Corus
  (`/srv/corus-backups/`) **não** inclui `napo3d_production` — são rotinas
  independentes.

## 12. Validação final

1. Acesse `https://napo3d.shop/` e `https://napo3d.store/`.
2. Confirme que o catálogo carrega normalmente nos dois domínios.
3. Abra o DevTools e confirme que `/api/health` e `/api/products`
   respondem nos dois domínios públicos.
4. Faça cadastro e login.
5. Crie um endereço.
6. Gere um pedido de teste.
7. No banco (`napo3d_production`, não em `corus_tracker_production`),
   confirme que existem linhas em `users`, `sessions`, `addresses`,
   `orders` e `order_items`.
8. Confirme que o frontend **não** caiu no mock em produção.

## 13. Checklist final

- [ ] Diretório `/srv/napo3d/current` criado com permissões corretas
  (não há mais diretório de dados do Postgres próprio).
- [ ] Role `napo3d` e banco `napo3d_production` criados na instância
  Postgres compartilhada do Corus, sem reusar o superusuário do tracker.
- [ ] Repositório clonado com chave de deploy própria.
- [ ] `.env.production` criado a partir de `.env.production.example`,
  com `DATABASE_URL` apontando para `db` na rede `corus`, protegido com
  permissão `600`.
- [ ] `compose.production.yml` subindo `api` e `front` (sem `db` próprio),
  `api` conectado à rede externa `corus`.
- [ ] Frontend respondendo em `127.0.0.1:3500`.
- [ ] API respondendo em `127.0.0.1:3501/api/health`.
- [ ] Nginx com arquivo separado de Corus, servindo os quatro hostnames
  (`napo3d.shop`, `www.napo3d.shop`, `napo3d.store`, `www.napo3d.store`).
- [ ] DNS dos dois domínios apontando para o mesmo IP público do host
  compartilhado.
- [ ] Certificado TLS único com os quatro hostnames como SAN, renovação
  validada.
- [ ] `script/deploy_production` testado manualmente no host.
- [ ] Environment `Production` (com `P` maiúsculo) com os três secrets
  `LIGHTSAIL_*` configurados; deploy automático validado com um push em
  `main`.
- [ ] `script/backup_napo3d` testado manualmente contra
  `corus-production-db-1`.
- [ ] Fluxo público validado sem fallback para mock, nos dois domínios.
