-- Aditiva: momento da ultima mudanca do documento (status, reprocesso). Entra na versao do cache semantico
-- (contagem + max(updated_at) dos documentos do escopo), que vale tambem quando o worker roda em outro processo.
-- Default now() e calculado uma vez no ALTER: sem reescrever a tabela. O drizzle (schema.ts, $onUpdate) atualiza a cada UPDATE.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
