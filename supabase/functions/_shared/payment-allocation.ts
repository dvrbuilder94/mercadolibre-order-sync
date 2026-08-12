// Motor de atribución Pago → Orden.
//
// Reglas (en orden estricto de prioridad):
//   1. payment_id explícito — la orden declara el pago en su snapshot
//      (raw_data.payments) o en meli_payment_details. Evidencia más fuerte.
//   2. monto exacto único — una sola orden sin asignar cuyo bruto coincide.
//   3. pago global único — 1 pago sin resolver, N órdenes sin asignar y
//      bruto del pago == suma exacta de los brutos. Solo ahí se prorratea.
//   4. ambigüedad — sin evidencia suficiente el pago queda SIN ASIGNAR.
//
// pack_id sirve para ARMAR el grupo de órdenes candidatas, nunca para
// determinar ownership del pago.

export interface AllocationOrder {
  /** UUID interno de la orden (orders.id). */
  id: string;
  /** Bruto comercial de la orden. */
  gross: number;
  /** payment_ids que la propia orden declara (evidencia explícita). */
  explicitPaymentIds?: string[];
}

export interface AllocationPayment {
  /** payment_id externo de Mercado Pago. */
  id: string;
  /** transaction_amount. */
  gross: number;
  /** net_received_amount. */
  net: number;
  /** Comisiones/fees totales del pago. */
  fees?: number;
}

export interface Allocation {
  paymentId: string;
  orderId: string;
  /** Bruto atribuido a esta orden por este pago. */
  allocatedGross: number;
  /** Neto atribuido (lo que se persiste en payment_sales.allocated_amount). */
  allocatedNet: number;
  /** Comisión atribuida. */
  allocatedFees: number;
  rule: "explicit_payment_id" | "unique_exact_amount" | "single_global_payment";
}

export interface UnresolvedPayment {
  paymentId: string;
  reason:
    | "ambiguous_amount"
    | "ambiguous_explicit_owners"
    | "no_candidate_order";
}

export interface AllocationResult {
  allocations: Allocation[];
  unresolved: UnresolvedPayment[];
}

/** Tolerancia de redondeo: 1 peso o 0,5%, lo que sea mayor. */
export const amountTolerance = (reference: number) =>
  Math.max(Math.abs(reference) * 0.005, 1);

const sameAmount = (a: number, b: number) =>
  Math.abs(a - b) <= amountTolerance(Math.max(Math.abs(a), Math.abs(b)));

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reparte un total entre órdenes proporcionalmente al bruto, dejando el
 * residuo de redondeo en la última orden para que la suma cuadre exacto.
 */
function prorate(total: number, orders: AllocationOrder[]): number[] {
  const grossTotal = orders.reduce((s, o) => s + o.gross, 0);
  const parts = orders.map((o) =>
    round2(grossTotal > 0 ? (total * o.gross) / grossTotal : total / orders.length),
  );
  const drift = round2(total - parts.reduce((s, p) => s + p, 0));
  if (parts.length > 0) parts[parts.length - 1] = round2(parts[parts.length - 1] + drift);
  return parts;
}

function buildAllocations(
  payment: AllocationPayment,
  orders: AllocationOrder[],
  rule: Allocation["rule"],
): Allocation[] {
  const nets = prorate(payment.net, orders);
  const grosses = prorate(payment.gross, orders);
  const feesTotal = payment.fees ?? round2(payment.gross - payment.net);
  const fees = prorate(feesTotal, orders);
  return orders.map((o, i) => ({
    paymentId: payment.id,
    orderId: o.id,
    allocatedGross: grosses[i],
    allocatedNet: nets[i],
    allocatedFees: fees[i],
    rule,
  }));
}

/**
 * Resuelve a qué orden pertenece realmente cada pago dentro de un grupo
 * (típicamente las órdenes de un pack). Nunca inventa una atribución:
 * ante evidencia insuficiente devuelve el pago como no resuelto.
 */
export function resolvePaymentAllocations(
  payments: AllocationPayment[],
  orders: AllocationOrder[],
): AllocationResult {
  const allocations: Allocation[] = [];
  const unresolved: UnresolvedPayment[] = [];
  const assignedOrderIds = new Set<string>();
  const pending: AllocationPayment[] = [];

  const groupGross = orders.reduce((s, o) => s + o.gross, 0);

  // --- Regla 1: payment_id explícito ---
  for (const payment of payments) {
    const owners = orders.filter((o) =>
      (o.explicitPaymentIds ?? []).some((id) => String(id) === String(payment.id)),
    );

    if (owners.length === 0) {
      pending.push(payment);
      continue;
    }

    if (owners.length === 1) {
      // Un pago que cubre exactamente el pack completo es el pago global del
      // pack aunque Mercado Pago lo haya colgado del snapshot de una sola
      // orden. Cualquier otro desajuste se atribuye 1:1 al dueño explícito.
      if (orders.length > 1 && sameAmount(payment.gross, groupGross)) {
        allocations.push(...buildAllocations(payment, orders, "single_global_payment"));
        orders.forEach((o) => assignedOrderIds.add(o.id));
      } else {
        allocations.push(...buildAllocations(payment, owners, "explicit_payment_id"));
        assignedOrderIds.add(owners[0].id);
      }
      continue;
    }

    // Varias órdenes declaran el mismo payment_id: sólo es legítimo si el
    // bruto del pago cubre exactamente la suma de esas órdenes.
    if (sameAmount(payment.gross, owners.reduce((s, o) => s + o.gross, 0))) {
      allocations.push(...buildAllocations(payment, owners, "explicit_payment_id"));
      owners.forEach((o) => assignedOrderIds.add(o.id));
    } else {
      unresolved.push({ paymentId: payment.id, reason: "ambiguous_explicit_owners" });
    }
  }

  // --- Regla 2: monto exacto único ---
  const stillPending: AllocationPayment[] = [];
  for (const payment of pending) {
    const candidates = orders.filter(
      (o) => !assignedOrderIds.has(o.id) && sameAmount(o.gross, payment.gross),
    );
    if (candidates.length === 1) {
      allocations.push(...buildAllocations(payment, candidates, "unique_exact_amount"));
      assignedOrderIds.add(candidates[0].id);
    } else {
      stillPending.push(payment);
    }
  }

  // --- Regla 3: pago global único ---
  const freeOrders = orders.filter((o) => !assignedOrderIds.has(o.id));
  if (stillPending.length === 1 && freeOrders.length > 1) {
    const payment = stillPending[0];
    const freeGross = freeOrders.reduce((s, o) => s + o.gross, 0);
    if (sameAmount(payment.gross, freeGross)) {
      allocations.push(...buildAllocations(payment, freeOrders, "single_global_payment"));
      freeOrders.forEach((o) => assignedOrderIds.add(o.id));
      return { allocations, unresolved };
    }
  }

  // --- Regla 4: ambigüedad → sin asignar ---
  for (const payment of stillPending) {
    const sameAmountOrders = orders.filter((o) => sameAmount(o.gross, payment.gross));
    unresolved.push({
      paymentId: payment.id,
      reason: sameAmountOrders.length > 1 ? "ambiguous_amount" : "no_candidate_order",
    });
  }

  return { allocations, unresolved };
}

/**
 * Invariante de bruto: un pago repartido entre VARIAS órdenes debe cubrir
 * exactamente la suma de sus brutos. Un pago atribuido a una sola orden puede
 * ser parcial (pagos en cuotas o divididos), así que no se le exige igualdad.
 */
export function validateAllocationInvariants(
  payment: AllocationPayment,
  allocations: Allocation[],
): { ok: true } | { ok: false; error: string } {
  const mine = allocations.filter((a) => a.paymentId === payment.id);
  if (mine.length === 0) return { ok: true };

  const allocatedGross = mine.reduce((s, a) => s + a.allocatedGross, 0);
  if (!sameAmount(allocatedGross, payment.gross)) {
    return {
      ok: false,
      error: `payment ${payment.id}: bruto atribuido ${allocatedGross} != bruto del pago ${payment.gross}`,
    };
  }

  const allocatedNet = mine.reduce((s, a) => s + a.allocatedNet, 0);
  if (!sameAmount(allocatedNet, payment.net)) {
    return {
      ok: false,
      error: `payment ${payment.id}: neto atribuido ${allocatedNet} != neto del pago ${payment.net}`,
    };
  }

  const ids = new Set(mine.map((a) => a.orderId));
  if (ids.size !== mine.length) {
    return { ok: false, error: `payment ${payment.id}: órdenes duplicadas en la atribución` };
  }

  return { ok: true };
}

/**
 * Invariante de ownership: si el pago quedó repartido entre varias órdenes, el
 * bruto del pago debe igualar la suma de los brutos COMERCIALES de esas
 * órdenes. Es la validación que impide que un pago de $29.990 termine colgado
 * de tres órdenes que suman $89.970.
 */
export function validateGrossOwnership(
  payment: AllocationPayment,
  allocations: Allocation[],
  orders: AllocationOrder[],
): { ok: true } | { ok: false; error: string } {
  const mine = allocations.filter((a) => a.paymentId === payment.id);
  if (mine.length <= 1) return { ok: true };

  const byId = new Map(orders.map((o) => [o.id, o]));
  const ordersGross = mine.reduce((s, a) => s + (byId.get(a.orderId)?.gross ?? 0), 0);
  if (!sameAmount(ordersGross, payment.gross)) {
    return {
      ok: false,
      error: `payment ${payment.id}: bruto del pago ${payment.gross} != suma de brutos de las ${mine.length} órdenes (${ordersGross})`,
    };
  }
  return { ok: true };
}