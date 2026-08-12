import { useEffect, useMemo, useState, Fragment, type ReactNode } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronDown, ChevronRight, Copy, Download, ExternalLink, Search, SlidersHorizontal } from "lucide-react";
import { CHANNEL_COLOR } from "@/lib/constants";
import { clp, TesoreriaPayment, channelLabel, docTypeLabel } from "@/lib/tesoreria";

type MatchFilter = "all" | "matched" | "partial" | "orphan";

interface Props {
  payments: TesoreriaPayment[];
  initialMatchFilter?: MatchFilter;
  onOpenOrder: (id: string) => void;
}

const PAGE = 50;
const COLS_KEY = "tesoreria.detalle.columns";

type ColKey =
  | "fecha" | "paymentId" | "provider" | "method" | "channel" | "gross"
  | "fees" | "net" | "release" | "sales" | "doc" | "match";

const COLUMNS: { key: ColKey; label: string; align?: "right" }[] = [
  { key: "fecha", label: "Fecha" },
  { key: "paymentId", label: "Payment ID" },
  { key: "provider", label: "Pasarela" },
  { key: "method", label: "Medio" },
  { key: "channel", label: "Canal" },
  { key: "gross", label: "Bruto", align: "right" },
  { key: "fees", label: "Comisión", align: "right" },
  { key: "net", label: "Neto", align: "right" },
  { key: "release", label: "Liberación" },
  { key: "sales", label: "Ventas" },
  { key: "doc", label: "Doc" },
  { key: "match", label: "Match" },
];

const DEFAULT_COLS: ColKey[] = COLUMNS.map((c) => c.key);

const matchBadge = (s: TesoreriaPayment["matchState"]) => {
  if (s === "matched")
    return <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700">Completo</span>;
  if (s === "partial")
    return <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-700">Parcial</span>;
  return <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-red-100 text-red-700">Sin matchear</span>;
};

const docLinks = (docs: TesoreriaPayment["docs"]) => (
  <div className="flex flex-col gap-0.5">
    {docs.map((d) =>
      d.url ? (
        <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer"
          className="text-[11px] text-sky-600 hover:underline inline-flex items-center gap-1 w-fit">
          {docTypeLabel(d.type)} {d.number ?? ""}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <span key={d.id} className="text-[11px] text-slate-500">
          {docTypeLabel(d.type)} {d.number ?? ""}
        </span>
      ),
    )}
  </div>
);

const renderCell = (p: TesoreriaPayment, key: ColKey): ReactNode => {
  switch (key) {
    case "fecha":
      return <span className="text-slate-700 whitespace-nowrap">{format(new Date(p.paymentDate), "dd MMM yyyy", { locale: es })}</span>;
    case "paymentId":
      return (
        <span className="inline-flex items-center gap-1 font-mono text-[12px] text-slate-700">
          {p.paymentId}
          <button onClick={() => navigator.clipboard.writeText(p.paymentId)}
            className="text-slate-300 hover:text-slate-600" title="Copiar">
            <Copy className="h-3 w-3" />
          </button>
        </span>
      );
    case "provider":
      return <span className="text-slate-600">{p.provider}</span>;
    case "method":
      return (
        <>
          <div className="text-slate-700">{p.method}</div>
          {p.methodBrand && <div className="text-[11px] text-slate-400 uppercase">{p.methodBrand}{p.installments ? ` · ${p.installments}x` : ""}</div>}
        </>
      );
    case "channel":
      return (
        <div className="flex flex-col gap-1">
          {p.channels.length === 0 ? <span className="text-slate-300">—</span> :
            p.channels.map((ch) => (
              <span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded font-medium w-fit ${CHANNEL_COLOR[ch] || "bg-slate-100 text-slate-600"}`}>
                {channelLabel(ch)}
              </span>
            ))}
        </div>
      );
    case "gross":
      return <span className="text-slate-600">{clp(p.gross)}</span>;
    case "fees":
      return <span className="text-slate-500">{p.fees ? `-${clp(p.fees)}` : "—"}</span>;
    case "net":
      return <span className="font-semibold text-slate-900">{clp(p.net)}</span>;
    case "release":
      return p.releaseDate ? (
        <span className={`text-xs ${p.liberado ? "text-emerald-600" : "text-amber-600"}`}>
          {format(new Date(p.releaseDate), "dd MMM", { locale: es })}
          {!p.exactRelease && <span title="Fecha estimada: MercadoPago no la confirmó (~14 días)" className="text-amber-500"> ≈</span>}
          <span className="block text-[10px] text-slate-400">{p.liberado ? "Liberado" : "Pendiente"}{!p.exactRelease ? " · estim." : ""}</span>
        </span>
      ) : <span className="text-slate-300">—</span>;
    case "sales":
      return p.sales.length === 0
        ? <span className="text-slate-300 text-xs">0</span>
        : <span className="text-xs text-slate-600">{p.sales.length} {p.sales.length === 1 ? "venta" : "ventas"}</span>;
    case "doc":
      if (p.docs.length > 0) return docLinks(p.docs);
      return p.sales.length === 0
        ? <span className="text-slate-300 text-xs">—</span>
        : <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-red-100 text-red-700">Sin documento</span>;
    case "match":
      return matchBadge(p.matchState);
    default:
      return null;
  }
};

export function TesoreriaDetalle({ payments, initialMatchFilter = "all", onOpenOrder }: Props) {
  const [q, setQ] = useState("");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>(initialMatchFilter);
  const [provider, setProvider] = useState<string>("all");
  const [channel, setChannel] = useState<string>("all");
  const [method, setMethod] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [visible, setVisible] = useState<Set<ColKey>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || "null");
      if (Array.isArray(saved) && saved.length) return new Set(saved as ColKey[]);
    } catch { /* ignore */ }
    return new Set(DEFAULT_COLS);
  });
  const [colsOpen, setColsOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(COLS_KEY, JSON.stringify(Array.from(visible)));
  }, [visible]);

  const shownCols = COLUMNS.filter((c) => visible.has(c.key));
  const toggleCol = (key: ColKey) =>
    setVisible((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n.size === 0 ? new Set<ColKey>([key]) : n;
    });

  const providers = useMemo(
    () => Array.from(new Set(payments.map((p) => p.provider))).filter(Boolean),
    [payments],
  );
  const channels = useMemo(() => {
    const s = new Set<string>();
    payments.forEach((p) => p.channels.forEach((c) => s.add(c)));
    return Array.from(s);
  }, [payments]);
  const methods = useMemo(
    () => Array.from(new Set(payments.map((p) => p.method))).filter(Boolean),
    [payments],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return payments.filter((p) => {
      if (matchFilter !== "all" && p.matchState !== matchFilter) return false;
      if (provider !== "all" && p.provider !== provider) return false;
      if (method !== "all" && p.method !== method) return false;
      if (channel !== "all" && !p.channels.includes(channel)) return false;
      if (term) {
        const hay = [
          p.paymentId, p.method, p.methodBrand || "",
          ...p.sales.map((s) => s.orderId),
          ...p.sales.map((s) => s.customer || ""),
        ].join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [payments, q, matchFilter, provider, method, channel]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const slice = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const exportCsv = () => {
    const headers = [
      "fecha_pago", "payment_id", "pasarela", "medio", "marca", "cuotas",
      "canal", "bruto", "comision", "neto", "liberacion", "liberacion_estimada", "ventas", "documentos", "links_documentos", "estado_match",
    ];
    const rows = filtered.map((p) => [
      p.paymentDate, p.paymentId, p.provider, p.method, p.methodBrand || "",
      p.installments ?? "", p.channels.join("|"),
      p.gross, p.fees, p.net, p.releaseDate || "",
      p.exactRelease ? "" : "estimada",
      p.sales.map((s) => s.orderId).join("|"),
      p.docs.map((d) => `${docTypeLabel(d.type)} ${d.number ?? ""}`.trim()).join("|"),
      p.docs.map((d) => d.url || "").filter(Boolean).join("|"),
      p.matchState,
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tesoreria_${format(new Date(), "yyyyMMdd_HHmm")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {/* Filtros */}
      <div className="bg-white border rounded-xl p-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Payment ID, orden, cliente…"
            className="text-xs pl-7 pr-3 py-1.5 border rounded-md w-64 focus:outline-none focus:ring-1 focus:ring-slate-300"
          />
        </div>
        <Select label="Estado" value={matchFilter} onChange={(v) => { setMatchFilter(v as MatchFilter); setPage(0); }}
          options={[["all","Todos"],["matched","Completo"],["partial","Parcial"],["orphan","Sin matchear"]]}/>
        <Select label="Pasarela" value={provider} onChange={(v) => { setProvider(v); setPage(0); }}
          options={[["all","Todas"], ...providers.map((p) => [p, p] as [string, string])]}/>
        <Select label="Canal" value={channel} onChange={(v) => { setChannel(v); setPage(0); }}
          options={[["all","Todos"], ...channels.map((c) => [c, channelLabel(c)] as [string, string])]}/>
        <Select label="Medio" value={method} onChange={(v) => { setMethod(v); setPage(0); }}
          options={[["all","Todos"], ...methods.map((m) => [m, m] as [string, string])]}/>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-400">{filtered.length} pagos</span>
          <div className="relative">
            <button onClick={() => setColsOpen((v) => !v)}
              className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" /> Columnas
            </button>
            {colsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} />
                <div className="absolute right-0 mt-1 z-20 w-56 bg-white border rounded-lg shadow-lg p-2">
                  <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b">
                    <span className="text-[11px] uppercase tracking-wider text-slate-400">Columnas</span>
                    <button onClick={() => setVisible(new Set(DEFAULT_COLS))}
                      className="text-[11px] text-sky-600 hover:underline">Todas</button>
                  </div>
                  {COLUMNS.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 px-1 py-1 text-xs text-slate-600 hover:bg-slate-50 rounded cursor-pointer">
                      <input type="checkbox" checked={visible.has(c.key)} onChange={() => toggleCol(c.key)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <button onClick={exportCsv}
            className="text-xs px-2.5 py-1.5 rounded-md border hover:bg-slate-50 flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b">
              <tr>
                <th className="px-3 py-2.5 text-left w-6"></th>
                {shownCols.map((c) => (
                  <th key={c.key} className={`px-3 py-2.5 ${c.align === "right" ? "text-right" : "text-left"}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.length === 0 && (
                <tr><td colSpan={shownCols.length + 1} className="px-3 py-12 text-center text-slate-400 text-sm">Sin pagos para los filtros aplicados.</td></tr>
              )}
              {slice.map((p) => {
                const isOpen = expanded.has(p.id);
                return (
                  <Fragment key={p.id}>
                    <tr className="border-b hover:bg-slate-50/60 align-top">
                      <td className="px-2 py-2.5">
                        <button onClick={() => toggle(p.id)} className="text-slate-400 hover:text-slate-700 p-0.5">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      {shownCols.map((c) => (
                        <td key={c.key} className={`px-3 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                          {renderCell(p, c.key)}
                        </td>
                      ))}
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/50 border-b">
                        <td></td>
                        <td colSpan={shownCols.length} className="px-3 py-3">
                          {/* El residual bruto − comisión − neto no se etiqueta como
                              envío/cupón sin evidencia explícita desde Mercado Pago. */}
                          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs mb-3">
                            <span className="text-slate-400">Bruto <b className="text-slate-700 tabular-nums">{clp(p.gross)}</b></span>
                            <span className="text-slate-300">−</span>
                            <span className="text-slate-400">Comisión <b className="text-red-600 tabular-nums">{clp(p.fees)}</b></span>
                            <span className="text-slate-300">−</span>
                            <span className="text-slate-400">No clasificado <b className="text-slate-700 tabular-nums">{clp(p.gross - p.fees - p.net)}</b></span>
                            <span className="text-slate-300">=</span>
                            <span className="text-slate-400">Neto <b className="text-emerald-600 tabular-nums">{clp(p.net)}</b></span>
                          </div>
                          {p.sales.length === 0 ? (
                            <p className="text-xs text-slate-500">
                              Este pago no tiene venta asociada en tu base. Puede ser un cargo administrativo, un reembolso, o requiere re-sincronización.
                            </p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-[10px] uppercase text-slate-400">
                                  <th className="py-1">Orden</th>
                                  <th className="py-1">Cliente</th>
                                  <th className="py-1">Producto</th>
                                  <th className="py-1 text-right">Venta bruta</th>
                                  <th className="py-1 text-right">Neto asignado</th>
                                  <th className="py-1">Documento</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.sales.map((s) => (
                                  <tr key={s.id} className="border-t border-slate-200">
                                    <td className="py-1.5">
                                      <button onClick={() => onOpenOrder(s.id)} className="font-mono text-[11px] text-sky-600 hover:underline">
                                        {s.orderId}
                                      </button>
                                    </td>
                                    <td className="py-1.5 text-slate-600">{s.customer || "—"}</td>
                                    <td className="py-1.5 text-slate-600 truncate max-w-[280px]">{s.title || "—"}</td>
                                    <td className="py-1.5 text-right tabular-nums text-slate-500">{clp(s.gross)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-medium">{clp(s.allocated)}</td>
                                    <td className="py-1.5">
                                      {s.docs.length > 0
                                        ? docLinks(s.docs)
                                        : <span className="text-red-600">Sin doc</span>}
                                    </td>
                                  </tr>
                                ))}
                                <tr className="border-t border-slate-300 font-medium">
                                  <td colSpan={4} className="py-1.5 text-right text-slate-500">Σ neto asignado:</td>
                                  <td className="py-1.5 text-right tabular-nums">{clp(p.allocatedSum)}</td>
                                  <td></td>
                                </tr>
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

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t text-xs text-slate-500">
            <span>Página {safePage + 1} de {totalPages}</span>
            <div className="flex gap-1">
              <button onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}
                className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">Anterior</button>
              <button onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1}
                className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">Siguiente</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500">
      {label}:
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="text-xs border rounded-md py-1 px-2 bg-white focus:outline-none focus:ring-1 focus:ring-slate-300">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}