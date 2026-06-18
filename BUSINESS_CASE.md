# Business Case — LedgerSync

> Conciliación automática para vendedores de marketplaces en Chile.
> **Venta → Documento (SII) → Pago (MercadoPago) → Depósito (banco).**
> Actualizado: 2026-06-18.

---

## 1. Origen de la idea — qué era, qué cambió

### 1.1 La idea original

El proyecto partió de un caso de negocio armado por mi hermano (con ChatGPT) sobre
"Plataforma de Conciliación de Ventas para Marketplaces en LATAM":

- **Problema planteado**: empresas vendiendo en múltiples marketplaces (MELI,
  Falabella, Paris, Amazon, Linio) no logran conciliar ventas netas vs. pagos,
  descuentos/devoluciones/comisiones, ni la facturación electrónica, por la
  diversidad de ERPs y reglas tributarias locales.
- **Solución propuesta**: SaaS que integra ventas de marketplaces, concilia contra
  pagos, genera/valida facturación electrónica, exporta a ERP (Softland, Nubox,
  Defontana, SAP) y entrega KPIs a contadores/CFOs.
- **Benchmark usado**: ChannelEngine, Taxdoo, A2X, Link My Books, Sellerboard.
- **Modelo de negocio propuesto**: SaaS mensual por tier (marketplaces + volumen),
  integraciones custom, API abierta, freemium.
- **Roadmap a 12 meses**: México + Chile desde el día uno, 5 marketplaces y 3 ERPs
  integrados, MVP en 6 meses, beta con contadores.
- **Proyección**: 500 empresas el año 1, US$300k de ingresos, break-even mes 18.

### 1.2 Qué de eso envejeció mal (y por qué)

| Supuesto original | Por qué no sobrevivió |
|---|---|
| 5 marketplaces + 3 ERPs + 2 países desde el arranque | Delirante para pre-validación. Ningún conector de Falabella/Amazon/Shopify ni de un ERP que no sea Bsale existe hoy — y está bien que no exista todavía. |
| Benchmarks: Taxdoo (compliance IVA EU) y ChannelEngine (integrador de listings) | Ninguno de los dos *concilia* nada. Los comparables reales son **A2X, Link My Books, Synder, Webgility, Bookkeep** — todos resumen a nivel banco↔liquidación. |
| "Reportes para contadores/CFOs" como feature decorativa | El contador no es un destinatario de reporte: es el **canal de distribución de mayor ARPU** (~4x el del vendedor directo) y quien define la red de adopción. Esa es hoy la decisión estratégica #1, y el doc original no la vio. |
| Secuencia de adquisición implícita: vender directo al contador | El vendedor tiene que ser el punto de entrada porque es quien posee las credenciales de API (MELI, Bsale). El contador se suma después, no puede iniciar el onboarding solo. |
| Diferenciador "conciliación automática" genérico | La cuña real es **matching a nivel orden contra el documento tributario (DTE), legalmente exigido y auditable por el SII** — algo que ninguno de los comparables hace, y que el doc original nunca mencionó. |
| 500 empresas / US$300k / break-even mes 18 | Números de slide para levantar capital, no de validación. El modelo real (abajo, §6) tiene break-even de infraestructura en ~2 clientes y viabilidad de negocio real en ~12-15 vendedores o ~17 contadores. |

### 1.3 Qué se mantiene

El problema central — conciliar ventas netas vs. pagos efectivos con comisiones,
devoluciones y documentos tributarios de por medio — sigue siendo real y doloroso.
El foco regulatorio local (Chile/SII) como ventaja competitiva también aguantó.

**En una frase: el narrowing de scope (1 canal, 1 país, 1 design partner) fue la
corrección más sana. El pivote de tesis (contador como canal, vendedor como
entrada, DTE como cuña) es el aprendizaje más valioso, y no estaba en el doc
original.**

---

## 2. El problema

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

## 3. La solución

LedgerSync se conecta a las APIs de cada sistema, **normaliza** todo a un modelo
común y **concilia automáticamente** las cuatro patas de la cadena de dinero:

| Pata | Pregunta que responde | Estado |
|---|---|---|
| 1. Venta ↔ Documento (SII) | ¿Emití la boleta/factura correcta? | ✅ Funcionando |
| 2. Venta ↔ Liberación (MercadoPago) | ¿Me pagaron bien y cuándo? | 🟡 Código corregido, falta deploy + backfill |
| 3. Liberación ↔ Depósito (banco) | ¿Llegó la plata a mi cuenta? | ⏸️ Deliberadamente en pausa (foco MELI primero) |
| (Transversal) Auditoría de comisión | ¿El fee cobrado es el correcto? | 📋 Roadmap |

El motor de conciliación es **100% determinístico** (identificadores explícitos,
RUT, montos, fechas, agrupación por `pack`), con scoring para los casos límite. No
depende de IA para los matches base.

### La ventaja arquitectónica clave: Bsale ya unifica los canales

El sistema de facturación (Bsale) **ya emite los documentos de todos los canales**
del vendedor (en nuestra data: Shopify, Falabella, Paris, Ripley y MELI conviven en
la misma cuenta Bsale). El lado "documento" de la conciliación es **multicanal
desde el día uno**. Sumar un marketplace nuevo no requiere un nuevo sistema de
documentos — solo un **conector de órdenes**.

---

## 4. Mercado y cliente

- **Punto de entrada obligatorio: el vendedor.** Es quien posee las credenciales de
  API (MELI, Bsale) — sin él no hay onboarding posible, sea quien sea quien termine
  pagando.
- **Canal de distribución de mayor valor: el contador.** ARPU ~4x el del vendedor
  directo (ver pricing, §6), y gestiona varios clientes a la vez → un solo contador
  vendido puede traer 3-10 cuentas. Esto es hoy **hipótesis sin validar**: cero
  contadores reales han visto la herramienta.
- **Disparador de compra**: el dolor crece con el volumen y con cada canal nuevo. El
  punto de quiebre es cuando la planilla manual deja de ser viable — hoy validado
  con un solo design partner (vendedor).

---

## 5. Propuesta de valor

1. **Cumplimiento tributario sin esfuerzo** — cada venta cruzada con su documento;
   las inconsistencias saltan solas antes del F29.
2. **Visibilidad de caja** — "esto me deben, esto está atrasado, esto ya llegó al
   banco". Saca al vendedor de la ceguera.
3. **Auditoría de comisiones** — detecta cuando el marketplace cobró de más.
4. **Escala con el negocio** — multicanal por diseño; agregar un canal es agregar un
   conector, no rehacer el sistema.
5. **Automático y diario** (fase futura) — sin apretar botones.

---

## 6. Modelo de negocio y pricing

### 6.1 Estructura propuesta (José)

No es SaaS plano por usuario: es **plan base + cargo por integración + variable por
volumen de órdenes**, lo que tiene sentido porque el costo real (llamadas a APIs,
storage, compute) escala con integraciones y volumen, no con "asientos".

| Concepto | Costo |
|---|---|
| **Plan base** (incluye 1ª integración: Bsale o cualquier ERP) | 1,0 UF/mes |
| Integración adicional (otro ERP o cuenta) | +0,5 UF/mes c/u |
| Tramo 0 – 1.000 órdenes/mes | incluido en la base |
| Tramo 1.000 – 2.000 | +1,0 UF |
| Tramo 2.000 – 3.000 | +1,9 UF |
| Tramo 3.000 – 4.000 | +2,8 UF |
| Tramo 4.000 – 5.000 | +3,7 UF |
| Tramo 5.000 – 6.000 | +4,6 UF |
| Tramo 6.000 – 7.000 | +5,5 UF |

*(1 UF ≈ $39.000 CLP / ~US$41 — valor referencial, cotizar el día de cobro real.)*

### 6.2 Ejemplos concretos

- **Vendedor directo, 1 integración, 600 órdenes/mes** (caso del design partner
  actual): 1 UF/mes ≈ **$39.000 CLP (~US$41/mes)**. Calza con el ARPU "vendedor
  ~25-30k" estimado antes — el plan base lo cubre sin tramos extra.
- **Contador con 3 clientes, cada uno con su propia integración Bsale, volumen
  conjunto bajo (<1.000/cliente)**: 1 UF base + 0,5 UF × 2 integraciones
  adicionales = 2,0 UF/mes ≈ **$78.000 CLP (~US$82/mes)**. Cerca del ARPU
  "contador ~100k" citado antes si se suma un 4º cliente o algo de volumen.
- **Contador con 5 integraciones, volumen conjunto 3.200 órdenes/mes**: 1 UF base +
  0,5 UF × 4 + 2,8 UF (tramo 3.000-4.000) = **5,8 UF/mes ≈ $226.000 CLP
  (~US$237/mes)**.

La estructura es internamente consistente con los ARPU que ya se habían estimado
a ojo — buena señal de que el pricing no está inventado al aire.

### 6.3 Punto que hay que aclarar con José antes de cobrar

El texto es ambiguo en un punto importante: **¿el plan base de 1 UF se cobra una
vez por cuenta-contador, o una vez por cada cliente final que administra?** Si un
contador gestiona 5 clientes, ¿paga 1 plan base + 4×0,5 UF integración (interpretación
usada arriba), o 5 planes base completos? La diferencia es ~5x en el ticket. Definir
esto antes de cotizar a cualquier contador real.

---

## 7. Estado del producto (hoy)

**Funcionando y validado:**
- Sync de órdenes MercadoLibre (paginado, resistente a timeouts).
- Sync de documentos Bsale multicanal (paginado por código SII, con checkpoint).
- Enriquecimiento de RUT vía API de ML.
- Motor de conciliación Venta↔Documento: matches exactos, por `pack`, consolidados
  y por score, con bandeja de excepciones y respaldo antes de cualquier reset.
- Trigger en BD que evita que dos órdenes queden linkeadas al mismo documento por
  una carrera entre el matcher automático y un reset manual.
- Exportación de data cruda (RAW) para auditoría externa.

**Recién corregido, pendiente de deploy:**
- `sync-meli-payment-details` (pata 2/pago real de MercadoPago) tenía un bug que
  perdía silenciosamente el 2º+ pago de cualquier orden con más de un pago
  (cuotas, pago parcial + reembolso). Ya corregido en la rama; falta que Lovable
  despliegue la función para que el dato de "plata recibida" sea confiable.

**Explícitamente fuera de foco por ahora:**
- Conciliación bancaria (Fintoc / pata 4) — la tabla y el import CSV ya existen
  desde oct-2025, pero no se está construyendo la integración activa todavía.
- Multicanal (Shopify/Falabella/Paris/Ripley) — el diseño lo soporta (Bsale ya es
  multicanal en los documentos), pero no hay un solo conector de órdenes construido
  más allá de MELI.
- IVA exacto — hoy no hay ninguna pantalla con ruta que muestre ese KPI; solo vive
  en una página huérfana sin ruta (`SellerDashboard`), pendiente de rescate.

---

## 8. Stack técnico actual

- **Backend**: Supabase (Postgres + Edge Functions en Deno), hospedado en
  **Lovable Cloud**. El deploy de las Edge Functions es **100% manual vía la UI de
  Lovable** — no hay token/CLI/CI desde este entorno. Es el cuello de botella
  operativo más concreto hoy: cualquier cambio de backend queda esperando que
  alguien lo despliegue a mano.
- **Frontend**: React + TypeScript, Vite.
- **Integraciones reales hoy**: MercadoLibre (OAuth + API de órdenes/facturación),
  Bsale (documentos tributarios, OAuth + webhook), MercadoPago (detalle de pago vía
  `sync-meli-payment-details`).
- **No construido aún**: ningún otro ERP (Nubox, Defontana, Softland, SAP),
  ningún otro marketplace (Falabella, Shopify, Amazon, Paris, Ripley), Fintoc/banco,
  multi-tenant con billing/planes, API pública.
- **Seguridad/datos**: RLS por usuario en todas las tablas, encadenado a través de
  `channel_account_id` → tabla de cuentas por canal (`meli_accounts`, etc.). El
  esquema ya está preparado para multi-canal/multi-tenant a nivel de datos, aunque
  hoy solo hay un canal y un cliente real usándolo.

---

## 9. Gaps — qué falta y cómo se resuelve

| Gap | Tipo | Cómo se resuelve |
|---|---|---|
| Deploy 100% manual (Lovable) | Operativo, confirmado | No hay automatización posible desde este entorno. Mitigación: agrupar cambios de backend para minimizar rondas de "pedir deploy", y usar este caso (deploy de `sync-meli-payment-details` + `sync-bsale-docs`) como prueba de que el flujo "push → pedir deploy" funciona de punta a punta. |
| Pricing promete "Bsale o **cualquier ERP**", el código solo integra Bsale | Comercial vs. técnico | No vender "cualquier ERP" hasta tener al menos un 2º conector (Nubox es el candidato lógico, muy usado por contadores chilenos). Mientras tanto, ser explícito con cualquier prospecto: "hoy Bsale, otros ERP a pedido". |
| Canal contador sin validar (0 contadores reales lo han visto) | Negocio, el más caro de dejar sin probar | Conseguir 1-2 contadores reales esta semana/mes y preguntar directamente si pagarían y cuánto — antes de construir nada nuevo. |
| Ambigüedad en el pricing (plan base ¿por cuenta o por cliente final?) | Comercial | Aclarar con José antes de cotizar a cualquier contador real (ver §6.3). |
| Sin multi-tenant/billing real | Técnico | No construir todavía — recién se justifica cuando exista un 2º cliente pagando dispuesto a onboardearse sin tu intervención manual. |
| Pata de pagos (MercadoPago) recién corregida, sin deploy ni backfill | Técnico, bloqueante de la pata 2 | Pedir el deploy a Lovable y correr el backfill vía el botón "Sync pagos" de `/pipeline`. Ya no depende de más código. |
| Volumen alto (tramos 5.000-7.000 órdenes/mes del pricing) nunca probado en producción | Técnico/riesgo de pricing | El cliente real actual mueve ~900-1.200 órdenes/mes — los tramos altos del pricing son, por ahora, teóricos. No vender ese tramo con confianza hasta probar el motor a esa escala (paginación, timeouts de Edge Functions). |
| IVA exacto solo vive en página huérfana sin ruta | Técnico, baja prioridad | Se resuelve junto con el rescate de `SellerDashboard` (ver BACKLOG.md), no antes. |
| Conciliación bancaria (Fintoc) sin construir | Producto, deliberadamente diferido | Esperar instrucción explícita — ya se evaluó y se decidió no avanzar hasta cerrar la pata de pagos de MELI. |

---

## 10. Roadmap por fases (de validación, no de calendario)

**Fase 0 — Cerrar el loop con el cliente actual (en curso).**
Deploy de `sync-meli-payment-details` (bug de multi-pago ya corregido) +
`sync-bsale-docs`, backfill de pagos reales. Objetivo: que el dueño confíe el
cierre contable mensual a esto, no solo lo mire.

**Fase 1 — Validar el canal contador.**
Conseguir 1-2 contadores reales mirando la herramienta. Preguntar si pagarían y
cuánto, frente al pricing de §6. Es research/ventas, no código. Resultado define
si el negocio prioritario es vender al contador o seguir vendiendo directo al
vendedor (con ARPU ~4x menor).

**Fase 2 — Según resultado de Fase 1:**
- *Si el contador valida*: construir lo mínimo para vender a un 2º cliente
  (onboarding sin intervención manual, billing real, aclarar pricing por
  cuenta/cliente). Candidato a 2º conector ERP: Nubox.
- *Si no valida*: seguir vendiendo directo a vendedores, sabiendo el ARPU real.

**Fase 3 — Multicanal (solo con 2+ clientes pagando).**
Sumar un 2º marketplace (Shopify primero, por volumen visto en la data real) — solo
si el dolor de conciliación se repite igual en ese canal. Endurecer el matching por
referencia explícita por canal para evitar falsos cruces.

**Fase 4 — Automatización diaria + conciliación bancaria + más ERPs.**
Cron diario, 4ª pata (banco/Fintoc), más conectores ERP — con demanda real
pidiéndolo, no especulativo.

---

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Validación con un solo cliente — no se sabe si el dolor generaliza | Conseguir señal de un 2º cliente o de contadores antes de invertir en escalar |
| Canal contador 100% hipótesis | Validar con 1-2 contadores reales antes de construir multi-tenant/billing |
| Dependencia de APIs de terceros (ML, Bsale, MercadoPago) que cambian | Capa de conectores normalizada; cada API aislada en su propio módulo |
| Falsos cruces al sumar canales | Matching por referencia explícita por canal antes del score difuso |
| "Falso verde" en pagos por usar fuente sintética | Ya resuelto: se usa la fuente real (`sync-meli-payment-details`), no la sintética (`sync-meli-settlements`, a jubilar) |
| Deploy 100% manual (Lovable) | Agrupar cambios de backend, usar esta ronda como prueba del flujo completo |
| Pricing ofrece "cualquier ERP" sin tenerlo construido | No vender esa promesa hasta tener un 2º conector real |
| Volumen alto del pricing nunca probado en producción | No vender tramos altos con confianza hasta un stress test real |

---

## 12. En una frase

**LedgerSync convierte el cruce manual de planillas entre ventas, documentos
tributarios y pagos en una conciliación automática y auditable ante el SII — hoy
validada con un vendedor en MercadoLibre + Bsale, con el contador como la apuesta
de distribución de mayor valor todavía sin probar.**
