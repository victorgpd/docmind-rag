# ADR 0005 - Busca híbrida (vetor + texto) fundida por RRF

- **Status:** aceito

## Contexto
A busca só vetorial erra nomes próprios, códigos e siglas ("cláusula 14.2"). A busca só textual não entende sinônimos.

## Decisão
Rodar as duas buscas, ambas filtradas por organização e coleção: HNSW por cosseno (pgvector) e GIN sobre `to_tsvector('simple', content)`. Fundir as listas por RRF, `score = Σ 1/(k + posição)`, e reranquear o resultado para ficar com 5 a 8 trechos. Fusão e rerank ficam no código, não em SQL.

## Consequências
- O RRF usa só a posição, então não é preciso calibrar scores de escalas diferentes.
- A configuração `simple` do full-text não faz stemming: "contratos" não casa com "contrato". Troca para `portuguese` melhora a revocação em português e muda o índice.
- Duas buscas por pergunta aumentam a latência; o reranker é a etapa mais cara e é medida separadamente.
- O ganho se prova com a avaliação (recall@5 com e sem rerank), não por opinião.
