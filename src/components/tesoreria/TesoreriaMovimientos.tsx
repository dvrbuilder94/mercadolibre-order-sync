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
  "fecha",
  "paymentId",
  "medio",
  "canal",
  "bruto",
  "comision",
  "neto",
  "liberacion",
  "ventas",
  "doc",
  "estado",
];

const STORAGE_VISIBLE = "quadra_tesoreria_visible_columns_v2";
const STORAGE_ORDER = "quadra_tesoreria_column_order_v2";
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

interface Props {
  payments: TesoreriaPayment[];
  initialMatchFilter?: MatchFilter;
  onOpenOrder: (id: string) => void;
}

function paymentStatus(p: TesoreriaPayment) {
  if (p.matchState === "orphan") {
    return { label: "Sin venta", className: "bg-red-100 text-red-700" };
  }
  if (p.matchState === "partial") {
    return {
      label: p.packIds.length > 0 ? "Asignación dudosa" : "Diferencia",
      className: "bg-amber-100 text-amber-800",
    };
  }
  if (p.docsOk !== p.sales.length) {
    return { label: "Sin DTE", className: "bg-amber-100 text-amber-700" };
  }
  return { label: "Completo", className: "bg-emerald-100 text-emerald-700" };
}

const approxEqual = (a: number, b: number) => {
  const ref = Math.max(Math.abs(a), Math.abs(b));
  const tolerance = Math.max(ref * 0.005, 1);
  return Math.abs(a - b) <= tolerance;
};

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
    const s = new Set<string>();
    payments.forEach((p) => p.channels.forEach((c) => s.add(c)));
    return Array.from(s);
  }, [payments]);
  const methods = useMemo(() => Array.from(new Set(payments.map((p) => p.method))).filter(Boolean), [payments]);

  const packStats = useMemo(() => {
    const stats = new Map<string, { sales: Map<string, number>; payments: Set<string> }>();
    for (const payment of payments) {
      for (const sale of payment.sales) {
        if (!sale.packId) continue;
        const current = stats.get(sale.packId) || { sales: new Map<string, number>(), payments: new Set<string>() };
        current.sales.set(sale.id, sale.gross || 0);
        current.payments.add(payment.id);
        stats.set(sale.packId, current);
      }
    }
    return stats;
  }, [payments]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return payments.filter((p) => {
      if (matchFilter !== "all" && p.matchState !== matchFilter) return false;
      if (provider !== "all" && p.provider !== provider) return false;
      if (method !== "all" && p.method !== method) return false;
      if (channel !== "all" && !p.channels.includes(channel)) return false;
      if (term) {
        const hay = [
          p.paymentId,
          p.method,
          p.methodBrand || "",
          ...p.packIds,
          ...p.sales.map((s) => s.orderId),
          ...p.sales.map((s) => s.customer || ""),
          ...p.documents.map((d) => d.number),
        ].join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [payments, q, matchFilter, provider, method, channel]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const exportCsv = () => {
    const headers = [
      "fecha_pago", "payment_id", "pasarela", "medio", "marca", "cuotas", "canal",
      "bruto", "comision", "otras_deducciones", "neto", "liberacion", "ventas",
      "documentos", "estado", "pack_ids", "bruto_ventas_vinculadas", "neto_asignado",
    ];
    const rows = filtered.map((p) => [
      p.paymentDate, p.paymentId, p.provider, p.method, p.methodBrand || "", p.installments ?? "",
      p.channels.join("|"), p.gross, p.fees, p.otherDeductions, p.net, p.releaseDate || "",
      p.sales.map((s) => s.orderId).join("|"), p.documents.map((d) => d.number).join("|"),
      paymentStatus(p).label, p.packIds.join("|"), p.linkedGrossSum, p.allocatedSum,
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

  const renderCell = (column: ColumnKey, p: TesoreriaPayment) => {
    const status = paymentStatus(p);
    const primaryPack = p.packIds[0] || null;
    const stats = primaryPack ? packStats.get(primaryPack) : null;
    switch (column) {
      case "fecha":
        return <span className="whitespace-nowrap">{format(new Date(p.paymentDate), "dd MMM yyyy", { locale: es })}</span>;
      case "paymentId":
        return (
          <div className="min-w-[150px]">
            <span className="inline-flex items-center gap-1 font-mono text-[12px]">
              {p.paymentId}
              <button onClick={() => navigator.clipboard.writeText(p.paymentId)} className="text-slate-300 hover:text-slate-600" title="Copiar">
                <Copy className="h-3 w-3" />
              </button>
            </span>
            {primaryPack && (
              <div className="mt-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                  Pack{stats ? ` · ${stats.sales.size} órdenes` : ""}
                </span>
              </div>
            )}
          </div>
        );
      case "pasarela": return <span className="text-slate-600">{p.provider}</span>;
      case "medio":
        return (
          <div>
            <div>{p.method}</div>
            {p.methodBrand && <div className="text-[10px] text-slate-400 uppercase">{p.methodBrand}{p.installments ? ` · ${p.installments}x` : ""}</div>}
          </div>
        );
      case "canal":
        return (
          <div className="flex flex-col gap-1">
            {p.channels.length === 0 ? <span className="text-slate-300">—</span> : p.channels.map((ch) => (
              <span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-600"}`}>
                {channelLabel(ch)}
              </span>
            ))}
          </div>
        );
      case "bruto": return <span className="tabular-nums">{clp(p.gross)}</span>;
      case "comision": return <span className="tabular-nums text-slate-500">{p.fees ? `-${clp(p.fees)}` : "—"}</span>;
      case "otras": return <span className="tabular-nums text-slate-500">{p.otherDeductions ? `-${clp(p.otherDeductions)}` : "—"}</span>;
      case "neto": return <span className="tabular-nums font-semibold text-slate-900">{clp(p.net)}</span>;
      case "liberacion":
        return p.releaseDate ? (
          <span className={p.liberado ? "text-emerald-600" : "text-amber-600"}>
            {format(new Date(p.releaseDate), "dd MMM", { locale: es })}
            {!p.exactRelease && <span title="Fecha no confirmada para todas las ventas" className="text-amber-500"> ≈</span>}
            <span className="block text-[10px] text-slate-400">{p.liberado ? "Liberado" : "Pendiente"}{!p.exactRelease ? " · estim." : ""}</span>
          </span>
        ) : <span className="text-slate-300">—</span>;
      case "ventas": return <span className="text-xs text-slate-600">{p.sales.length || 0}</span>;
      case "doc":
        if (p.documents.length === 0) return <span className="text-slate-300">—</span>;
        return (
          <span className="inline-flex items-center gap-1 text-xs">
            {p.documents[0].url ? (
              <a href={p.documents[0].url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-0.5">
                {p.documents[0].number}<ExternalLink className="h-3 w-3" />
              </a>
            ) : <span>{p.documents[0].number}</span>}
            {p.documents.length > 1 && <span className="text-slate-400">+{p.documents.length - 1}</span>}
          </span>
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
        <Select label="Estado" value={matchFilter} onChange={(v) => { setMatchFilter(v as MatchFilter); setPage(0); }} options={[["all","Todos"],["matched","Asignación válida"],["partial","Diferencia / dudosa"],["orphan","Sin venta"]]} />
        <Select label="Pasarela" value={provider} onChange={(v) => { setProvider(v); setPage(0); }} options={[["all","Todas"], ...providers.map((p) => [p, p] as [string, string])]} />
        <Select label="Canal" value={channel} onChange={(v) => { setChannel(v); setPage(0); }} options={[["all","Todos"], ...channels.map((c) => [c, channelLabel(c)] as [string, string])]} />
        <Select label="Medio" value={method} onChange={(v) => { setMethod(v); setPage(0); }} options={[["all","Todos"], ...methods.map((m) => [m, m] as [string, string])]} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-400">{filtered.length} pagos</span>
          <button onClick={() => setColumnsOpen((v) => !v)} className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" /> Columnas</button>
          <button onClick={exportCsv} className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5"><Download className="h-3.5 w-3.5" /> CSV</button>
        </div>
        {columnsOpen && (
          <div className="absolute right-3 top-12 z-30 w-72 rounded-xl border bg-white shadow-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-slate-700">Columnas</p>
              <button onClick={() => setColumnsOpen(false)} className="text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>
            </div>
            <p className="text-[11px] text-slate-400 mb-2">Activa, oculta y arrastra para reordenar.</p>
            <div className="space-y-1 max-h-80 overflow-auto">
              {order.map((key) => {
                const col = COLUMNS.find((c) => c.key === key)!;
                return (
                  <div key={key} draggable onDragStart={() => setDragging(key)} onDragOver={(e) => e.preventDefault()} onDrop={() => {
                    if (!dragging || dragging === key) return;
                    const next = [...order];
                    next.splice(next.indexOf(dragging), 1);
                    next.splice(next.indexOf(key), 0, dragging);
                    persistOrder(next);
                    setDragging(null);
                  }} className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-slate-50 cursor-grab">
                    <GripVertical className="h-3.5 w-3.5 text-slate-300" />
                    <input type="checkbox" checked={visible.includes(key)} onChange={(e) => {
                      const next = e.target.checked ? [...visible, key] : visible.filter((x) => x !== key);
                      persistVisible(next.length > 0 ? next : ["paymentId"]);
                    }} />
                    <span className="text-xs text-slate-700">{col.label}</span>
                  </div>
                );
              })}
            </div>
            <button onClick={() => { persistVisible(DEFAULT_VISIBLE); persistOrder(COLUMNS.map((c) => c.key)); }} className="mt-3 text-xs text-blue-600 hover:underline">Restablecer</button>
          </div>
        )}
      </div>

      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b">
              <tr>
                <th className="px-2 py-2.5 text-left w-6" />
                {orderedColumns.map((c) => <th key={c.key} className={`px-3 py-2.5 ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {slice.length === 0 && <tr><td colSpan={orderedColumns.length + 1} className="px-3 py-12 text-center text-slate-400">Sin pagos para los filtros aplicados.</td></tr>}
              {slice.map((p) => {
                const isOpen = expanded.has(p.id);
                const packId = p.packIds[0] || null;
                const stats = packId ? packStats.get(packId) : null;
                const packGross = stats ? Array.from(stats.sales.values()).reduce((s, v) => s + v, 0) : p.linkedGrossSum;
                const grossMatches = p.sales.length > 0 && approxEqual(p.linkedGrossSum, p.gross);
                const netMatches = p.sales.length > 0 && approxEqual(p.allocatedSum, p.net);
                return (
                  <Fragment key={p.id}>
                    <tr className="border-b hover:bg-slate-50/60 align-top">
                      <td className="px-2 py-2.5"><button onClick={() => toggle(p.id)} className="text-slate-400 hover:text-slate-700 p-0.5">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
                      {orderedColumns.map((c) => <td key={c.key} className={`px-3 py-2.5 ${c.align === "right" ? "text-right" : "text-left"}`}>{renderCell(c.key, p)}</td>)}
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/50 border-b">
                        <td />
                        <td colSpan={orderedColumns.length} className="px-4 py-4">
                          {packId && stats && (
                            <div className="mb-3 rounded-lg border bg-white px-3 py-2 text-xs text-slate-600">
                              <span className="font-semibold text-slate-800">Pack {packId}</span>
                              <span> · total {clp(packGross)}</span>
                              <span> · {stats.sales.size} órdenes</span>
                              <span> · pagado en {stats.payments.size} {stats.payments.size === 1 ? "pago" : "pagos"}</span>
                              <p className="mt-1 text-[11px] text-slate-400">
                                {stats.payments.size === 1 && approxEqual(p.gross, packGross)
                                  ? "Pago global del pack: puede distribuirse entre varias órdenes sólo porque el bruto del payment coincide con el total del pack."
                                  : "El pack tiene varios payments: cada payment debe validarse contra las ventas que realmente le corresponden; no se asume prorrateo por compartir pack_id."}
                              </p>
                            </div>
                          )}

                          <div className="flex items-center gap-x-3 gap-y-2 flex-wrap text-xs mb-3">
                            <Bridge label="Bruto" value={clp(p.gross)} />
                            <span className="text-slate-300">−</span>
                            <Bridge label="Comisión" value={clp(p.fees)} tone="red" />
                            <span className="text-slate-300">−</span>
                            <Bridge label="Otras deducciones" value={clp(p.otherDeductions)} tone="red" />
                            <span className="text-slate-300">=</span>
                            <Bridge label="Neto" value={clp(p.net)} tone="green" />
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4 text-xs">
                            <Validation label="Identidad del payment" left={`Ventas vinculadas ${clp(p.linkedGrossSum)}`} right={`Payment bruto ${clp(p.gross)}`} ok={grossMatches} />
                            <Validation label="Asignación neta registrada" left={`Σ asignado ${clp(p.allocatedSum)}`} right={`Payment neto ${clp(p.net)}`} ok={netMatches} />
                          </div>

                          {p.sales.length === 0 ? (
                            <p className="text-xs text-slate-500">Este payment existe en Mercado Pago pero no tiene una venta vinculada en Quadra.</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">Orden</th><th>Cliente / producto</th><th className="text-right">Venta bruta</th><th className="text-right">Asignado neto</th><th>Documento</th></tr></thead>
                              <tbody>
                                {p.sales.map((s) => (
                                  <tr key={s.id} className="border-t">
                                    <td className="py-2"><button onClick={() => onOpenOrder(s.id)} className="font-mono text-blue-600 hover:underline">{s.orderId}</button></td>
                                    <td className="py-2"><div className="text-slate-700">{s.customer || "—"}</div><div className="text-[10px] text-slate-400 max-w-[260px] truncate">{s.title || ""}</div></td>
                                    <td className="py-2 text-right tabular-nums">{clp(s.gross)}</td>
                                    <td className="py-2 text-right tabular-nums">{clp(s.allocated)}</td>
                                    <td className="py-2">
                                      {s.documents.length === 0 ? <span className="text-amber-600">Falta DTE</span> : s.documents.map((d, index) => (
                                        <span key={d.id}>{index > 0 && ", "}{d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{d.number}</a> : d.number}</span>
                                      ))}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
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

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <label className="text-[11px] text-slate-400 flex items-center gap-1"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs text-slate-700 border rounded-md px-2 py-1.5 bg-white">{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
}

function Bridge({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "red" | "green" }) {
  const cls = tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : "text-slate-800";
  return <span className="text-slate-400">{label} <b className={`${cls} tabular-nums`}>{value}</b></span>;
}

function Validation({ label, left, right, ok }: { label: string; left: string; right: string; ok: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className={`font-semibold ${ok ? "text-emerald-700" : "text-amber-800"}`}>{label} · {ok ? "✓ cuadra" : "revisar"}</div>
      <div className="text-[11px] text-slate-500 mt-0.5">{left} · {right}</div>
    </div>
  );
}
