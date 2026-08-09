# Cierre de prueba de un mes real

Este procedimiento valida un período completo con el cliente piloto. No se
marca como aprobado solo porque las funciones respondan `200`: las cifras deben
compararse con MercadoLibre, Mercado Pago y Bsale.

## 1. Preparación

- Elegir un mes cerrado con datos conocidos.
- Guardar exportaciones de control de MELI, Mercado Pago y Bsale.
- Confirmar que MELI y Bsale aparecen conectados en `/config`.
- Confirmar migraciones, funciones, cron y webhooks con
  `docs/operations-security.md`.

## 2. Ejecutar la cadena

En `/workflow`, seleccionar el período y ejecutar, en este orden:

1. Órdenes MercadoLibre.
2. Pagos por orden Mercado Pago.
3. Documentos Bsale.
4. Enriquecimiento de RUT.
5. Conciliación venta ↔ documento.

Después, en `/tesoreria`, pulsar actualizar para ejecutar también la ingesta
independiente de Mercado Pago y detectar pagos sin venta. Repetir cada paso
parcial hasta que informe `remaining = 0`, sin cursor pendiente y sin errores.

## 3. Resolver excepciones

En `/conciliacion`:

- aceptar o descartar candidatos pendientes;
- revisar ventas sin DTE;
- revisar diferencias de monto;
- revisar packs incompletos.

En `/devoluciones`, resolver devoluciones sin nota de crédito. En `/tesoreria`,
revisar pagos sin venta y asignaciones parciales.

## 4. Cuadratura y criterios de aprobación

Registrar el snapshot mensual mostrado en Tesorería:

| Control | Criterio para aprobar |
|---|---|
| Órdenes válidas | Igual al export de MELI del período |
| Ventas brutas | Igual a MELI, excluyendo canceladas/rechazadas |
| DTE vigentes | Igual a Bsale, considerando NC con signo negativo |
| Ventas sin DTE | 0, o lista explicada y aceptada por el cliente |
| Pagos sin venta | 0, o lista explicada |
| Fiscal vs. comercial neto de reversas | 0, o diferencia documentada |
| Caja bruta vs. fiscal | 0, o diferencia temporal/documentada |
| Bruto MP − fees − otras deducciones | Igual al neto MP |
| Devoluciones sin NC | 0, o excepción documentada |

## 5. Evidencia

Guardar para el período:

- export mensual de Quadra;
- exportaciones fuente;
- snapshot de cifras y diferencias;
- lista de excepciones aceptadas;
- fecha, usuario que ejecutó y resultado de cada paso;
- aprobación explícita del cliente piloto.

El piloto queda aprobado cuando los criterios anteriores se cumplen y una
segunda ejecución completa no crea duplicados ni cambia vínculos ya resueltos.
