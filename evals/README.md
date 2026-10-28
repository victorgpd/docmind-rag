# evals

Avaliação automática do RAG do DocMind. O juiz é lexical e determinístico (sem API). O modo padrão (`local`) não usa rede; o modo `openai` mede a configuração de produção.

```
pnpm --dir evals eval     # local: roda dev + held-out, grava results/latest.{md,json} e eval_runs (é o gate de CI)
pnpm --dir evals test

# configuração de produção (paga, centavos): a chave só vai para o ambiente do processo, nunca para arquivo ou log
cd evals && node --env-file=../.env ../node_modules/tsx/dist/cli.mjs src/run.ts --provider openai   # grava results/openai-latest.{md,json}
#   --weights 0.5/0.4/0.1 --min-relevance 0.1 --out openai-calibrated   # troca so a config com rerank
cd evals && node --env-file=../.env ../node_modules/tsx/dist/cli.mjs src/calibrate.ts --provider openai   # calib/: grava results/calib-openai.{md,json}
```

## Conjuntos

| Conjunto | Onde | Para quê |
|---|---|---|
| dev | `corpus/`, `dataset/questions.json` (69 perguntas) | Usado para ajustar o sistema. Superestima. |
| held-out | `heldout/` (2 docs + 20 perguntas) | Validação. **Não otimizar sobre ele.** Número citado no README do projeto. |

O held-out é indexado junto com o corpus dev (mais distratores) e só sai agregado em `results/latest.json`.
Para mudar o sistema, use o dev ou perguntas próprias; rode o held-out só para validar.

## Métricas

recall@1/3/5 e MRR (o trecho-fonte esperado está entre os resultados), faithfulness (afirmações da resposta sustentadas pelas passagens
citadas), answer/context relevance (cobertura lexical da resposta esperada) e taxa de abstenção nas perguntas sem resposta.
Cada config roda com e sem rerank.

## Modo agente

`agent/tasks.json`: 10 tarefas (search, summarize, compare, extract_table e uma pergunta fora do corpus) sobre o corpus dev + `agent/corpus/`.
Critérios determinísticos por tarefa: ferramentas na ordem esperada, passos ≤ limite, fatos/tabela esperados (ou abstenção fora do corpus) e citações.
Taxa de acerto por ferramenta em `results/latest.md`. Não entra no gate de CI (só reporta).

## Gate de CI (`pnpm eval` sai 1 se falhar)

Pisos de regressão, não metas:

| Verificação | Piso | Medido em 2026-10-28 |
|---|---|---|
| dev recall@5 | 0.85 | 0.98 |
| dev faithfulness | 0.90 | 1.0 |
| held-out recall@5 | 0.60 (`--min-heldout-recall5`) | 0.67 |
| held-out faithfulness | 0.90 | 1.0 |
| `search()` e lista do prompt idênticos | 0 divergências | 0 |

**Meta aspiracional:** recall@5 de 0.80 no held-out. Alvo, não atingido com embeddings locais lexicais.

## Reprodutibilidade: `ANALYZE chunks` após a ingestão

O adapter roda `analyze chunks` ao fim de `ingest()`. Sem isso, o PGlite recém-populado não tem estatísticas do planner e a busca vetorial usa o HNSW **aproximado**, cujo grafo é construído com aleatoriedade a cada execução: a configuração **sem rerank** oscilava no mesmo código (dev recall@5 de 91,9% a 93,5%, MRR de 0,8419 a 0,8508; no held-out algumas perguntas trocavam de posição). A configuração **com rerank** (a de produção, a que o gate avalia) nunca oscilou. Causa isolada em 2026-10-28; não é o filtro por `embedding_model` nem o adapter.

Com o `ANALYZE` o planner escolhe a varredura exata e o resultado é determinístico (3 execuções seguidas com saída idêntica em 2026-10-28). Os números oficiais "sem rerank" mudaram uma vez, para os exatos:

| Conjunto | config | recall@1 | recall@5 | MRR |
|---|---|---|---|---|
| dev | sem rerank | 79,0% | 93,5% | 0,8473 |
| dev | com rerank | 88,7% | 98,4% | 0,9382 |
| held-out | sem rerank | 22,2% | 61,1% | 0,3750 |
| held-out | com rerank | 44,4% | 66,7% | 0,5556 |

Os limiares do gate não mudaram. Em produção o worker faz o ANALYZE quando a fila esvazia (PGlite) e o Postgres tem autovacuum.

## Configuração de produção (`--provider openai`)

O que muda em relação ao local: embeddings dos chunks **e** das consultas pelo mesmo provider (`text-embedding-3-small`, `dimensions=384`, id `openai:text-embedding-3-small:384`) e geração das respostas pelo `gpt-4o-mini`, o que roda em produção (`.env` com `LLM_PROVIDER=openai`). O rerank continua o `LocalReranker`; ranking e limiar de abstenção são os padrões (`RAG_*` do `.env` = defaults); o contexto de cada chunk é a frase determinística, como em produção (`INGEST_LLM_CONTEXT=false`). O `ANALYZE` após a ingestão continua.

- **Geração pelo gpt-4o-mini, com temperatura 0.** Escolhida porque é o que o usuário recebe em produção (a abstenção e a faithfulness do gerador extrativo local não dizem nada sobre o LLM). A temperatura 0 é só da avaliação (`OpenAIProvider({ temperature: 0 })`); a produção usa o padrão da API.
- **Determinismo.** recall@1/3/5 idênticos nas 3 rodadas; só uma pergunta do dev (sem rerank) saiu da 6ª posição na rodada 3 (MRR 0,8769 para 0,8742), por variação dos floats do embedding entre chamadas. O adapter memoriza o embedding de cada texto, então `search()` e `generate()` usam o mesmo vetor da pergunta (0 divergências de lista). A geração varia mesmo com temperatura 0: 12 das 69 respostas do dev mudaram entre as rodadas.
- **Gate.** Com o LLM, faithfulness lexical fica em ~0,78 e o gate (piso 0,90, calibrado para o gerador extrativo) sai 1. É esperado: o CI só roda o modo local.
- Modo agente não roda nesta configuração.

Medido em 2026-10-28 (3 rodadas; `openai-latest.*` é a 3ª):

| Conjunto | config | recall@1 local | recall@1 OpenAI | recall@5 local | recall@5 OpenAI | MRR local | MRR OpenAI |
|---|---|---|---|---|---|---|---|
| held-out | sem rerank | 22,2% | 44,4% | 61,1% | 77,8% | 0,3750 | 0,5852 |
| held-out | com rerank | 44,4% | 50,0% | 66,7% | 77,8% | 0,5556 | 0,5972 |
| dev | sem rerank | 79,0% | 82,3% | 93,5% | 95,2% | 0,8473 | 0,8742–0,8769 |
| dev | com rerank | 88,7% | 90,3% | 98,4% | 98,4% | 0,9382 | 0,9462 |

| Conjunto | config | abstenção local | abstenção OpenAI | faithfulness local | faithfulness OpenAI (rodadas 1 / 2 / 3) |
|---|---|---|---|---|---|
| held-out (n=2 sem resposta) | sem rerank | 0% | 100% | 100% | 66,7% / 66,7% / 72,2% |
| held-out | com rerank | 0% | 100% | 100% | 77,8% / 77,8% / 77,8% |
| dev (n=7 sem resposta) | sem rerank | 0% | 100% | 100% | 77,4% / 82,3% / 75,8% |
| dev | com rerank | 57% | 100% | 100% | 77,4% / 79,0% / 75,8% |

Leitura honesta:

- Com embeddings neurais o held-out sobe de 67% para 78% de recall@5 (com rerank). A meta de 80% continua **não atingida**.
- Com OpenAI o rerank **não melhora o recall@5** no held-out (78% com e sem); melhora o recall@1 de 44% para 50% e o MRR de 0,585 para 0,597. Por categoria ele ajuda em sinônimo/sigla (recall@5 50% para 83%) e atrapalha em paráfrase (88% para 75%) e nome próprio (100% para 75%): o LocalReranker é lexical e foi calibrado com embeddings locais. Nada foi recalibrado (nem olhando o held-out).
- Abstenção de 100% vem sobretudo do LLM, que responde "Não encontrei..." quando os trechos não bastam; com n=2 no held-out é um indício, não validação.
- Faithfulness abaixo do local não significa mais alucinação: o juiz é lexical (sobreposição de tokens, sem entailment) e o LLM parafraseia (ex. do dev: "O aviso prévio para rescindir o contrato é de 60 dias, conforme indicado no trecho [1]."). Answer relevance no held-out cai com rerank (64% para 39%; no local 48% para 31%): é a falsa abstenção (abaixo).
- Custo por rodada completa (dev + held-out, com e sem rerank): 8.108 tokens de embedding, ~82 mil de entrada e ~3,2 mil de saída no chat (166 chamadas), **~US$ 0,014** (US$ 0,02/1M embeddings; US$ 0,15/0,60 por 1M no gpt-4o-mini). As 3 rodadas: ~US$ 0,043.

### Falsa abstenção (pergunta com resposta respondida com "não encontrei")

Métrica `false_abstention` por categoria (e `false_abstention_gate`: parte decidida pelo limiar `RAG_MIN_RELEVANCE`, em que nenhum trecho é enviado ao gerador). Por pergunta só no dev; o held-out só sai agregado. Sem rerank o limiar é 0, então toda abstenção ali vem do gerador. Valores da rodada 3 (OpenAI) e do local:

| Conjunto | config | local | OpenAI | OpenAI: pelo limiar | OpenAI: pelo gpt-4o-mini |
|---|---|---|---|---|---|
| held-out (n=18) | sem rerank | 0% | 33% | 0% | 33% |
| held-out | com rerank | **44%** (todo pelo limiar) | **61%** | 39% | 22% |
| dev (n=62) | sem rerank | 0% | 3% | 0% | 3% |
| dev | com rerank | 2% (limiar) | 2% | 2% | 0% |

Por categoria no held-out com rerank: paráfrase 50% (local) e 50% (OpenAI, 38 pts pelo limiar); sinônimo/sigla 67% e 83% (67 pts pelo limiar); nome próprio 0% e 50% (0 pelo limiar). No dev, a única falsa abstenção com rerank é uma paráfrase (relevância 0,115 < 0,17). As 2 do gpt-4o-mini sem rerank são perguntas cujo trecho-fonte nem estava entre os recuperados (literal e sinônimo/sigla).

- **Causa.** No held-out, a maior parte vem do limiar: o score do `LocalReranker` é lexical, e paráfrases e siglas inéditas ficam abaixo de 0,17 mesmo quando o trecho certo foi recuperado. O resto é o gpt-4o-mini recusando com trechos na mão (33% sem limiar). Isso explica a queda de answer relevance com rerank.
- **O dev não serve para calibrar.** Nele a falsa abstenção é de 2% (3% sem rerank): suas perguntas compartilham vocabulário com os trechos, e só 1 pergunta com resposta fica abaixo de 0,17. Calibrar olhando o held-out seria sobreajuste. Por isso foi criado o conjunto `calib/` (abaixo).

## Calibração para `LLM_PROVIDER=openai` (`calib/`)

`calib/questions.json` tem 30 perguntas novas sobre o corpus dev: 10 paráfrases, 6 sinônimos/siglas, 4 nomes próprios, 4 literais e 6 sem resposta. Foram escritas sem olhar o held-out nem os erros. O teste confere três coisas: o trecho-fonte existe no documento, paráfrases e siglas quase não repetem as palavras do trecho, e nenhuma pergunta repete o dev ou o held-out (duas coincidiram por acaso com o dev e foram reescritas).

`src/calibrate.ts` faz 1 rodada por config de pesos (0,8/0,1/0,1, a atual; 0,5/0,4/0,1; 0,3/0,6/0,1) com limiar 0. O limiar (0,00 a 0,30, passo 0,02, mais o 0,17 atual) é varrido offline. Isso é exato, porque o limiar só decide se o gerador é chamado e não muda a ordem dos trechos. O critério ficou fixado no código (`pick`, em `runner.ts`) antes de rodar: maior abstenção correta nas perguntas sem resposta, com falsa abstenção ≤ 10% e recall@5 ≥ o dos pesos atuais. Empate: pesos atuais primeiro, depois o limiar mais próximo de 0,17. A grade completa está em `results/calib-openai.md`.

| calib, OpenAI + rerank | recall@5 | abstenção correta (n=6) | falsa abstenção (n=24) | pelo limiar |
|---|---|---|---|---|
| atual: 0,8/0,1/0,1, limiar 0,17 | 83% | 100% | 42% | 38% |
| 0,8/0,1/0,1, limiar 0 | 83% | 100% | 13% | 0% |
| **escolhido: 0,5/0,4/0,1, limiar 0,10** | **92%** | **100%** | **8%** | 8% |
| 0,5/0,4/0,1, limiar ≤ 0,06 | 92% | 100% | 0% | 0% |
| 0,3/0,6/0,1, limiar ≤ 0,06 | 100% | 100% | 0% | 0% |

- O gpt-4o-mini se absteve sozinho nas 6 perguntas sem resposta em todas as configs. No calib, o limiar não acrescenta abstenção correta, só falsa abstenção.
- Com os pesos atuais, mesmo com limiar 0, sobram 13%: são 3 recusas do LLM, todas com o trecho-fonte fora do top-5, ou seja, falha de recuperação e não de geração. Mais peso na similaridade vetorial resolve.
- Como todas as configs empatam em 100% de abstenção, o critério escolheu os pesos mais próximos dos atuais e o limiar mais próximo de 0,17, que é 0,10. Com limiar 0,06 ou menos, a falsa abstenção no calib seria 0%. Nada foi ajustado depois de ver o held-out.

**Verificação única no held-out** (`results/openai-calibrated.md`), OpenAI + rerank:

| held-out (18 com resposta + 2 sem) | recall@1 | recall@5 | MRR | abstenção correta | falsa abstenção | pelo limiar | pelo gpt-4o-mini | answer relevance |
|---|---|---|---|---|---|---|---|---|
| antes: 0,8/0,1/0,1, limiar 0,17 | 50% | 78% | 0,597 | 100% | 61% | 39% | 22% | 39% |
| depois: 0,5/0,4/0,1, limiar 0,10 | **61%** | **89%** | 0,736 | 100% | **33%** | 17% | 17% | 65% |

No dev com rerank, depois da calibração: recall@5 100%, falsa abstenção 2% (vinda do gerador) e abstenção correta 100%.

- **A melhora é grande, mas não chega à meta.** No held-out a falsa abstenção (33%) continua acima do teto de 10% do calib. Sinônimo/sigla ainda perde 50% pelo limiar, porque siglas inéditas têm score lexical baixo.
- **O gpt-4o-mini recusa 3 de 18 mesmo com trechos.** Pelo menos 1 delas tinha o trecho-fonte no top-5, já que o recall@5 é 89%. Isso é do prompt e do modelo: só registrado, sem mudança no prompt.
- **Faithfulness lexical cai de 78% para 67%,** porque mais perguntas recebem resposta (parafraseada).
- **Recomendação de produção (só com `LLM_PROVIDER=openai`):** `RAG_MIN_RELEVANCE=0.10`, `RAG_W_RERANK=0.5`, `RAG_W_SIM=0.4`, `RAG_W_RRF=0.1`. Valores registrados em `docs/DEPLOY.md` (passo 2) e comentados em `infra/.env.production.example`; o `docker-compose.prod.yml` agora repassa as `RAG_*` (vazio = padrão). Os defaults do código (0,17 e 0,8/0,1/0,1, do modo local), o modo local e o CI não mudaram.
- **Custo:** calibração US$ 0,008 (90 chamadas de chat, 44,6 mil tokens de entrada) + verificação US$ 0,015.

## Limitações

Veja a seção "Limitações" em `results/latest.md` (local: embedding lexical, gerador extrativo, juiz lexical, poucas perguntas por categoria) e em `results/openai-latest.md`.
Embeddings neurais da OpenAI foram medidos (acima); Ollama não foi medido.
