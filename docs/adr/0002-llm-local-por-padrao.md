# ADR 0002 - LLM local por padrão, atrás de uma interface

- **Status:** aceito

## Contexto
A regra do projeto é zero API externa: nenhuma chave, nenhum custo, resultado reproduzível. Ao mesmo tempo, trocar de modelo não pode exigir mexer na API nem no worker.

## Decisão
O pacote `llm` expõe `embed`, `generateStream` e `generateObject`. O provedor padrão (`local`) usa embeddings por hashing de 384 dimensões, geração extrativa que cita `[n]` e reranker BM25. O `ollama` entra por `LLM_PROVIDER=ollama` e `OLLAMA_URL`.

## Consequências
- Testes e CI determinísticos, sem custo nem rede.
- A qualidade das respostas do modo `local` é limitada (extrativo): serve para demonstrar o pipeline, não para impressionar em fluência.
- Vetores têm 384 dimensões (coluna `vector(384)`); trocar para um modelo de outro tamanho exige migration e reindexação.
- Qualquer provedor novo só precisa implementar a interface.
