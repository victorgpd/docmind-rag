# Deploy em VPS com Docker + Cloudflare Tunnel

Tudo roda na VPS via Docker Compose. A Cloudflare fica na frente com um Tunnel (`cloudflared`): nenhuma porta é aberta e o TLS é da Cloudflare. Só o web é público (`docmind.SEU_DOMINIO`); a API não é exposta, o Next faz o proxy de `/api/v1` para `http://api:3001` na rede interna (mesma origem, sem CORS, cookie de refresh funciona).

```
navegador → Cloudflare → cloudflared → web:3000 → (proxy /api/v1) → api:3001 → postgres / redis / minio
```

## 0. VPS que já roda outros serviços
O DocMind não interfere neles: hostname próprio (`docmind.SEU_DOMINIO`), túnel **novo e dedicado** (não reutilize nem altere o túnel de outro serviço), projeto Compose fixo `-p docmind` e nenhuma porta publicada (80/443 continuam com quem já as usa).
1. **Backup/snapshot da VPS no painel do provedor antes da primeira instalação.**
2. Inventário só de leitura; guarde a saída: `docker ps`, `docker network ls`, `docker volume ls`, `sudo ss -tlnp` (quem usa 80/443/5432/6379), `free -h`, `nproc`, `df -h`, `docker system df`.
3. Firewall: apenas conferir (`sudo ufw status`); não altere regras existentes dos outros serviços.
4. **Nunca** rode `docker system prune`, `docker volume prune`, `docker image prune -a` nem `down -v` sem escopo. Só comandos do projeto: `docker compose -p docmind ...` ou filtros `--filter label=com.docker.compose.project=docmind` (ex.: `docker image ls --filter label=com.docker.compose.project=docmind`).
5. **Orçamento (exemplo: VPS de 8 GB / 60 GB):** soma dos `mem_limit` = 768 (postgres) + 128 (redis) + 384 (minio) + 512 (api) + 768 (worker) + 384 (web) + 96 (cloudflared) = **3040 MiB (~3 GB)**, sobra ~5 GB para os outros serviços e o SO. CPUs limitadas (api/worker/web 1,0; postgres 1,0; redis/minio 0,5). Acompanhe com `docker stats --no-stream` e `free -h`; mantenha swap de 2 GB como rede de segurança.
6. **Disco:** imagens ~1,5–2 GB, Postgres ~1 GB por alguns milhares de chunks, MinIO = tamanho dos arquivos enviados, backups 7 × dump. Alerte se `df -h /` passar de 80%. Limpeza só do próprio projeto: `docker image ls --filter label=com.docker.compose.project=docmind` e `docker rmi <id>` das tags antigas do DocMind.

## 1. Preparar a VPS (Ubuntu)
1. Mínimo recomendado: **2 GB de RAM** (+ swap) e ~20 GB de disco. Confira: `free -h`, `nproc`, `df -h`.
2. Usuário sem root: `adduser deploy && usermod -aG sudo,docker deploy` e entre por SSH com chave.
3. Docker + Compose v2: template "Ubuntu com Docker" do provedor, se houver, ou o [método oficial](https://docs.docker.com/engine/install/ubuntu/). Teste `docker compose version`.
4. Firewall só com SSH: `sudo ufw allow OpenSSH && sudo ufw enable`. Com o Tunnel não há porta de aplicação.
5. Swap se RAM < 2 GB: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` (e a linha em `/etc/fstab`).

## 2. Arquivos e segredos
As imagens vêm do GHCR: a VPS **não clona o código**, só precisa de `docker-compose.prod.yml` e do exemplo de variáveis, em `~/docmind/`.
1. No **PC** (na raiz do repo): `ssh deploy@IP_DA_VPS 'mkdir -p ~/docmind' && scp infra/docker-compose.prod.yml infra/.env.production.example deploy@IP_DA_VPS:~/docmind/` (caminho recomendado; sem chave extra na VPS). Para atualizar o compose, repita o `scp`.
   - Alternativa: *deploy key* somente leitura. Na VPS `ssh-keygen -t ed25519 -f ~/.ssh/docmind_deploy -N ''`, cole `~/.ssh/docmind_deploy.pub` em GitHub → repo → Settings → **Deploy keys** (**sem** "Allow write access") e clone com `GIT_SSH_COMMAND='ssh -i ~/.ssh/docmind_deploy' git clone git@github.com:SEU_USUARIO/SEU_REPO.git`. Só use se precisar do código na VPS.
2. Na VPS: `cd ~/docmind && cp .env.production.example .env.production && chmod 600 .env.production`
3. Gere cada segredo com `openssl rand -hex 32`: `JWT_SECRET`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `S3_SECRET_KEY`, `METRICS_TOKEN`. Defina também `S3_ACCESS_KEY`, `OPENAI_API_KEY`, `CORS_ORIGINS=https://docmind.SEU_DOMINIO`.
4. Storage: padrão **MinIO interno** (`--profile minio`). Para **Cloudflare R2**, não use o perfil e preencha `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (token S3 do R2; crie o bucket antes).
5. Ranking e abstenção com `LLM_PROVIDER=openai`: defina `RAG_MIN_RELEVANCE=0.10`, `RAG_W_RERANK=0.5`, `RAG_W_SIM=0.4`, `RAG_W_RRF=0.1`. Os padrões do código (0.17 e 0.8/0.1/0.1) foram calibrados com o provider local. Com a OpenAI, eles faziam 61% das perguntas inéditas com resposta receberem "não encontrei". Com os valores acima, calibrados em `evals/calib/` e verificados uma vez no held-out, esse número cai para 33% e o recall@5 sobe de 78% para 89% (detalhes em `evals/README.md`). Vazio = padrão do código.

## 3. Criar o Tunnel
1. Painel Cloudflare → **Zero Trust → Networks → Tunnels → Create a tunnel** → tipo **Cloudflared**.
2. Copie o **token** para `TUNNEL_TOKEN` no `.env.production`.
3. **Public Hostname**: `docmind.SEU_DOMINIO` → serviço **HTTP** `web:3000`.
4. Zona do domínio → **SSL/TLS** em **Full** (o tráfego Cloudflare→cloudflared já é criptografado; origem interna é HTTP).

## 4. Subir
O workflow `.github/workflows/deploy.yml` (disparo manual: Actions → Deploy → Run workflow) publica as imagens `ghcr.io/<dono>/<repo>-{web,api,worker}` (tags `latest` e `sha-<7 chars>`, `linux/amd64`); a VPS só baixa, sem build. Aponte os `image:` do `docker-compose.prod.yml` para essas imagens. Confirme a arquitetura com `uname -m` (esperado `x86_64`).
1. **Login no GHCR** (se os pacotes forem privados). Crie um token **classic** em GitHub → Settings → Developer settings → Personal access tokens (classic), só com `read:packages`. Na VPS, digite-o sem ir para o histórico do shell:
   `read -rs GHCR_TOKEN; printf %s "$GHCR_TOKEN" | docker login ghcr.io -u SEU_USUARIO --password-stdin; unset GHCR_TOKEN`
   O Docker guarda o token em `~/.docker/config.json` (`chmod 600`, usuário sem root, nunca no repositório). Para **rotacionar/revogar**: gere outro token, refaça o login e apague o antigo em Settings; se a VPS for comprometida, revogue o token na hora.
2. `IMAGE_TAG` no `.env.production` (`latest` ou `sha-abc1234` para fixar a versão).
3. Subir:
```sh
cd ~/docmind
alias dcp='docker compose -p docmind -f docker-compose.prod.yml --env-file .env.production --profile minio --profile tunnel'
dcp pull && dcp up -d && dcp ps
```
Verifique pelo hostname: `curl -s https://docmind.SEU_DOMINIO/api/v1/health` (200). O `/ready` responde 404 a quem vem pelo proxy (tem `X-Forwarded-For`); confira-o por dentro: `dcp exec api node -e "fetch('http://127.0.0.1:3001/api/v1/ready').then(async r=>console.log(r.status,await r.text()))"` (200, db e redis ok). Crie a conta em `https://docmind.SEU_DOMINIO/register`. Opcional: dados de exemplo a partir do PC com `pnpm demo:seed` apontando `DEMO_API_URL` para o hostname (veja `docs/RODAR.md`). O reindex (após trocar o modelo de embeddings) roda dentro do container do worker (veja `docs/WORKER.md`).

> O alias `dcp` vale só na sessão; para fixá-lo, ponha-o em `~/.bashrc`. Sempre rode dentro de `~/docmind`.

## 5. Operação
- **Atualizar:** `dcp pull && dcp up -d` (as migrations rodam na subida da API); se o compose mudou, refaça o `scp` do passo 2 antes. Equivalente sem alias: `docker compose -p docmind -f docker-compose.prod.yml --env-file .env.production --profile minio --profile tunnel pull` e depois `... up -d`. Construir na VPS exige o código e 1–2 GB de RAM no build do web; prefira as imagens do GHCR.
- **Rollback:** `IMAGE_TAG=sha-<anterior>` no `.env.production` e `dcp pull && dcp up -d`. Migrations são aditivas; restaure o backup se precisar voltar o banco.
- **Logs:** `dcp logs -f --tail 100 api worker web` (rotação json-file: 3 × 10 MB por serviço).
- **Monitoramento simples:** `docker ps` (healthchecks), `GET /api/v1/health` num monitor externo (UptimeRobot/Better Stack) e `GET /metrics` com `Authorization: Bearer $METRICS_TOKEN` (só de dentro: `dcp exec api ...`; o web não faz proxy de `/metrics`, então o túnel não o expõe).
- **Backup do Postgres** (cron diário em `/var/backups/docmind`, mantém 7; crie antes: `sudo install -d -o deploy -m 700 /var/backups/docmind`):
  ```sh
  0 3 * * * cd /home/deploy/docmind && docker compose -p docmind -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -U docmind -Fc docmind > /var/backups/docmind/docmind-$(date +\%F).dump && find /var/backups/docmind -name 'docmind-*.dump' -mtime +7 -delete
  ```
  **Teste o restore** num banco descartável: `docker compose ... exec -T postgres pg_restore -U docmind -d docmind_teste --clean --if-exists < arquivo.dump`. Arquivos enviados ficam no MinIO (`miniodata`) ou no R2: inclua o volume no backup ou use o versionamento do R2.
- **Parar sem perder dados:** `dcp down` (nunca `-v`: apaga os volumes; sempre com `-p docmind`).

## 5.1 Checklist pós-deploy (os outros serviços continuam OK?)
1. `curl -s -o /dev/null -w '%{http_code}' https://docmind.SEU_DOMINIO/api/v1/health` → 200 (e o `/ready` por dentro, passo 4).
2. Outros serviços da VPS: compare o status das rotas de saúde deles antes e depois do deploy (use as rotas reais; não suponha).
3. `docker ps` mostra os containers dos outros serviços com o mesmo tempo de uptime de antes; `ss -tlnp` igual ao inventário.
4. `free -h` e `df -h /` dentro do orçamento; `docker stats --no-stream` sem estouro de memória.

## 6. Custos
- Com `LLM_PROVIDER=openai`, cada pergunta e cada indexação gastam tokens. `MONTHLY_TOKEN_LIMIT` bloqueia o uso da organização ao atingir o teto; `USAGE_PRICE_*` mostram o custo estimado na tela de uso. `INGEST_LLM_CONTEXT=false` (padrão) evita uma chamada de chat por chunk.
- Defina também um limite de gasto no painel da OpenAI. Cloudflare Tunnel e plano Free da zona não têm custo adicional.

### Controle de custo
Com cadastro aberto, cada conta nova cria uma organização com o seu próprio `MONTHLY_TOKEN_LIMIT`: sozinho, ele não tem teto (contas em série gastam o crédito da OpenAI). Por isso há três travas, todas no `.env.production` (e repassadas pelo `docker-compose.prod.yml`):

| Variável | Padrão no código | Recomendado em produção | Efeito |
|---|---|---|---|
| `MONTHLY_TOKEN_LIMIT` | 10000000 | **200000** | teto por organização/mês; `402 usage_limit_exceeded` |
| `GLOBAL_MONTHLY_TOKEN_LIMIT` | 2000000 | **2000000** | soma de **todas** as organizações no mês (UTC); 0 desliga. Chat, modo agente, `/agent/run` e `POST /documents/:id/process` respondem `402 global_limit_exceeded` ("O limite de uso do serviço foi atingido este mês…"); o worker marca o documento como `failed` com "Limite de uso do serviço atingido…" sem chamar o provedor; `GET /usage` traz `serviceLimitReached` (sem números de outras organizações) |
| `REGISTRATION_LIMIT_PER_IP_PER_DAY` | 5 (0 em `NODE_ENV=test`) | **5** | cadastros por IP a cada 24 h (Redis se houver `REDIS_URL`, senão memória; IP real via `TRUST_PROXY`/`CLIENT_IP_HEADER`); o 6º recebe `429` com `retry-after`; 0 desliga |
| `REGISTRATION_ENABLED` | true | true (false para fechar) | `false` faz `/auth/register` responder `403 registration_closed`; a tela de cadastro mostra "Cadastro fechado no momento." |

Custo estimado (gpt-4o-mini US$ 0,15 / 0,60 por 1M de tokens de entrada / saída; text-embedding-3-small US$ 0,02 / 1M): 200 mil tokens ≈ US$ 0,03–0,12 por organização/mês; o teto global de 2M ≈ **US$ 0,3–1,2 por mês** (o pior caso é tudo saída). O total é conferido com uma consulta agregada em `usage_events` pela conexão privilegiada, com cache de 30 s por processo: o teto pode ser ultrapassado pelo que se gastar nessa janela. `pnpm reindex` (ação do operador) ignora o teto global. Em dev com `LLM_PROVIDER=local` os tokens são estimados e também contam; use `GLOBAL_MONTHLY_TOKEN_LIMIT=0` se atrapalhar.

### Conta de demonstração
Botão **Experimentar a demonstração** na landing e no login, para visitantes testarem sem cadastro. `POST /api/v1/auth/demo` entra sem senha numa conta **somente leitura**: conversar (chat e modo agente) e avaliar respostas funcionam; criar/editar/excluir coleções, enviar/importar/processar/excluir documentos, gerenciar membros e trocar de organização respondem `403 demo_read_only` ("A conta de demonstração é somente leitura."). O web consulta `GET /api/v1/auth/demo` → `{"enabled":true|false}` e só mostra o botão com a conta ligada **e** preparada. Entradas: 20 por hora por IP.

1. No `.env.production`: `DEMO_LOGIN_ENABLED=true` e `DEMO_USER_EMAIL=demo@docmind.app` (um e-mail sem conta real; o script e o login recusam um e-mail de conta fora da organização "Demonstração"). Aplique com `dcp up -d` (recria api e worker com as variáveis, repassadas pelo `docker-compose.prod.yml`).
2. Prepare a conta **uma vez** (com a imagem que já contém o script): cria o usuário `member` na organização própria "Demonstração" com senha aleatória descartada, a coleção "Políticas da empresa (exemplo)" com 4 documentos fictícios enfileirados para o worker e apaga as conversas da demo com mais de 24 h. Idempotente; o log só tem contagens:
   ```sh
   cd ~/docmind && docker compose -p docmind -f docker-compose.prod.yml --env-file .env.production exec -T api /app/node_modules/.bin/tsx src/scripts/demo-maintenance.ts
   # [demo] ok {"userCreated":true,"documentsQueued":4,"conversationsDeleted":0}
   ```
   Confira: `curl -s https://docmind.SEU_DOMINIO/api/v1/auth/demo` → `{"enabled":true}`; os documentos ficam "Pronto" na coleção em segundos.
3. **Agende diariamente** (`crontab -e` do usuário `deploy`; reenfileira documentos que falharam e limpa o histórico de visitantes):
   ```sh
   30 3 * * * cd /home/deploy/docmind && docker compose -p docmind -f docker-compose.prod.yml --env-file .env.production exec -T api /app/node_modules/.bin/tsx src/scripts/demo-maintenance.ts >> /home/deploy/docmind/demo-maintenance.log 2>&1
   ```

As perguntas da demo gastam tokens da organização "Demonstração" (`MONTHLY_TOKEN_LIMIT`) e contam no `GLOBAL_MONTHLY_TOKEN_LIMIT`. Para desligar: `DEMO_LOGIN_ENABLED=false` e `dcp up -d` (o botão some e `POST /auth/demo` vira 404). Em dev com PGlite (um processo só) a própria API roda essa manutenção no boot.

## Dicas gerais de provedor
- **Docker:** muitos provedores oferecem um template "Ubuntu com Docker" ao reinstalar o SO. Reinstalar o SO **apaga o disco**. Sem o template, use o método oficial do passo 1.
- **Firewall:** alguns provedores têm firewall no painel, além do `ufw` no SO. Com o Tunnel basta liberar só o SSH em um deles (confira se a VPS já vem com firewall ativo; não bloqueie o SSH).
- **Domínio:** o Tunnel exige a zona DNS na Cloudflare. Se o domínio está em outro registrador: Cloudflare → **Add a site** → plano Free → anote os 2 nameservers → no painel do registrador, troque os nameservers pelos da Cloudflare → aguarde a ativação (até algumas horas). Registros antigos (e-mail/MX) precisam ser recriados na Cloudflare.
- **Portas 80/443 já usadas:** sem problema, o Tunnel só faz conexões de saída e não publica portas.
- **Recursos:** `free -h`, `nproc`, `df -h` na VPS; use 2 GB de RAM + swap como mínimo (o compose limita ~3 GB somando os serviços; com pouca RAM, use R2 em vez do MinIO).

## Alternativa (não implementada): front no Cloudflare Workers + API na VPS
Riscos não confirmados: o Next precisaria rodar via OpenNext/Workers, os `rewrites` de `/api/v1` para a VPS e o cookie de refresh (mesma origem) teriam de ser revalidados, e a API passaria a ser pública (CORS, TLS, rate limit por IP e Tunnel/Origin próprio). Hoje a opção acima é mais simples e segura.
