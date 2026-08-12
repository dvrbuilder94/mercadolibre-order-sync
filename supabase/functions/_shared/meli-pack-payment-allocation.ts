export type PackOrder = {
  id: string;
  orderId: string;
  gross: number;
  paymentIds: string[];
};

export type PackPayment = {
  id: string;
  gross: number;
  net: number;
  fees: number;
};

export type PaymentAllocation = {
  paymentId: string;
  orderId: string;
  grossAllocated: number;
  netAllocated: number;
  feesAllocated: number;
  reason: 'payment_id' | 'exact_amount' | 'single_global_payment';
};

export type AllocationResult = {
  allocations: PaymentAllocation[];
  unresolvedPaymentIds: string[];
};

const cents = (value: number) => Math.round((Number(value) || 0) * 100);
const money = (valueInCents: number) => valueInCents / 100;

function splitProportionally(
  payment: PackPayment,
  orders: PackOrder[],
): PaymentAllocation[] {
  const grossCents = orders.map((order) => Math.max(0, cents(order.gross)));
  const totalGross = grossCents.reduce((sum, value) => sum + value, 0);
  if (orders.length === 0 || totalGross <= 0) return [];

  const split = (total: number) => {
    const totalCents = cents(total);
    let allocated = 0;
    return orders.map((_, index) => {
      if (index === orders.length - 1) return totalCents - allocated;
      const part = Math.round((totalCents * grossCents[index]) / totalGross);
      allocated += part;
      return part;
    });
  };

  const grossParts = split(payment.gross);
  const netParts = split(payment.net);
  const feeParts = split(payment.fees);

  return orders.map((order, index) => ({
    paymentId: payment.id,
    orderId: order.id,
    grossAllocated: money(grossParts[index]),
    netAllocated: money(netParts[index]),
    feesAllocated: money(feeParts[index]),
    reason: 'single_global_payment' as const,
  }));
}

/**
 * Allocate Mercado Pago payments inside a MELI pack without assuming that
 * `same pack_id` means `every payment belongs to every order`.
 *
 * Priority:
 * 1. Explicit payment_id ownership from each order snapshot.
 * 2. Unique exact gross-amount match among still-unmatched orders.
 * 3. Proportional allocation only when exactly one unresolved payment remains
 *    and its gross equals the combined gross of the unresolved orders.
 * 4. Otherwise keep the payment unresolved rather than fabricating a match.
 */
export function allocatePackPayments(
  orders: PackOrder[],
  payments: PackPayment[],
): AllocationResult {
  const allocations: PaymentAllocation[] = [];
  const assignedOrders = new Set<string>();
  const assignedPayments = new Set<string>();

  for (const payment of payments) {
    const owners = orders.filter((order) => order.paymentIds.includes(payment.id));
    if (owners.length !== 1) continue;

    const owner = owners[0];
    allocations.push({
      paymentId: payment.id,
      orderId: owner.id,
      grossAllocated: payment.gross,
      netAllocated: payment.net,
      feesAllocated: payment.fees,
      reason: 'payment_id',
    });
    assignedPayments.add(payment.id);
    assignedOrders.add(owner.id);
  }

  for (const payment of payments) {
    if (assignedPayments.has(payment.id)) continue;

    const candidates = orders.filter(
      (order) => !assignedOrders.has(order.id) && cents(order.gross) === cents(payment.gross),
    );
    if (candidates.length !== 1) continue;

    const owner = candidates[0];
    allocations.push({
      paymentId: payment.id,
      orderId: owner.id,
      grossAllocated: payment.gross,
      netAllocated: payment.net,
      feesAllocated: payment.fees,
      reason: 'exact_amount',
    });
    assignedPayments.add(payment.id);
    assignedOrders.add(owner.id);
  }

  const unresolvedPayments = payments.filter((payment) => !assignedPayments.has(payment.id));
  const unresolvedOrders = orders.filter((order) => !assignedOrders.has(order.id));

  if (unresolvedPayments.length === 1 && unresolvedOrders.length > 1) {
    const [payment] = unresolvedPayments;
    const unresolvedGross = unresolvedOrders.reduce((sum, order) => sum + cents(order.gross), 0);
    if (cents(payment.gross) === unresolvedGross) {
      allocations.push(...splitProportionally(payment, unresolvedOrders));
      assignedPayments.add(payment.id);
    }
  }

  return {
    allocations,
    unresolvedPaymentIds: payments
      .filter((payment) => !assignedPayments.has(payment.id))
      .map((payment) => payment.id),
  };
}
