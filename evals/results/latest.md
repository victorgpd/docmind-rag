Juiz local deterministico (sem API).

# Held-out (validacao: numero do README)

18 perguntas com resposta + 2 sem resposta no corpus.

| categoria | n | recall@1 sem rerank | recall@1 com rerank | delta | recall@5 com rerank |
|---|---|---|---|---|---|
| parafrase | 8 | 25% | 38% | +13 pts | 63% |
| sinonimo_sigla | 6 | 0% | 33% | +33 pts | 67% |
| nome_proprio | 4 | 50% | 75% | +25 pts | 75% |
| TOTAL (com resposta) | 18 | 22% | 44% | +22 pts | 67% |

Abstencao em perguntas sem resposta (responde "nao encontrei"): 0% sem rerank, 0% com rerank (n=2).

Falsa abstencao (pergunta com resposta respondida com "nao encontrei"): 0% sem rerank, 44% com rerank (44% pelo limiar de relevancia, sem chamar o gerador; 0% pelo gerador). Sem rerank o limiar e 0.

<details><summary>Detalhe com rerank / sem rerank</summary>

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| parafrase | 8 | 0.375 | 0.5 | 0.625 | 0.5104 | 1 | 0.1875 | 0.6667 | 0.5 |
| sinonimo_sigla | 6 | 0.3333 | 0.5 | 0.6667 | 0.4861 | 1 | 0.2 | 0.5333 | 0.6667 |
| nome_proprio | 4 | 0.75 | 0.75 | 0.75 | 0.75 | 1 | 0.7 | 0.7 | 0 |
| TOTAL (com resposta) | 18 | 0.4444 | 0.5556 | 0.6667 | 0.5556 | 1 | 0.3056 | 0.6296 | 0.4444 |

(sem rerank)

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| parafrase | 8 | 0.25 | 0.75 | 0.75 | 0.4375 | 1 | 0.4833 | 0.8417 | 0 |
| sinonimo_sigla | 6 | 0 | 0.1667 | 0.3333 | 0.1528 | 1 | 0.3333 | 0.2 | 0 |
| nome_proprio | 4 | 0.5 | 0.75 | 0.75 | 0.5833 | 1 | 0.7 | 0.7 | 0 |
| TOTAL (com resposta) | 18 | 0.2222 | 0.5556 | 0.6111 | 0.375 | 1 | 0.4815 | 0.5963 | 0 |

</details>

# Dev (usado para ajustar o sistema)

62 perguntas com resposta + 7 sem resposta no corpus.

| categoria | n | recall@1 sem rerank | recall@1 com rerank | delta | recall@5 com rerank |
|---|---|---|---|---|---|
| literal | 44 | 89% | 98% | +9 pts | 100% |
| parafrase | 8 | 38% | 63% | +25 pts | 88% |
| sinonimo_sigla | 6 | 67% | 67% | 0 pts | 100% |
| nome_proprio | 4 | 75% | 75% | 0 pts | 100% |
| TOTAL (com resposta) | 62 | 79% | 89% | +10 pts | 98% |

Abstencao em perguntas sem resposta (responde "nao encontrei"): 0% sem rerank, 57% com rerank (n=7).

Falsa abstencao (pergunta com resposta respondida com "nao encontrei"): 0% sem rerank, 2% com rerank (2% pelo limiar de relevancia, sem chamar o gerador; 0% pelo gerador). Sem rerank o limiar e 0.

<details><summary>Detalhe com rerank / sem rerank</summary>

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| literal | 44 | 0.9773 | 1 | 1 | 0.9886 | 1 | 0.9765 | 0.9803 | 0 |
| parafrase | 8 | 0.625 | 0.875 | 0.875 | 0.7708 | 1 | 0.5875 | 0.85 | 0.125 |
| sinonimo_sigla | 6 | 0.6667 | 1 | 1 | 0.8333 | 1 | 0.8333 | 0.9722 | 0 |
| nome_proprio | 4 | 0.75 | 1 | 1 | 0.875 | 1 | 0.8875 | 0.8875 | 0 |
| TOTAL (com resposta) | 62 | 0.8871 | 0.9839 | 0.9839 | 0.9382 | 1 | 0.9067 | 0.9567 | 0.0161 |

(sem rerank)

| categoria | n | recall@1 | recall@3 | recall@5 | mrr | faithfulness | answer_relevance | context_relevance | false_abstention |
|---|---|---|---|---|---|---|---|---|---|
| literal | 44 | 0.8864 | 0.9773 | 1 | 0.9288 | 1 | 0.9803 | 0.9576 | 0 |
| parafrase | 8 | 0.375 | 0.625 | 0.625 | 0.4792 | 1 | 0.5313 | 0.6667 | 0 |
| sinonimo_sigla | 6 | 0.6667 | 0.8333 | 0.8333 | 0.75 | 1 | 0.6667 | 0.8056 | 0 |
| nome_proprio | 4 | 0.75 | 1 | 1 | 0.8333 | 1 | 0.7625 | 0.8875 | 0 |
| TOTAL (com resposta) | 62 | 0.7903 | 0.9194 | 0.9355 | 0.8473 | 1 | 0.878 | 0.9008 | 0 |

</details>

# Limitacoes

- O embedding local (hashing de tokens + stemming leve) e lexical: acerta quando pergunta e trecho compartilham palavras e erra em parafrases e sinonimos. O held-out mostra a capacidade real; o dev foi usado para ajustar o sistema e superestima.
- Com Ollama / embeddings neurais os numeros tendem a subir (nao medido).
- O gerador local e extrativo: faithfulness 100% e otimista. O juiz e lexical (sobreposicao de tokens), sem entailment semantico.
- Poucas perguntas por categoria (4 a 8) e 2 sem resposta no held-out: variacao alta, nao ha intervalo de confianca.
- Meta aspiracional de recall@5 no held-out: 80%. Alvo, nao atingido com embeddings locais lexicais. O gate de CI e um piso de regressao (60%), nao a meta.

# Frase para o curriculo (baseada no held-out)

Avaliacao automatica local do RAG (zero API externa), validada em 20 perguntas held-out nunca usadas para ajuste: recall@5 de 67% e recall@1 de 44% com reranking (22% sem), sendo 38% de recall@1 em perguntas parafraseadas (25% sem reranking). Em perguntas sem resposta no corpus, a taxa de abstencao foi de 0%.

# Modo agente

10 tarefas, criterios deterministicos: ferramentas na ordem esperada, passos <= limite, fatos/tabela esperados (ou abstencao fora do corpus) e citacoes. Taxa de acerto geral: 100%.

| ferramenta | n | acerto | tool_ok | steps_ok | content_ok | cited_ok |
|---|---|---|---|---|---|---|
| search | 3 | 100% | 100% | 100% | 100% | 100% |
| summarize | 2 | 100% | 100% | 100% | 100% | 100% |
| compare | 2 | 100% | 100% | 100% | 100% | 100% |
| extract_table | 2 | 100% | 100% | 100% | 100% | 100% |
| sem_resposta | 1 | 100% | 100% | 100% | 100% | 100% |

Sem falhas.
