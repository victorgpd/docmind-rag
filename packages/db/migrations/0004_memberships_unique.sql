-- Um usuario tem no maximo um papel por organizacao.
CREATE UNIQUE INDEX IF NOT EXISTS memberships_org_user_uq ON memberships (organization_id, user_id);
