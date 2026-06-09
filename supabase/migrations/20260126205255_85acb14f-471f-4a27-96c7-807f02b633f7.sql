-- Agregar índice único para upsert por external_system + external_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_documents_external_unique 
ON tax_documents(user_id, external_system, external_id);
