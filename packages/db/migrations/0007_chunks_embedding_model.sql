-- Aditiva: modelo que gerou o embedding de cada chunk, para detectar consulta/chunks de modelos diferentes.
-- Nullable e sem default: o worker passa a gravar; linhas anteriores eram todas do provider local.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_model text;
UPDATE chunks SET embedding_model = 'local:hash-v2:384' WHERE embedding_model IS NULL;
