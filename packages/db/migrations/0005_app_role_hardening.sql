-- Aditiva: docmind_app so acessa o que receber GRANT explicito e nao altera esquema nem politicas.
-- (RLS so e alteravel pelo dono da tabela; docmind_app nunca e dono e nao tem CREATE no schema.)
ALTER ROLE docmind_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM docmind_app;
-- tabelas futuras nao herdam acesso: remove qualquer default privilege concedido a docmind_app
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM docmind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM docmind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM docmind_app;
-- refresh_tokens e so da conexao privilegiada (auth); explicita a ausencia de acesso
REVOKE ALL ON refresh_tokens FROM docmind_app;
