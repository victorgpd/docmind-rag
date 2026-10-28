Provider `openai` (2026-10-28): embeddings `openai:text-embedding-3-small:384` para chunks e consultas, geracao `gpt-4o-mini` (temperatura 0), rerank LocalReranker (pesos rerank/sim/rrf 0.5/0.4/0.1, limiar de relevancia 0.1). Juiz lexical deterministico (sem API).

Tokens reais da rodada (dev + held-out, com e sem rerank): 8108 de embedding (103 chamadas), 86178 de entrada e 3395 de saida no chat (174 chamadas). Custo estimado: US$ 0.0151 (tabela de precos de 2026-10-28).

# Held-out (validacao: numero do README)

18 perguntas com resposta + 2 sem resposta no corpus.

| categoria | n | recall@1 sem rerank | recall@1 com rerank | delta | recall@5 com rerank |
|---|---|---|---|---|---|
| parafrase | 8 | 38% | 38% | 0 pts | 88% |
| sinonimo_sigla | 6 | 50% | 83% | +33 pts | 83% |
| nome_proprio | 4 | 50% | 75% | +25 pts | 100% |
| TOTAL (com resposta) | 18 | 44% | 61% | +17 pts | 89% |

Abstencao em perguntas sem resposta (responde "nao encontrei"): 100% sem rerank, 100% com rerank (n=2).

Falsa abstencao (pergunta com resposta respondida com "nao encontrei"): 33% sem rerank, 33% com rerank (17% pelo limiar de relevancia, sem chamar o gerador; 17% pelo gerador). Sem rerank o limiar e 0.

<details><summary>Detalhe com rerank / sem rerank</summary>

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| parafrase | 8 | 0.375 | 0.75 | 0.875 | 0.6146 | 0.375 | 0.8438 | 0.9167 | 0.125 |
| sinonimo_sigla | 6 | 0.8333 | 0.8333 | 0.8333 | 0.8333 | 0.8333 | 0.3667 | 0.8095 | 0.6667 |
| nome_proprio | 4 | 0.75 | 1 | 1 | 0.8333 | 1 | 0.7 | 0.95 | 0.25 |
| TOTAL (com resposta) | 18 | 0.6111 | 0.8333 | 0.8889 | 0.7361 | 0.6667 | 0.6528 | 0.8884 | 0.3333 |

(sem rerank)

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| parafrase | 8 | 0.375 | 0.75 | 0.875 | 0.5875 | 0.5 | 0.7188 | 0.8417 | 0.25 |
| sinonimo_sigla | 6 | 0.5 | 0.5 | 0.5 | 0.5 | 0.6667 | 0.5 | 0.5 | 0.5 |
| nome_proprio | 4 | 0.5 | 1 | 1 | 0.7083 | 1 | 0.7 | 0.95 | 0.25 |
| TOTAL (com resposta) | 18 | 0.4444 | 0.7222 | 0.7778 | 0.5852 | 0.6667 | 0.6417 | 0.7519 | 0.3333 |

</details>

# Dev (usado para ajustar o sistema)

62 perguntas com resposta + 7 sem resposta no corpus.

| categoria | n | recall@1 sem rerank | recall@1 com rerank | delta | recall@5 com rerank |
|---|---|---|---|---|---|
| literal | 44 | 91% | 100% | +9 pts | 100% |
| parafrase | 8 | 50% | 75% | +25 pts | 100% |
| sinonimo_sigla | 6 | 50% | 67% | +17 pts | 100% |
| nome_proprio | 4 | 100% | 75% | -25 pts | 100% |
| TOTAL (com resposta) | 62 | 82% | 92% | +10 pts | 100% |

Abstencao em perguntas sem resposta (responde "nao encontrei"): 100% sem rerank, 100% com rerank (n=7).

Falsa abstencao (pergunta com resposta respondida com "nao encontrei"): 5% sem rerank, 2% com rerank (0% pelo limiar de relevancia, sem chamar o gerador; 2% pelo gerador). Sem rerank o limiar e 0.

<details><summary>Detalhe com rerank / sem rerank</summary>

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| literal | 44 | 1 | 1 | 1 | 1 | 0.7727 | 0.9292 | 0.9803 | 0 |
| parafrase | 8 | 0.75 | 1 | 1 | 0.875 | 0.875 | 0.875 | 0.975 | 0.125 |
| sinonimo_sigla | 6 | 0.6667 | 1 | 1 | 0.8333 | 0.3333 | 0.9583 | 0.9722 | 0 |
| nome_proprio | 4 | 0.75 | 1 | 1 | 0.875 | 1 | 0.875 | 0.8875 | 0 |
| TOTAL (com resposta) | 62 | 0.9194 | 1 | 1 | 0.9597 | 0.7581 | 0.9215 | 0.9728 | 0.0161 |

(sem rerank)

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| literal | 44 | 0.9091 | 0.9773 | 0.9773 | 0.9432 | 0.7955 | 0.9065 | 0.9621 | 0.0227 |
| parafrase | 8 | 0.5 | 0.625 | 0.875 | 0.6396 | 0.875 | 0.875 | 0.7083 | 0.125 |
| sinonimo_sigla | 6 | 0.5 | 0.6667 | 0.8333 | 0.5972 | 0.5 | 0.8333 | 0.6667 | 0.1667 |
| nome_proprio | 4 | 1 | 1 | 1 | 1 | 1 | 0.875 | 0.8875 | 0 |
| TOTAL (com resposta) | 62 | 0.8226 | 0.9032 | 0.9516 | 0.8742 | 0.7903 | 0.8933 | 0.896 | 0.0484 |

</details>

# Limitacoes

- Juiz lexical (sobreposicao de tokens, sem entailment): o LLM parafraseia, entao faithfulness e answer_relevance ficam subestimados em relacao ao gerador extrativo local. Abstencao so conta respostas que comecam com "nao encontrei".
- Temperatura 0 para reduzir a variancia; a producao usa o padrao da API. Nem com temperatura 0 a OpenAI garante saida identica entre rodadas.
- Pesos do ranking, limiar de abstencao (0.17) e sinonimos foram calibrados no dev com embeddings locais e o LocalReranker; nada foi recalibrado para a OpenAI nem ajustado sobre o held-out.
- Poucas perguntas por categoria (4 a 8) e 2 sem resposta no held-out: variacao alta, nao ha intervalo de confianca.
- Modo agente nao roda nesta configuracao (so no modo local, em `latest.md`).

# Frase para o curriculo (baseada no held-out)

RAG avaliado com a configuracao de producao (text-embedding-3-small + gpt-4o-mini) em 20 perguntas held-out nunca usadas para ajuste: recall@5 de 78% sem reranking e 89% com reranking (+11 pts); recall@1 de 44% para 61% (+17 pts). Abstencao de 100% em perguntas sem resposta no corpus (n=2).
