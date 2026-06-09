-- Add fiscal and accounting columns to orders table

-- Invoice information
ALTER TABLE orders ADD COLUMN invoice_number TEXT;
ALTER TABLE orders ADD COLUMN invoice_date TIMESTAMPTZ;

-- Customer tax information
ALTER TABLE orders ADD COLUMN customer_tax_id TEXT; -- RUT del cliente

-- Financial breakdown for accounting
ALTER TABLE orders ADD COLUMN net_taxable_amount NUMERIC; -- Monto neto sin IVA
ALTER TABLE orders ADD COLUMN vat_amount NUMERIC; -- IVA (19%)
ALTER TABLE orders ADD COLUMN vat_rate NUMERIC DEFAULT 19.0; -- Tasa de IVA configurable

-- Accounting classification
ALTER TABLE orders ADD COLUMN accounting_period TEXT; -- Formato: YYYY-MM
ALTER TABLE orders ADD COLUMN accounting_category TEXT; -- Ej: "Ventas Mercadería Online"

-- Cost and profitability
ALTER TABLE orders ADD COLUMN cost_of_goods_sold NUMERIC; -- Costo del producto vendido
ALTER TABLE orders ADD COLUMN gross_profit NUMERIC; -- Utilidad bruta

-- Additional notes for accountant
ALTER TABLE orders ADD COLUMN notes_for_accountant TEXT;

-- Create index for faster queries by accounting period
CREATE INDEX idx_orders_accounting_period ON orders(accounting_period);

-- Create index for invoice lookup
CREATE INDEX idx_orders_invoice_number ON orders(invoice_number);

-- Create function to auto-calculate accounting period from order_date
CREATE OR REPLACE FUNCTION calculate_accounting_period(order_date TIMESTAMPTZ)
RETURNS TEXT AS $$
BEGIN
  RETURN TO_CHAR(order_date, 'YYYY-MM');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create function to auto-calculate VAT and net amounts
CREATE OR REPLACE FUNCTION calculate_vat_breakdown(total_amount NUMERIC, vat_rate NUMERIC DEFAULT 19.0)
RETURNS TABLE(net_amount NUMERIC, vat_amount NUMERIC) AS $$
BEGIN
  RETURN QUERY SELECT 
    ROUND(total_amount / (1 + vat_rate / 100), 2) AS net_amount,
    ROUND(total_amount - (total_amount / (1 + vat_rate / 100)), 2) AS vat_amount;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create function to auto-calculate gross profit
CREATE OR REPLACE FUNCTION calculate_gross_profit(net_amount NUMERIC, cogs NUMERIC)
RETURNS NUMERIC AS $$
BEGIN
  RETURN ROUND(net_amount - COALESCE(cogs, 0), 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;