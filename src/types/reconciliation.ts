export type Canal = { id: string; nombre: string; ordenes: number };
export type Respaldo = { pct: number; faltan: number };

export interface PeriodReconciliation {
  periodo: string;           // "2026-06"
  canalId: string;           // "todos" | id de canal
  canales: Canal[];          // para el selector global

  ingresos: {
    ventasBrutas: number;
    porCanal: { canalId: string; nombre: string; ordenes: number; monto: number }[];
    conDte: Respaldo;        // % ventas con DTE emitido (match direccional MeLi→Bsale)
  };

  egresos: {
    comisionMarketplace: { monto: number; conFactura: Respaldo };
    costosEnvio:         { monto: number };
    comisionPago:        { monto: number };
    reembolsos:          { monto: number; conNotaCredito: { con: number; total: number } };
  };

  liquidoRecibido: number;   // ventasBrutas − suma(egresos)
  abonosBanco: number;       // suma de bank_movements del período
  diferencia: number;        // liquidoRecibido − abonosBanco (objetivo: 0)

  // Cobertura de datos EXACTOS (traídos del payment provider, no aproximados).
  // pct alto = la mayoría de los montos arriba son reales, no estimaciones.
  datosExactos: { ordenes: number; total: number; pct: number };

  excepciones: {
    tipo: 'venta_sin_dte' | 'pago_atascado' | 'devolucion_sin_nc' | 'score_bajo';
    label: string;
    count: number;
    severidad: 'warning' | 'danger';
  }[];

  cierre: {
    estado: 'abierto' | 'cerrado';
    bloqueadores: number;    // excepciones danger con count > 0
    puedeCerrar: boolean;    // bloqueadores === 0
  };
}
