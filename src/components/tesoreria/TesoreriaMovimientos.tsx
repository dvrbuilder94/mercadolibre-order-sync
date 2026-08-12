import { Fragment, useMemo, useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  GripVertical,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { CHANNEL_COLOR } from "@/lib/constants";
import { supabase } from "@/integrations/supabase/client";
import { clp, TesoreriaPayment, channelLabel } from "@/lib/tesoreria";

type MatchFilter = "all" | "matched" | "partial" | "orphan";
type ColumnKey =
  | "fecha"
  | "paymentId"
  | "pasarela"
  | "medio"
  | "canal"
  | "bruto"
  | "comision"
  | "otras"
  | "neto"
  | "liberacion"
  | "ventas"
  | "doc"
  | "estado";

type ColumnDef = { key: ColumnKey; label: string; align?: "right" };
type Sale = TesoreriaPayment["sales"][number];
type Document = TesoreriaPayment["documents"][number];
type DocumentGroup = {
  document: Document;
  payments: Map<string, TesoreriaPayment>;
  sales: Map<string, Sale>;
};

const COLUMNS: ColumnDef[] = [
  { key: "fecha", label: "Fecha" },
  { key: "paymentId", label: "Payment ID" },
  { key: "pasarela", label: "Pasarela" },
  { key: "medio", label: "Medio" },
  { key: "canal", label: "Canal" },
  { key: "bruto", label: "Bruto", align: "right" },
  { key: "comision", label: "Comisión", align: "right" },
  { key: "otras", label: "Otras deducciones", align: "right" },
  { key: "neto", label: "Neto", align: "right" },
  { key: "liberacion", label: "Liberación" },
  { key: "ventas", label: "Ventas" },
  { key: "doc", label: "Doc" },
  { key: "estado", label: "Estado" },
];

const DEFAULT_VISIBLE: ColumnKey[] = [
  "fecha", "paymentId", "medio", "canal", "bruto", "comision", "neto",
  "liberacion", "ventas", "doc", "estado",
];
const STORAGE_VISIBLE = "quadra_tesoreria_visible_columns_v3";
const STORAGE_ORDER = "quadra_tesoreria_column_order_v3";
const PAGE = 50;

const safeParseColumns = (key: string, fallback: ColumnKey[]) => {
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter((x): x is ColumnKey => COLUMNS.some((c) => c.key === x));
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
};

const moneyEqual = (a: number, b: number) => Math.abs(a - b) <= 1;
const sumGrossPayments = (payments: Map<string, TesoreriaPayment>) =>
  Array.from(payments.values()).reduce((sum, payment) => sum + payment.gross, 0);
const sumGrossSales = (sales: Map<string, Sale>) =>
  Array.from(sales.values()).reduce((sum, sale) => sum + (sale.gross || 0), 0);
const amountExpression = (values: number[]) =>
  values.length <= 1 ? clp(values[0] || 0) : `${values.map(clp).join(" + ")} = ${clp(values.reduce((a, b) => a + b, 0))}`;

function paymentStatus(p: TesoreriaPayment) {
  if (p.matchState === "orphan") return { label: "Sin venta", className: "text-red-700 bg-red-50" };
  if (p.matchState === "partial") return { label: "Parcial", className: "text-amber-700 bg-amber-50" };
  if (p.docsOk !== p.sales.length) return { label: "Sin DTE", className: "text-amber-700 bg-amber-50" };
  return { label: "Completo", className: "text-emerald-700 bg-emerald-50" };
}

function documentLabel(type: string | null) {
  if (type === "boleta") return "Boleta";
  if (type === "factura") return "Factura";
  if (type === "nota_credito") return "Nota de crédito";
  if (type === "nota_debito") return "Nota de débito";
  return "DTE";
}

interface Props {
  payments: TesoreriaPayment[];
  initialMatchFilter?: MatchFilter;
  onOpenOrder: (id: string) => void;
}

export function TesoreriaMovimientos({ payments, initialMatchFilter = "all", onOpenOrder }: Props) {
  const [q, setQ] = useState("");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>(initialMatchFilter);
  const [provider, setProvider] = useState("all");
  const [channel, setChannel] = useState("all");
  const [method, setMethod] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visible, setVisible] = useState<ColumnKey[]>(() => safeParseColumns(STORAGE_VISIBLE, DEFAULT_VISIBLE));
  const [order, setOrder] = useState<ColumnKey[]>(() => {
    const saved = safeParseColumns(STORAGE_ORDER, COLUMNS.map((c) => c.key));
    const missing = COLUMNS.map((c) => c.key).filter((key) => !saved.includes(key));
    return [...saved, ...missing];
  });
  const [dragging, setDragging] = useState<ColumnKey | null>(null);
  const [documentTotals, setDocumentTotals] = useState<Record<string, number | null>>({});

  const persistVisible = (next: ColumnKey[]) => {
    setVisible(next);
    window.localStorage.setItem(STORAGE_VISIBLE, JSON.stringify(next));
  };
  const persistOrder = (next: ColumnKey[]) => {
    setOrder(next);
    window.localStorage.setItem(STORAGE_ORDER, JSON.stringify(next));
  };

  const orderedColumns = order
    .map((key) => COLUMNS.find((c) => c.key === key))
    .filter((c): c is ColumnDef => !!c)
    .filter((c) => visible.includes(c.key));

  const providers = useMemo(() => Array.from(new Set(payments.map((p) => p.provider))).filter(Boolean), [payments]);
  const channels = useMemo(() => {
    const result = new Set<string>();
    payments.forEach((p) => p.channels.forEach((c) => result.add(c)));
    return Array.from(result);
  }, [payments]);
  const methods = useMemo(() => Array.from(new Set(payments.map((p) => p.method))).filter(Boolean), [payments]);

  // La unidad de lectura parte en payment. Para entender una operación completa,
  // agrupamos por DTE: payments que llegan al documento y ventas cubiertas por él.
  // Los Maps evitan contar dos veces un payment que esté vinculado a varias órdenes.
  const documentGroups = useMemo(() => {
    const result = new Map<string, DocumentGroup>();
    for (const payment of payments) {
      for (const document of payment.documents) {
        const group = result.get(document.id) || {
          document,
          payments: new Map<string, TesoreriaPayment>(),
          sales: new Map<string, Sale>(),
        };
        group.payments.set(payment.id, payment);
        for (const sale of payment.sales) {
          if (sale.documents.some((doc) => doc.id === document.id)) group.sales.set(sale.id, sale);
        }
        result.set(document.id, group);
      }
    }
    return result;
  }, [payments]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return payments.filter((p) => {
      if (matchFilter !== "all" && p.matchState !== matchFilter) return false;
      if (provider !== "all" && p.provider !== provider) return false;
      if (method !== "all" && p.method !== method) return false;
      if (channel !== "all" && !p.channels.includes(channel)) return false;
      if (!term) return true;
      const hay = [
        p.paymentId, p.method, p.methodBrand || "", ...p.packIds,
        ...p.sales.map((s) => s.orderId), ...p.sales.map((s) => s.customer || ""),
        ...p.documents.map((d) => d.number),
      ].join(" ").toLowerCase();
      return hay.includes(term);
    });
  }, [payments, q, matchFilter, provider, method, channel]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);

  const loadDocumentTotals = async (payment: TesoreriaPayment) => {
    const ids = payment.documents.map((d) => d.id).filter((id) => !(id in documentTotals));
    if (ids.length === 0) return;
    const { data, error } = await supabase.from("tax_documents").select("id, total_amount").in("id", ids);
    if (error) {
      console.error("Error cargando total de DTE en Tesorería:", error);
      return;
    }
    setDocumentTotals((prev) => {
      const next = { ...prev };
      for (const row of data || []) next[row.id] = row.total_amount;
      for (const id of ids) if (!(id in next)) next[id] = null;
      return next;
    });
  };

  const toggle = (payment: TesoreriaPayment) => {
    const opening = !expanded.has(payment.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(payment.id) ? next.delete(payment.id) : next.add(payment.id);
      return next;
    });
    if (opening) void loadDocumentTotals(payment);
  };

  const exportCsv = () => {
    const headers = [
      "fecha_pago", "payment_id", "pasarela", "medio", "marca", "cuotas", "canal",
      "bruto", "comision", "otras_deducciones", "neto", "liberacion", "ventas",
      "documentos", "estado", "pack_ids",
    ];
    const rows = filtered.map((p) => [
      p.paymentDate, p.paymentId, p.provider, p.method, p.methodBrand || "", p.installments ?? "",
      p.channels.join("|"), p.gross, p.fees, p.otherDeductions, p.net, p.releaseDate || "",
      p.sales.map((s) => s.orderId).join("|"), p.documents.map((d) => d.number).join("|"),
      paymentStatus(p).label, p.packIds.join("|"),
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tesoreria_${format(new Date(), "yyyyMMdd_HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderDocument = (document: Document) => document.url ? (
    <a href={document.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-0.5">
      {document.number}<ExternalLink className="h-3 w-3" />
    </a>
  ) : <span>{document.number}</span>;

  const renderCell = (column: ColumnKey, p: TesoreriaPayment) => {
    const status = paymentStatus(p);
    const packOrders = p.packIds.length > 0 ? new Set(p.sales.filter((s) => s.packId === p.packIds[0]).map((s) => s.id)).size : 0;
    switch (column) {
      case "fecha": return <span className="whitespace-nowrap">{format(new Date(p.paymentDate), "dd MMM yyyy", { locale: es })}</span>;
      case "paymentId": return (
        <div className="min-w-[145px]">
          <span className="inline-flex items-center gap-1 font-mono text-[12px]">
            {p.paymentId}
            <button onClick={() => navigator.clipboard.writeText(p.paymentId)} className="text-slate-300 hover:text-slate-600" title="Copiar"><Copy className="h-3 w-3" /></button>
          </span>
          {packOrders > 1 && <div className="mt-1 text-[10px] text-slate-500">Pack · {packOrders} órdenes</div>}
        </div>
      );
      case "pasarela": return <span className="text-slate-600">{p.provider}</span>;
      case "medio": return <div><div>{p.method}</div>{p.methodBrand && <div className="text-[10px] text-slate-400 uppercase">{p.methodBrand}{p.installments ? ` · ${p.installments}x` : ""}</div>}</div>;
      case "canal": return (
        <div className="flex flex-col gap-1">
          {p.channels.length === 0 ? <span className="text-slate-300">—</span> : p.channels.map((ch) => (
            <span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-600"}`}>{channelLabel(ch)}</span>
          ))}
        </div>
      );
      case "bruto": return <span className="tabular-nums">{clp(p.gross)}</span>;
      case "comision": return <span className="tabular-nums text-slate-500">{p.fees ? `-${clp(p.fees)}` : "—"}</span>;
      case "otras": return <span className="tabular-nums text-slate-500">{p.otherDeductions ? `-${clp(p.otherDeductions)}` : "—"}</span>;
      case "neto": return <span className="tabular-nums font-semibold text-slate-900">{clp(p.net)}</span>;
      case "liberacion": return p.releaseDate ? (
        <span className={p.liberado ? "text-emerald-700" : "text-slate-700"}>
          {format(new Date(p.releaseDate), "dd MMM", { locale: es })}
          {!p.exactRelease && <span className="text-slate-400"> ≈</span>}
          <span className="block text-[10px] text-slate-400">{p.liberado ? "Liberado" : "Pendiente"}{!p.exactRelease ? " · estim." : ""}</span>
        </span>
      ) : <span className="text-slate-300">—</span>;
      case "ventas": return <span className="text-xs text-slate-600">{p.sales.length || 0}</span>;
      case "doc": return p.documents.length === 0 ? <span className="text-slate-300">—</span> : (
        <span className="inline-flex items-center gap-1 text-xs">{renderDocument(p.documents[0])}{p.documents.length > 1 && <span className="text-slate-400">+{p.documents.length - 1}</span>}</span>
      );
      case "estado": return <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${status.className}`}>{status.label}</span>;
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl p-3 flex flex-wrap items-center gap-2 relative">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Payment ID, orden, pack, documento…" className="text-xs pl-7 pr-3 py-1.5 border rounded-md w-64 focus:outline-none focus:ring-1 focus:ring-slate-300" />
        </div>
        <Select label="Estado" value={matchFilter} onChange={(v) => { setMatchFilter(v as MatchFilter); setPage(0); }} options={[["all", "Todos"], ["matched", "Asignados"], ["partial", "Parciales"], ["orphan", "Sin venta"]]} />
        <Select label="Pasarela" value={provider} onChange={(v) => { setProvider(v); setPage(0); }} options={[["all", "Todas"], ...providers.map((p) => [p, p] as [string, string])]} />
        <Select label="Canal" value={channel} onChange={(v) => { setChannel(v); setPage(0); }} options={[["all", "Todos"], ...channels.map((c) => [c, channelLabel(c)] as [string, string])]} />
        <Select label="Medio" value={method} onChange={(v) => { setMethod(v); setPage(0); }} options={[["all", "Todos"], ...methods.map((m) => [m, m] as [string, string])]} />

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-400">{filtered.length} pagos</span>
          <button onClick={() => setColumnsOpen((v) => !v)} className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" /> Columnas</button>
          <button onClick={exportCsv} className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5"><Download className="h-3.5 w-3.5" /> CSV</button>
        </div>

        {columnsOpen && (
          <div className="absolute right-3 top-12 z-20 w-72 bg-white border rounded-lg shadow-lg p-3">
            <div className="flex items-center justify-between mb-2"><span className="text-xs font-semibold text-slate-700">Columnas</span><button onClick={() => setColumnsOpen(false)} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button></div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {order.map((key) => {
                const def = COLUMNS.find((c) => c.key === key)!;
                return (
                  <div key={key} draggable onDragStart={() => setDragging(key)} onDragOver={(e) => e.preventDefault()} onDrop={() => {
                    if (!dragging || dragging === key) return;
                    const next = order.filter((k) => k !== dragging);
                    next.splice(next.indexOf(key), 0, dragging);
                    persistOrder(next); setDragging(null);
                  }} className="flex items-center gap-2 px-1 py-1 text-xs text-slate-700">
                    <GripVertical className="h-3.5 w-3.5 text-slate-300 cursor-grab" />
                    <input type="checkbox" checked={visible.includes(key)} onChange={(e) => {
                      const next = e.target.checked ? [...visible, key] : visible.filter((v) => v !== key);
                      persistVisible(next.length > 0 ? next : [key]);
                    }} />
                    <span>{def.label}</span>
                  </div>
                );
              })}
            </div>
            <button onClick={() => { persistVisible(DEFAULT_VISIBLE); persistOrder(COLUMNS.map((c) => c.key)); }} className="mt-2 text-[11px] text-slate-500 hover:text-slate-800">Restablecer</button>
          </div>
        )}
      </div>

      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b">
              <tr><th className="px-2 py-2.5 w-6" />{orderedColumns.map((column) => <th key={column.key} className={`px-3 py-2.5 font-medium ${column.align === "right" ? "text-right" : "text-left"}`}>{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {slice.length === 0 && <tr><td colSpan={orderedColumns.length + 1} className="px-3 py-12 text-center text-slate-400">Sin pagos para los filtros aplicados.</td></tr>}
              {slice.map((p) => {
                const isOpen = expanded.has(p.id);
                return (
                  <Fragment key={p.id}>
                    <tr className="border-b hover:bg-slate-50/60 align-top">
                      <td className="px-2 py-2.5"><button onClick={() => toggle(p)} className="text-slate-400 hover:text-slate-700 p-0.5">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
                      {orderedColumns.map((column) => <td key={column.key} className={`px-3 py-2.5 ${column.align === "right" ? "text-right" : "text-left"}`}>{renderCell(column.key, p)}</td>)}
                    </tr>

                    {isOpen && (
                      <tr className="border-b bg-slate-50/30">
                        <td />
                        <td colSpan={orderedColumns.length} className="px-4 py-4">
                          <div className="text-xs text-slate-500 mb-4 flex flex-wrap gap-x-4 gap-y-1">
                            <span className="font-medium text-slate-700">Pago {p.paymentId}</span>
                            <span>Bruto <b className="text-slate-900 tabular-nums">{clp(p.gross)}</b></span>
                            <span>Comisión <b className="text-slate-700 tabular-nums">-{clp(p.fees)}</b></span>
                            {p.otherDeductions > 0 && <span>Otras deducciones <b className="text-slate-700 tabular-nums">-{clp(p.otherDeductions)}</b></span>}
                            <span>Neto <b className="text-slate-900 tabular-nums">{clp(p.net)}</b></span>
                          </div>

                          {p.documents.length === 0 ? (
                            <div>
                              <p className="text-xs font-medium text-slate-700 mb-2">Sin DTE vinculado</p>
                              <OrdersTable sales={p.sales} onOpenOrder={onOpenOrder} />
                            </div>
                          ) : p.documents.map((document) => {
                            const group = documentGroups.get(document.id);
                            const groupedPayments = group ? Array.from(group.payments.values()) : [p];
                            const groupedSales = group ? Array.from(group.sales.values()) : p.sales;
                            const paymentsGross = group ? sumGrossPayments(group.payments) : p.gross;
                            const salesGross = group ? sumGrossSales(group.sales) : p.sales.reduce((sum, sale) => sum + (sale.gross || 0), 0);
                            const documentTotal = documentTotals[document.id];
                            const hasDocumentTotal = documentTotal != null;
                            const reconciled = hasDocumentTotal && moneyEqual(paymentsGross, documentTotal) && moneyEqual(salesGross, documentTotal);
                            return (
                              <div key={document.id} className="border-t first:border-t-0 pt-3 first:pt-0 mt-3 first:mt-0">
                                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs mb-1.5">
                                  <span className="font-semibold text-slate-800">{documentLabel(document.type)} {renderDocument(document)}</span>
                                  <span className="text-slate-500">Total {hasDocumentTotal ? <b className="text-slate-800">{clp(documentTotal)}</b> : "cargando…"}</span>
                                  {reconciled && <span className="text-emerald-700 font-medium">✓ cuadra</span>}
                                </div>
                                <div className="text-[11px] text-slate-500 mb-3 flex flex-wrap gap-x-5 gap-y-1">
                                  <span>Pagos ({groupedPayments.length}): <b className="text-slate-700">{amountExpression(groupedPayments.map((payment) => payment.gross))}</b></span>
                                  <span>Ventas ({groupedSales.length}): <b className="text-slate-700">{amountExpression(groupedSales.map((sale) => sale.gross || 0))}</b></span>
                                  {hasDocumentTotal && !reconciled && <span className="text-amber-700">Revisar cuadre</span>}
                                </div>
                                <OrdersTable sales={groupedSales} onOpenOrder={onOpenOrder} />
                              </div>
                            );
                          })}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Página {safePage + 1} de {totalPages}</span>
          <div className="flex gap-2"><button disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="px-2 py-1 border rounded disabled:opacity-40">Anterior</button><button disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} className="px-2 py-1 border rounded disabled:opacity-40">Siguiente</button></div>
        </div>
      )}
    </div>
  );
}

function OrdersTable({ sales, onOpenOrder }: { sales: Sale[]; onOpenOrder: (id: string) => void }) {
  if (sales.length === 0) return <p className="text-xs text-slate-400">Sin ventas vinculadas.</p>;
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-left text-[10px] uppercase text-slate-400 border-b"><th className="py-1.5 pr-3">Orden</th><th className="py-1.5 pr-3">Cliente / producto</th><th className="py-1.5 pl-3 text-right">Venta bruta</th></tr></thead>
      <tbody>{sales.map((sale) => (
        <tr key={sale.id} className="border-b last:border-0">
          <td className="py-2 pr-3"><button onClick={() => onOpenOrder(sale.id)} className="font-mono text-blue-600 hover:underline">{sale.orderId}</button></td>
          <td className="py-2 pr-3 max-w-[430px]"><div className="text-slate-700 truncate">{sale.customer || "—"}</div><div className="text-[10px] text-slate-400 truncate">{sale.title || "—"}</div></td>
          <td className="py-2 pl-3 text-right tabular-nums text-slate-700">{clp(sale.gross)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <label className="text-[11px] text-slate-400 flex items-center gap-1"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs text-slate-700 border rounded-md px-2 py-1.5 bg-white">{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
}
