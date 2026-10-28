# ADR 0003 - Fila em memória por padrão, BullMQ/Redis por configuração

- **Status:** aceito

## Contexto
A ingestão é lenta e pode falhar, então precisa rodar fora do ciclo de requisição. Exigir Redis para um primeiro `pnpm dev` afasta quem só quer experimentar.

## Decisão
A interface `Queue` (`enqueue`, `process`) tem duas implementações: `MemoryQueue` por padrão e BullMQ quando `REDIS_URL` está setada. Sem Redis, o worker roda dentro do processo da API (`startWorker(queue)`).

## Consequências
- Um comando sobe tudo em dev.
- A fila em memória não sobrevive a reinício e não cruza processos: jobs pendentes se perdem se a API cair. Isso é aceitável em dev e inaceitável em produção.
- Retry com backoff exponencial vive no código de ingestão, não na fila, então vale nas duas implementações.
- Em produção, `REDIS_URL` liga o worker separado e o rate limit compartilhado.
