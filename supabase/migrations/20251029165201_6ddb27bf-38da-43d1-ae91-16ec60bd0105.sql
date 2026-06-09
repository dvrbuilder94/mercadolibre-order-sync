-- Add meli_order_id to settlement_items for ML order tracking
ALTER TABLE settlement_items 
ADD COLUMN IF NOT EXISTS meli_order_id TEXT;

CREATE INDEX IF NOT EXISTS settlement_items_meli_order_id_idx 
ON settlement_items(meli_order_id);

-- Add match tracking fields to order_tax_documents
ALTER TABLE order_tax_documents 
ADD COLUMN IF NOT EXISTS match_source TEXT DEFAULT 'MANUAL',
ADD COLUMN IF NOT EXISTS match_score INTEGER DEFAULT 0;

COMMENT ON COLUMN settlement_items.meli_order_id IS 'MercadoLibre order_id extracted from payment/merchant order';
COMMENT ON COLUMN order_tax_documents.match_source IS 'How the match was made: EXPLICIT, HEURISTIC, MANUAL';
COMMENT ON COLUMN order_tax_documents.match_score IS 'Confidence score 0-100 for heuristic matches';