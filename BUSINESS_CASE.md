# Business Case — LedgerSync

> Conciliación automática para vendedores de marketplaces en Chile.
> **Venta → Documento (SII) → Pago (MercadoPago) → Depósito (banco).**
> Actualizado: 2026-06-13.

---

## 1. El problema

Un vendedor que opera en MercadoLibre (y luego Shopify, Falabella, Paris, Ripley)
vive **a ciegas** respecto de su propia plata. Tres preguntas que hoy no puede
responder sin horas de planilla manual:

1. **¿Emití el documento tributario correcto por cada venta?** (boleta/factura para
   el SII). Si falta una boleta o sobra una, es riesgo de multa y un F29 mal armado.
2. **¿Me pagó el marketplace? ¿cuánto, después de comisiones, y cuándo?** El dinero
   de MercadoPago se libera con retraso y descuentos variables. El vendedor no sabe
   cuánto le deben *hoy* ni qué liberaciones están atrasadas.
3. **¿Ese pago llegó efectivamente al banco?** La última milla: conciliar el depósito
   real contra lo que el marketplace dice que liberó.

Hoy esto se hace exportando planillas de cada sistema y cruzándolas a mano. **No
escala**: un vendedor mediano mueve cientos a miles de movimientos al mes
(en nuestra data real: ~900 órdenes ML y ~800 documentos Bsale en un solo mes),
y cada canal nuevo multiplica el trabajo manual.

### Por qué duele de verdad

- **Riesgo tributario**: ventas sin documento, o documentos sin venta, son
  inconsistencias que el SII puede observar.
- **Plata trabada invisible**: liberaciones de MercadoPago vencidas y no cobradas =
  capital de trabajo congelado que el vendedor ni sabe que existe.
- **Comisiones sin auditar**: el marketplace descuenta su fee; nadie verifica que el
  monto liberado coincida con lo que correspondía.
- **Costo de oportunidad**: horas de un contador o del dueño en planillas, en vez de
  vender.

---

## 2. La solución

LedgerSync se conecta a las APIs de cada sistema, **normaliza** todo a un modelo
común y **concilia automáticamente** las cuatro patas de la cadena de dinero:

| Pata | Pregunta que responde | Estado |
|---|---|---|
| 1. Venta ↔ Documento (SII) | ¿Emití la boleta/factura correcta? | ✅ Funcionando |
| 2. Venta ↔ Liberación (MercadoPago) | ¿Me pagaron bien y cuándo? | 🔜 Próxima fase |
| 3. Liberación ↔ Depósito (banco) | ¿Llegó la plata a mi cuenta? | 📋 Roadmap |
| (Transversal) Auditoría de comisión | ¿El fee cobrado es el correcto? | 📋 Roadmap |

El motor de conciliación es **100% determinístico** (identificadores explícitos,
RUT, montos, fechas, agrupación por `pack`), con scoring para los casos límite. No
depende de IA para los matches base — la IA queda reservada para explicar/resolver
los casos ambiguos, como lo haría un humano revisando manualmente.

### La ventaja arquitectónica clave: Bsale ya unifica los canales

El sistema de facturación (Bsale) **ya emite los documentos de todos los canales**
del vendedor (en nuestra data: Shopify, Falabella, Paris, Ripley y MELI conviven en
la misma cuenta Bsale). Esto significa que el lado "documento" de la conciliación es
**multicanal desde el día uno**. Sumar un marketplace nuevo no requiere un nuevo
sistema de documentos — solo un **conector de órdenes** que vuelque a la tabla
`orders` común. El conciliador lee de forma agnóstica al canal.

---

## 3. Mercado y cliente

- **Cliente objetivo**: vendedores chilenos en marketplaces con volumen medio-alto
  (cientos a miles de transacciones/mes), que ya facturan electrónicamente (Bsale,
  Nubox u otro) y operan en uno o más canales (MELI, Shopify, Falabella, Paris,
  Ripley).
- **Usuario que paga**: el dueño del negocio o su contador. El contador necesita el
  cumplimiento (pata 1); el dueño necesita saber *dónde está su plata* (patas 2-3).
- **Disparador de compra**: el dolor crece con el volumen y con cada canal nuevo. El
  punto de quiebre es cuando la planilla manual deja de ser viable.

---

## 4. Propuesta de valor

1. **Cumplimiento tributario sin esfuerzo** — cada venta cruzada con su documento;
   las inconsistencias saltan solas antes del F29.
2. **Visibilidad de caja** — "esto me deben, esto está atrasado, esto ya llegó al
   banco". Saca al vendedor de la ceguera.
3. **Auditoría de comisiones** — detecta cuando el marketplace cobró de más.
4. **Escala con el negocio** — multicanal por diseño; agregar un canal es agregar un
   conector, no rehacer el sistema.
5. **Automático y diario** (fase futura) — el vendedor abre el dashboard y todo está
   conciliado al día, sin apretar botones.

---

## 5. Estado del producto (hoy)

**Funcionando y validado:**
- Sync de órdenes MercadoLibre (paginado, resistente a timeouts).
- Sync de documentos Bsale multicanal (paginado por código SII, con checkpoint).
- Enriquecimiento de RUT vía API de ML.
- Motor de conciliación Venta↔Documento: matches exactos (order_id), por `pack`,
  consolidados (varias órdenes → un documento) y por score.
- Dashboard contable: KPIs de ventas brutas, fees, neto e IVA, con auditoría
  venta↔documento.
- Exportación de data cruda (RAW) para auditoría externa.

**En proceso / pendiente:**
- Despliegue del fix de sync Bsale (cuello de botella operativo actual).
- IVA exacto desde los documentos (hoy estimado).
- Sync incremental + ejecución diaria automática.

**La pata 2 (pagos) NO está lista**: la fuente de datos actual es sintética
(reconstruye pagos desde las órdenes en vez de traer la liberación real de
MercadoPago). Construir el dashboard de pagos sobre eso daría un "falso verde". La
fuente real existe (`sync-meli-payment-details`) pero está capada y desconectada —
ese es el primer trabajo de la épica de pagos.

---

## 6. Roadmap por fases

**Fase 1 — Cerrar lo tributario en MELI (en curso).**
Validar MELI↔Bsale al 100% como template probado. Desplegar el fix de Bsale, IVA
exacto, paginación robusta en el conciliador.

**Fase 2 — Conciliación de pagos (la pata grande, "¿dónde está mi plata?").**
Conectar la fuente real de MercadoPago, indicador de *aging* (liberaciones vencidas
sin cobrar), auditoría de comisión, y columna "Pago" en la vista de conciliación.

**Fase 3 — Multicanal.**
Endurecer el matching por referencia explícita por canal (para evitar falsos cruces
entre marketplaces que comparten RUT/monto/fecha), y sumar Shopify primero (mayor
volumen en la data), luego Falabella/Paris/Ripley. Cada canal = un conector nuevo.

**Fase 4 — Automatización diaria + conciliación bancaria.**
Cron diario por usuario (sync incremental → conciliar) para que el dashboard esté
siempre al día sin intervención. Sumar la 4ª pata: importación de movimientos
bancarios y cruce contra liberaciones.

---

## 7. Modelo de negocio (hipótesis)

- **SaaS por suscripción** mensual, escalonado por volumen de transacciones y/o
  número de canales conectados.
- **Anclaje de valor**: el costo de la suscripción vs. las horas de contador/dueño
  ahorradas + el riesgo tributario evitado + la plata trabada que se logra reclamar.
- **Expansión natural**: empieza con cumplimiento (pata 1, lo que el contador exige),
  crece a finanzas (patas 2-3, lo que el dueño ama), y a más canales.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Dependencia de APIs de terceros (ML, Bsale, MercadoPago) que cambian | Capa de conectores normalizada; cada API aislada en su propio módulo |
| Falsos cruces al sumar canales | Matching por referencia explícita por canal antes del score difuso |
| "Falso verde" en pagos por usar fuente sintética | Usar la fuente real de liberaciones; no construir dashboard sobre data fabricada |
| Limitaciones del runtime backend (timeouts, sin reintentos) | Sync por checkpoint/paginación; evaluar n8n para los conectores ETL a futuro |
| Escala de volumen (miles de movimientos/mes) | Sync incremental con watermark + paginación robusta en todas las queries |

---

## 9. En una frase

**LedgerSync convierte el cruce manual de planillas entre ventas, documentos
tributarios y pagos en una conciliación automática y multicanal — para que el
vendedor sepa que facturó bien, que le pagaron bien, y dónde está su plata.**
