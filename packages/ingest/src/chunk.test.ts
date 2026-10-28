import { describe, expect, it } from 'vitest';
import { chunkPages, countTokens } from './chunk';
import { cleanPages } from './clean';

const para = (n: number, w = 'palavra') => `${Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')}.`;

describe('chunkPages', () => {
  it('respeita o alvo de tokens e preserva a pagina de inicio', () => {
    const pages = [1, 2, 3].map((p) => ({ page: p, text: [para(120), para(120), para(120)].join('\n\n') }));
    const out = chunkPages(pages, { targetTokens: 200 });
    expect(out.length).toBeGreaterThan(3);
    for (const c of out) expect(c.tokenCount).toBeLessThanOrEqual(200 + 1);
    expect(out.map((c) => c.ordinal)).toEqual(out.map((_, i) => i));
    expect(out[0]!.page).toBe(1);
    expect(out.at(-1)!.page).toBe(3);
  });

  it('aplica ~15% de sobreposicao entre chunks consecutivos', () => {
    const out = chunkPages([{ page: 1, text: [para(150), para(150), para(150)].join('\n\n') }], { targetTokens: 200 });
    const [a, b] = out;
    const overlapWords = b!.content.split(/\s+/).slice(0, 5);
    expect(a!.content).toContain(overlapWords.join(' '));
    const shared = countTokens(overlapWords.join(' '));
    expect(shared).toBeGreaterThan(0);
  });

  it('quebra paragrafo gigante por sentencas sem estourar o alvo', () => {
    const big = Array.from({ length: 60 }, (_, i) => `Frase numero ${i} do texto longo.`).join(' ');
    const out = chunkPages([{ page: null, text: big }], { targetTokens: 100 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.tokenCount).toBeLessThanOrEqual(101);
  });

  it('associa a secao do ultimo titulo (markdown e CAIXA ALTA)', () => {
    const out = chunkPages([{ page: null, text: '# Visao Geral\n\nTexto um.\n\nPRAZOS\n\nTexto dois.' }], { targetTokens: 5 });
    expect(out.find((c) => c.content.includes('Texto um'))!.section).toBe('Visao Geral');
    expect(out.find((c) => c.content.includes('Texto dois'))!.section).toBe('PRAZOS');
  });

  it('texto vazio nao gera chunks', () => {
    expect(chunkPages([{ page: 1, text: '' }])).toEqual([]);
  });
});

describe('cleanPages', () => {
  it('remove cabecalho/rodape repetido e numero de pagina', () => {
    const body = ['alfa beta.', 'gama delta.', 'epsilon zeta.', 'eta theta.'];
    const pages = body.map((b, i) => ({ page: i + 1, text: `Relatorio ACME 2026\n${b}\nPagina ${i + 1} de 4` }));
    expect(cleanPages(pages).map((p) => p.text)).toEqual(body);
  });

  it('junta quebras de linha do PDF e hifenizacao, mantendo paragrafos', () => {
    const [p] = cleanPages([{ page: 1, text: 'primeira linha da fra-\nse continua aqui\ne termina.\n\nOutro   paragrafo.' }]);
    expect(p!.text).toBe('primeira linha da frase continua aqui e termina.\n\nOutro paragrafo.');
  });
});
