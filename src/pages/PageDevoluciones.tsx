import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronLeft, ChevronRight, RefreshCw, Loader2, ChevronDown, ChevronUp, Undo2,
} from "lucide-react";
import { CHANNEL_LABEL, CHANNEL_COLOR } from "@/lib/constants";

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};
const periodRange = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return {
    from: format(new Date(y, m - 1, 1), "yyyy-MM-dd"),
    to:   format(new Date(y, m, 0),     "yyyy-MM-dd"),
  };
};
const clp = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 })
    .format(n || 0);

const PAGE_SIZE = 50;

type StatusFilter = "all" | "opened" | "closed" | "missing_nc";

// type_id que devuelve la API de Post-Purchase de MELI. No están todos
// documentados con certeza — si aparece uno no mapeado, se muestra el valor
// crudo en vez de adivinar una traducción.
const TYPE_LABEL: Record<string, string> = {
  mediations: "Mediación", returns: "Devolución", cancel_purchase: "Cancelación",
  fulfillment: "Fulfillment", warranty: "Garantía", order_problem: "Problema con la orden",
};
const STATUS_LABEL: Record<string, string> = {
  opened: "Abierto", closed: "Cerrado", in_process: "En proceso",
};

interface ClaimOrder {
  id: string; order_id: string; channel: string | null; product_title: string | null;
  customer_name: string | null; gross_amount: number | null;
}
interface ClaimRow {
  id: string;
  claim_id: string;
  resource_id: string | null;
  order_id: string | null;
  type: string | null;
  stage: string | null;
  status: string | null;
  reason_id: string | null;
  date_created: string | null;
  last_updated: string | null;
  raw_data: Record<string, any> | null;
  orders: ClaimOrder | null;
}
// Movimientos negativos reales creados desde transaction_amount_refunded o
// un contracargo de Mercado Pago. Se agregan por venta para no duplicar montos
// cuando una misma orden tiene más de un reclamo.
interface RefundMovement {
  status: string;
  amount: number;
  paymentId: string | null;
  paymentDate: string | null;
}
interface CreditNoteState {
  hasOriginalDocument: boolean;
  hasCreditNote: boolean;
  creditNoteNumber: string | null;
}

export default function PageDevoluciones() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [refunds, setRefunds] = useState<Map<string, RefundMovement>>(new Map());
  const [creditNotes, setCreditNotes] = useState<Map<string, CreditNoteState>>(new Map());
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, []);

  const range = useMemo(() => periodRange(period), [period]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = range;
      const { data, error } = await supabase
        .from("meli_claims")
        .select(`
          id, claim_id, resource_id, order_id, type, stage, status, reason_id,
          date_created, last_updated, raw_data,
          orders ( id, order_id, channel, product_title, customer_name, gross_amount )
        `)
        .gte("date_created", from + "T00:00:00")
        .lte("date_created", to + "T23:59:59")
        .order("date_created", { ascending: false });
      if (error) throw error;
      const claims = (data || []) as unknown as ClaimRow[];

      // Cash truth is independent from Claims/Post-Purchase permissions. Read the
      // negative ledger movements by refund date and attach their sale directly.
      const { data: refundLinks, error: refundError } = await supabase
        .from("payment_sales")
        .select(`
          sale_id,
          orders ( id, order_id, channel, product_title, customer_name, gross_amount ),
          payments!inner (
            external_payment_id, payment_date, net_amount, status, raw_data
          )
        `)
        .in("payments.status", ["REFUND", "CHARGEBACK"])
        .gte("payments.payment_date", from + "T00:00:00")
        .lte("payments.payment_date", to + "T23:59:59");
      if (refundError) throw refundError;

      const refundMap = new Map<string, RefundMovement>();
      const refundOrders = new Map<string, ClaimOrder>();
      for (const link of (refundLinks || []) as any[]) {
        const payment = Array.isArray(link.payments) ? link.payments[0] : link.payments;
        const order = Array.isArray(link.orders) ? link.orders[0] : link.orders;
        if (!payment) continue;
        const previous = refundMap.get(link.sale_id);
        const amount = Math.abs(Number(payment.net_amount ?? 0));
        refundMap.set(link.sale_id, {
          status: payment.status === "CHARGEBACK" || previous?.status === "CHARGEBACK"
            ? "CHARGEBACK"
            : "REFUND",
          amount: (previous?.amount ?? 0) + amount,
          paymentId: payment.external_payment_id ?? previous?.paymentId ?? null,
          paymentDate: [previous?.paymentDate, payment.payment_date]
            .filter(Boolean)
            .sort()
            .pop() ?? null,
        });
        if (order) refundOrders.set(link.sale_id, order as ClaimOrder);
      }
      setRefunds(refundMap);

      // A refund must remain visible even when MELI does not grant access to the
      // Claims API. Add one synthetic case per refunded sale not already returned
      // by Post-Purchase, clearly identified as a Mercado Pago cash event.
      const claimedOrderIds = new Set(
        claims.map((claim) => claim.order_id).filter(Boolean) as string[],
      );
      const cashOnlyRows: ClaimRow[] = Array.from(refundMap.entries())
        .filter(([saleId]) => !claimedOrderIds.has(saleId))
        .map(([saleId, refund]) => ({
          id: `mp-refund-${saleId}`,
          claim_id: refund.paymentId ?? `MP-${saleId}`,
          resource_id: null,
          order_id: saleId,
          type: "returns",
          stage: "mercadopago",
          status: "closed",
          reason_id: null,
          date_created: refund.paymentDate,
          last_updated: refund.paymentDate,
          raw_data: { source: "mercadopago_refund", cash_status: refund.status },
          orders: refundOrders.get(saleId) ?? null,
        }));
      const combinedRows = [...claims, ...cashOnlyRows].sort((a, b) =>
        (b.date_created ?? "").localeCompare(a.date_created ?? ""),
      );
      setRows(combinedRows);

      const orderIds = Array.from(new Set(
        combinedRows.map((row) => row.order_id).filter(Boolean) as string[],
      ));
      if (orderIds.length > 0) {
        // Tax truth: first identify the original boleta/factura linked to each
        // sale, then find issued credit notes that reference that document.
        const { data: docLinks, error: docLinksError } = await supabase
          .from("order_tax_documents")
          .select(`
            order_id, tax_document_id,
            tax_documents (
              id, document_number, document_type, status, original_tax_document_id
            )
          `)
          .in("order_id", orderIds);
        if (docLinksError) throw docLinksError;

        const taxState = new Map<string, CreditNoteState>();
        const originalDocToOrders = new Map<string, string[]>();
        for (const link of (docLinks || []) as any[]) {
          const doc = Array.isArray(link.tax_documents)
            ? link.tax_documents[0]
            : link.tax_documents;
          if (!doc || doc.status === "voided") continue;
          const current = taxState.get(link.order_id) || {
            hasOriginalDocument: false,
            hasCreditNote: false,
            creditNoteNumber: null,
          };
          if (doc.document_type === "nota_credito") {
            current.hasCreditNote = true;
            current.creditNoteNumber = doc.document_number ?? current.creditNoteNumber;
          } else {
            current.hasOriginalDocument = true;
            const orders = originalDocToOrders.get(doc.id) || [];
            orders.push(link.order_id);
            originalDocToOrders.set(doc.id, orders);
          }
          taxState.set(link.order_id, current);
        }

        const originalDocIds = Array.from(originalDocToOrders.keys());
        if (originalDocIds.length > 0) {
          const { data: creditDocs, error: creditDocsError } = await supabase
            .from("tax_documents")
            .select("document_number, original_tax_document_id, status")
            .eq("document_type", "nota_credito")
            .neq("status", "voided")
            .in("original_tax_document_id", originalDocIds);
          if (creditDocsError) throw creditDocsError;

          for (const creditDoc of creditDocs || []) {
            if (!creditDoc.original_tax_document_id) continue;
            for (const orderId of originalDocToOrders.get(creditDoc.original_tax_document_id) || []) {
              const state = taxState.get(orderId) || {
                hasOriginalDocument: true,
                hasCreditNote: false,
                creditNoteNumber: null,
              };
              state.hasCreditNote = true;
              state.creditNoteNumber = creditDoc.document_number ?? state.creditNoteNumber;
              taxState.set(orderId, state);
            }
          }
        }
        setCreditNotes(taxState);
      } else {
        setCreditNotes(new Map());
      }
    } catch (e) {
      console.error("Error cargando devoluciones:", e);
      setRows([]);
      setRefunds(new Map());
      setCreditNotes(new Map());
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { fetchRows(); }, [fetchRows]);
  useEffect(() => { setPage(0); setExpanded(null); }, [range.from, range.to, statusFilter]);

  const kpis = useMemo(() => {
    let opened = 0, closed = 0, refundedAmount = 0;
    for (const claim of rows) {
      if (claim.status === "opened") opened++;
      if (claim.status === "closed") closed++;
    }

    const claimedOrderIds = new Set(
      rows.map((claim) => claim.order_id).filter(Boolean) as string[],
    );
    let refundedCount = 0, missingCreditNote = 0, creditNotesOk = 0;
    for (const orderId of claimedOrderIds) {
      const refund = refunds.get(orderId);
      if (!refund) continue;
      refundedCount++;
      refundedAmount += refund.amount;
      const tax = creditNotes.get(orderId);
      if (tax?.hasOriginalDocument && tax.hasCreditNote) creditNotesOk++;
      else if (tax?.hasOriginalDocument && !tax.hasCreditNote) missingCreditNote++;
    }

    return {
      total: rows.length,
      opened,
      closed,
      refundedAmount,
      refundedCount,
      missingCreditNote,
      creditNotesOk,
    };
  }, [rows, refunds, creditNotes]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return rows;
    if (statusFilter === "missing_nc") {
      return rows.filter((claim) => {
        if (!claim.order_id || !refunds.has(claim.order_id)) return false;
        const tax = creditNotes.get(claim.order_id);
        return !!tax?.hasOriginalDocument && !tax.hasCreditNote;
      });
    }
    return rows.filter((claim) => claim.status === statusFilter);
  }, [rows, statusFilter, refunds, creditNotes]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const { data: claimsData, error: claimsError } = await supabase.functions.invoke("sync-meli-claims", {
        body: { max_pages: 10 },
      });
      if (claimsError) throw claimsError;
      const claimsUnavailable = claimsData?.error_code === "meli_post_purchase_not_authorized";
      if (!claimsUnavailable && !claimsData?.success) {
        throw new Error(claimsData?.error || claimsData?.message || "error desconocido");
      }

      // Refund truth comes from Mercado Pago and must still sync when MELI's
      // Post-Purchase API is not enabled for the application.
      const { data: cashData, error: cashError } = await supabase.functions.invoke("check-orphan-payments", {
        body: {
          date_from: range.from + "T00:00:00",
          date_to: range.to + "T23:59:59",
        },
      });
      if (cashError) throw cashError;

      const cashSummary = `${cashData?.reversalCount ?? 0} movimientos de devolución MP`;
      setSyncMsg(claimsUnavailable
        ? `⚠️ Post-Venta MELI sin permiso · ${cashSummary} sincronizados`
        : `✅ ${claimsData?.upserted ?? 0} reclamos · ${cashSummary}`);
      await fetchRows();
    } catch (e: any) {
      setSyncMsg(`❌ ${e?.message || "No se pudo sincronizar"}`);
    } finally {
      setSyncing(false);
    }
  };

  const statusBadge = (status: string | null) => {
    const label = status ? (STATUS_LABEL[status] ?? status) : "—";
    const color = status === "opened" ? "bg-amber-100 text-amber-700"
      : status === "closed" ? "bg-slate-100 text-slate-600"
      : "bg-slate-100 text-slate-500";
    return <span className={`text-xs px-1.5 py-0.5 rounded font-medium w-fit ${color}`}>{label}</span>;
  };
  const typeBadge = (type: string | null) => (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium w-fit bg-violet-100 text-violet-700">
      {type ? (TYPE_LABEL[type] ?? type) : "—"}
    </span>
  );
  const channelBadge = (channel: string | null) => channel ? (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${CHANNEL_COLOR[channel] || "bg-slate-100 text-slate-600"}`}>
      {CHANNEL_LABEL[channel] ?? channel}
    </span>
  ) : <span className="text-slate-300">—</span>;

  const creditNoteBadge = (orderId: string | null, refund: RefundMovement | null | undefined) => {
    if (!refund || !orderId) return <span className="text-xs text-slate-300">No aplica</span>;
    const tax = creditNotes.get(orderId);
    if (!tax?.hasOriginalDocument) {
      return <span className="text-xs font-medium text-amber-600">Sin DTE original</span>;
    }
    if (tax.hasCreditNote) {
      return (
        <span className="text-xs font-medium text-emerald-600">
          {tax.creditNoteNumber ? `NC ${tax.creditNoteNumber}` : "Emitida"}
        </span>
      );
    }
    return <span className="text-xs font-medium text-red-600">Pendiente</span>;
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-semibold capitalize w-44 text-center">{periodLabel(period)}</h1>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronRight className="h-5 w-5" />
            </button>
            <button onClick={fetchRows} disabled={loading}
              className="ml-1 p-1 hover:bg-slate-200 rounded text-slate-400 disabled:opacity-40">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          <button onClick={runSync} disabled={syncing}
            title="Actualiza reclamos MELI, devoluciones y contracargos de Mercado Pago"
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white text-sm font-medium rounded-lg">
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            Actualizar devoluciones
          </button>
        </div>

        {syncMsg && (
          <p className={`text-xs mb-4 ${syncMsg.startsWith("❌") ? "text-red-600" : "text-green-700"}`}>{syncMsg}</p>
        )}

        {/* KPIs: siempre reflejan todo el período, sin importar el filtro de estado. */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Reclamos del período</p>
            <p className="text-xl font-bold text-slate-900 tabular-nums">{kpis.total}</p>
            <p className="text-xs text-slate-400 mt-1">mediaciones, devoluciones, cancelaciones</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Abiertos</p>
            <p className={`text-xl font-bold tabular-nums ${kpis.opened > 0 ? "text-amber-600" : "text-slate-900"}`}>
              {kpis.opened}
            </p>
            <p className="text-xs text-slate-400 mt-1">requieren seguimiento</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Cerrados</p>
            <p className="text-xl font-bold text-slate-900 tabular-nums">{kpis.closed}</p>
            <p className="text-xs text-slate-400 mt-1">proceso finalizado</p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">
              Salidas confirmadas
            </p>
            <p className="text-xl font-bold text-red-600 tabular-nums">{clp(kpis.refundedAmount)}</p>
            <p className="text-xs text-slate-400 mt-1">
              {kpis.refundedCount > 0
                ? `${kpis.refundedCount} confirmadas por MercadoPago`
                : "sin confirmación de MercadoPago todavía"}
            </p>
          </div>
          <div className="bg-white rounded-xl border shadow-card p-4">
            <p className="text-xs text-slate-400 mb-1">Sin nota de crédito</p>
            <p className={`text-xl font-bold tabular-nums ${kpis.missingCreditNote > 0 ? "text-red-600" : "text-emerald-600"}`}>
              {kpis.missingCreditNote}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {kpis.creditNotesOk} devoluciones con NC emitida
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {([
            ["all", "Todos"], ["opened", "Abiertos"], ["closed", "Cerrados"], ["missing_nc", "Sin nota de crédito"],
          ] as [StatusFilter, string][]).map(([val, label]) => (
            <button key={val} onClick={() => setStatusFilter(val)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                statusFilter === val
                  ? "bg-slate-800 text-white border-slate-800"
                  : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
              }`}>
              {label}
            </button>
          ))}
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b">
                <th className="px-4 py-2 font-medium">Fecha</th>
                <th className="px-4 py-2 font-medium">Tipo</th>
                <th className="px-4 py-2 font-medium">Canal</th>
                <th className="px-4 py-2 font-medium">Venta</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium text-right">Plata devuelta</th>
                <th className="px-4 py-2 font-medium">Nota de crédito</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline" />
                </td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  Sin reclamos/devoluciones en este período. Presiona <b>Actualizar devoluciones</b> si esperabas ver datos.
                </td></tr>
              ) : pageRows.map((c) => {
                const isOpen = expanded === c.id;
                const refund = c.order_id ? refunds.get(c.order_id) : null;
                return (
                  <Fragment key={c.id}>
                    <tr className="border-b last:border-0 hover:bg-slate-50 align-top cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : c.id)}>
                      <td className="px-4 py-2 text-slate-500">
                        {c.date_created ? format(new Date(c.date_created), "dd/MM/yyyy") : "—"}
                      </td>
                      <td className="px-4 py-2">{typeBadge(c.type)}</td>
                      <td className="px-4 py-2">{channelBadge(c.orders?.channel ?? null)}</td>
                      <td className="px-4 py-2 truncate max-w-[220px] text-slate-700">
                        {c.orders?.product_title || c.resource_id || "—"}
                      </td>
                      <td className="px-4 py-2">{statusBadge(c.status)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {refund ? <span className="text-red-600">{clp(refund.amount)}</span> : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2">
                        {creditNoteBadge(c.order_id, refund)}
                      </td>
                      <td className="px-4 py-2 text-slate-400">
                        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b bg-slate-50">
                        <td colSpan={8} className="px-4 py-3 text-xs space-y-1">
                          <div><span className="text-slate-400">claim_id: </span><span className="font-mono">{c.claim_id}</span></div>
                          <div><span className="text-slate-400">stage: </span>{c.stage || "—"}</div>
                          <div><span className="text-slate-400">reason_id: </span>{c.reason_id || "—"}</div>
                          <div><span className="text-slate-400">última actualización: </span>{c.last_updated ? format(new Date(c.last_updated), "dd/MM/yyyy HH:mm") : "—"}</div>
                          <div><span className="text-slate-400">orden: </span>{c.orders?.order_id || c.resource_id || "—"} {c.orders?.customer_name ? `· ${c.orders.customer_name}` : ""}</div>
                          <div><span className="text-slate-400">monto venta: </span>{clp(c.orders?.gross_amount)}</div>
                          {refund && (
                            <div><span className="text-slate-400">pago MP: </span>
                              <span className="text-red-600 font-medium">{refund.status}</span> · {clp(refund.amount)}
                              {refund.paymentDate ? ` · ${format(new Date(refund.paymentDate), "dd/MM/yyyy")}` : ""}
                            </div>
                          )}
                          <div><span className="text-slate-400">nota de crédito: </span>
                            {creditNoteBadge(c.order_id, refund)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-slate-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} de {filtered.length}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-slate-500">{page + 1} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="p-1 hover:bg-slate-200 rounded disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mt-3">
          Los reclamos vienen de la API de Post-Venta de MercadoLibre. La plata devuelta se registra desde
          <code> transaction_amount_refunded </code> o un contracargo confirmado por Mercado Pago, como una salida
          negativa de caja. “NC pendiente” significa que existe un DTE original vigente pero todavía no aparece una
          nota de crédito vinculada en Bsale.
        </p>

      </main>
    </div>
  );
}
