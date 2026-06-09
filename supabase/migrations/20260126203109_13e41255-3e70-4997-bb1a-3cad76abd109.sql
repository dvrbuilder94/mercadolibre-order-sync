-- FASE 0: Agregar campo resync_batch para trazabilidad audit-ready

-- Agregar campo resync_batch a tax_documents
ALTER TABLE tax_documents 
ADD COLUMN IF NOT EXISTS resync_batch uuid;

-- Agregar campo resync_batch a order_tax_documents  
ALTER TABLE order_tax_documents 
ADD COLUMN IF NOT EXISTS resync_batch uuid;

-- Agregar índice para consultas por batch
CREATE INDEX IF NOT EXISTS idx_tax_documents_resync_batch ON tax_documents(resync_batch);
CREATE INDEX IF NOT EXISTS idx_order_tax_documents_resync_batch ON order_tax_documents(resync_batch);