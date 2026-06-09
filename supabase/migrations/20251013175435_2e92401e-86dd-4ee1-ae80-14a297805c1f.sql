-- Limpiar todos los datos de transacciones (manteniendo configuración de canales)

-- Eliminar detalles de pago de MercadoLibre
DELETE FROM meli_payment_details;

-- Eliminar conciliaciones
DELETE FROM reconciliations;

-- Eliminar movimientos bancarios
DELETE FROM bank_movements;

-- Eliminar pagos
DELETE FROM payments;

-- Eliminar órdenes
DELETE FROM orders;