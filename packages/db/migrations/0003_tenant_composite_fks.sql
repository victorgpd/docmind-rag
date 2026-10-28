-- Aditiva: FKs compostas (organization_id, id) para que uma linha nunca aponte para registro de OUTRA organizacao,
-- mesmo que a aplicacao erre (conexao privilegiada ignora RLS). As FKs simples antigas ficam: continuam
-- responsaveis pelo ON DELETE. Falha se ja houver linha cruzada (dado inconsistente que precisa de correcao manual).
-- Fora do escopo: user_id (conversations/feedback/usage_events) -> users.

ALTER TABLE collections   ADD CONSTRAINT collections_org_id_key   UNIQUE (organization_id, id);
ALTER TABLE documents     ADD CONSTRAINT documents_org_id_key     UNIQUE (organization_id, id);
ALTER TABLE conversations ADD CONSTRAINT conversations_org_id_key UNIQUE (organization_id, id);
ALTER TABLE messages      ADD CONSTRAINT messages_org_id_key      UNIQUE (organization_id, id);

ALTER TABLE documents ADD CONSTRAINT documents_org_collection_fk
  FOREIGN KEY (organization_id, collection_id) REFERENCES collections (organization_id, id) ON DELETE CASCADE;
ALTER TABLE chunks ADD CONSTRAINT chunks_org_document_fk
  FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id) ON DELETE CASCADE;
ALTER TABLE chunks ADD CONSTRAINT chunks_org_collection_fk
  FOREIGN KEY (organization_id, collection_id) REFERENCES collections (organization_id, id) ON DELETE CASCADE;
-- collection_id e anulavel (MATCH SIMPLE ignora NULL); sem SET NULL aqui, pois anularia organization_id tambem
ALTER TABLE conversations ADD CONSTRAINT conversations_org_collection_fk
  FOREIGN KEY (organization_id, collection_id) REFERENCES collections (organization_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_org_conversation_fk
  FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations (organization_id, id) ON DELETE CASCADE;
ALTER TABLE feedback ADD CONSTRAINT feedback_org_message_fk
  FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id) ON DELETE CASCADE;
