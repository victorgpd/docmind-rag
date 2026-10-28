-- Aditiva: contexto (contextual retrieval), secao e contagem de tokens por chunk.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS context text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS token_count integer;
