-- Add sales_channel column to tax_documents
ALTER TABLE tax_documents 
ADD COLUMN sales_channel TEXT DEFAULT NULL;

-- Create index for fast filtering
CREATE INDEX idx_tax_documents_sales_channel 
ON tax_documents(sales_channel);

-- Classify existing documents: MARKETPLACE if RUT exists in orders
UPDATE tax_documents td
SET sales_channel = 'MARKETPLACE'
WHERE EXISTS (
  SELECT 1 FROM orders o 
  WHERE UPPER(REPLACE(REPLACE(o.customer_tax_id, '-', ''), '.', '')) = 
        UPPER(REPLACE(REPLACE(td.client_tax_id, '-', ''), '.', ''))
);

-- Mark remaining as B2B
UPDATE tax_documents
SET sales_channel = 'B2B'
WHERE sales_channel IS NULL;