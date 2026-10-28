-- Payload estruturado da resposta do agente (intent, tabela extraida, passos): permite recarregar o historico.
-- Aditiva e nullable: mensagens existentes e do chat comum ficam com NULL.
ALTER TABLE messages ADD COLUMN data jsonb;
