# Fluxo de ingestão

Da carga do arquivo até o documento `ready`. Código: `apps/api/src/routes/documents.ts` (entrada), `apps/worker` (fila e banco) e `packages/ingest` (extração, chunks, embeddings). Detalhes de retries, limites e erros: `docs/WORKER.md`.

## Visão geral
```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente
    participant A as API
    participant S as Storage
    participant Q as Fila
    participant W as Worker
    participant D as Postgres ou PGlite
    C->>A: POST /collections/:id/documents (arquivo) ou /documents/url
    A->>A: valida tipo real e tamanho, bloqueia URL privada
    A->>S: grava o arquivo (ou a URL)
    A->>D: documents.status = pending
    A-->>C: 201 Document
    C->>A: POST /documents/:id/process
    A->>Q: enqueue ingest-document com organizationId e documentId
    A-->>C: 202
    C->>A: GET /documents/:id/events (SSE)
    Q->>W: job
    W->>D: status = processing
    W->>S: lê o arquivo
    W->>W: extrai, limpa, divide em chunks, gera contexto e embeddings
    W->>D: troca os chunks do documento numa transação
    W->>D: status = ready (ou failed com a categoria do erro)
    W->>A: invalidateCache da coleção
    A-->>C: event document com status ready
```
Sem `REDIS_URL` a fila é em memória e o worker roda dentro do processo da API. Com Redis (BullMQ) o worker é um processo separado.

## O que acontece dentro do worker
```mermaid
flowchart TD
    J[Job: organizationId e documentId] --> L{Documento existe nesta organização?}
    L -- não --> X[Ignora e registra aviso]
    L -- sim --> P[status = processing]
    P --> E{Tipo}
    E -- PDF --> E1[Texto por página, limite de páginas]
    E -- DOCX --> E2[Confere tamanho descomprimido e razão, depois extrai]
    E -- TXT ou MD --> E3[Texto e títulos]
    E -- URL --> E4[Download anti-SSRF, depois Readability]
    E1 --> C
    E2 --> C
    E3 --> C
    E4 --> C
    C[Limpeza: remove cabeçalho e rodapé repetidos, junta linhas, normaliza espaços] --> K[Chunking por títulos e parágrafos, cerca de 500 tokens, 15 por cento de sobreposição, guarda página e seção]
    K --> T{Chunks entre 1 e o limite?}
    T -- nenhum --> F
    T -- acima do limite --> F
    T -- ok --> G[Contexto de 1 frase por chunk]
    G --> M[Embeddings em lotes de 32 com retry e backoff]
    M --> R[Apaga chunks antigos e insere os novos, em lotes de 100]
    R --> U[usage_events ingest e embed]
    U --> OK[status = ready com page_count]
    OK --> I[invalida o cache semântico da coleção]
    E1 -. erro .-> F
    E2 -. erro .-> F
    E4 -. erro .-> F
    M -. erro após retries ou timeout .-> F
    F[status = failed com mensagem por categoria, detalhe só no log] --> I
```

## Etapas
| Etapa | Onde | Observações |
|---|---|---|
| Extração | `packages/ingest/src/extract.ts` | PDF guarda a página de cada trecho; DOCX, TXT, MD e URL não têm página (`null`) |
| Limpeza | `clean.ts` | Cabeçalho e rodapé que se repetem em metade das páginas (mínimo 3) saem; hifenização é desfeita |
| Chunking | `chunk.ts` | Alvo de 500 tokens (estimativa de 4 caracteres por token), sobreposição de 15 por cento, página = onde o chunk começa |
| Contexto | `context.ts` | Provider `local`: frase fixa (documento, seção, página). Ollama: gerada pelo LLM, com fallback para a fixa |
| Embeddings | `index.ts` | 384 dimensões; o texto embutido é contexto mais conteúdo, mas `chunks.content` guarda o original (é ele que vira citação) |
| Gravação | `apps/worker/src/index.ts` | Reprocessar é idempotente: apaga e reinsere os chunks do documento. Colunas: `content`, `context`, `section`, `page`, `token_count`, `embedding` e `tsv` (gerada) |

Depois de gravar, a busca usa o índice HNSW (vetor) e o GIN (texto completo) da tabela `chunks`. No PGlite o worker roda `ANALYZE chunks` quando a fila esvazia, para o planejador não abandonar o HNSW.
