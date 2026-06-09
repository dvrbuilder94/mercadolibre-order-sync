-- Add detected_channel column to tax_documents for multi-channel classification
ALTER TABLE tax_documents 
ADD COLUMN detected_channel TEXT DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN tax_documents.detected_channel IS 'Detected marketplace channel from Bsale reference reason: meli, falabella, amazon, shopify, or null';

-- Index for filtering by detected channel
CREATE INDEX idx_tax_documents_detected_channel ON tax_documents(detected_channel);