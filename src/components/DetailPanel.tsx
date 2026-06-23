import { linkIsVigente } from "@/lib/taxDocs";
import { isRealSale } from "@/lib/orderStatus";

interface LinkedSale {
  order_id: string;
  order_date?: string | null;
  gross_amount?: number | null;
  allocated_amount?: number | null;
  customer_name?: string | null;
  product_title?: string | null;
  channel?: string | null;
  status?: string | null;
  match_source?: string | null;
}

interface Props {
  title: string;
  data: Record<string, any> | null;
  onClose: () => void;
  /** Sales linked to a Bsale document. undefined = not loaded, [] = none, [..] = loaded. */
  linkedSales?: LinkedSale[] | null;
}

const CLP = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const CHANNEL_LABEL: Record<string, string> = {
  meli: "MercadoLibre", falabella: "Falabella", paris: "Paris",
  ripley: "Ripley", amazon: "Amazon", shopify: "Shopify",
  linio: "Linio", rappi: "Rappi", walmart: "Walmart",
};
const channelName = (c: string | null | undefined) => (c ? CHANNEL_LABEL[c] ?? c : "—");

const PCT = (n: number | null | undefined) =>
  n == null ? "—" : `${n}%`;

const DOC_SHORT: Record<string, string> = {
  boleta: "Boleta", factura: "Factura", nota_credito: "N. Créd.",
  nota_debito: "N. Déb.", factura_exenta: "Fact. Ex.",
};
const DOC_LABEL: Record<string, string> = {
  boleta: "Boleta electrónica", factura: "Factura electrónica",
  nota_credito: "Nota de crédito", nota_debito: "Nota de débito",
  factura_exenta: "Factura exenta",
};

function Row({ label, value, highlight }: { label: string; value: any; highlight?: boolean }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-slate-400 shrink-0 w-44 text-xs">{label}</span>
      <span className={`text-xs break-all ${empty ? "text-slate-300 italic" : highlight ? "text-slate-900 font-medium" : "text-slate-700"}`}>
        {empty ? "—" : String(value)}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-slate-400 uppercase tracking-wider text-[10px] font-medium mb-1.5">{title}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

// DTE vigente (no anulado) vinculado a la orden, usando el mismo criterio que
// el resto de la app (src/lib/taxDocs). Soporta la forma to-one de PostgREST
// (objeto o arreglo de un elemento).
function getLinkedDocFromOrder(data: Record<string, any>) {
  const links = (data.order_tax_documents as any[]) ?? [];
  const link = links.find(linkIsVigente);
  if (!link) return null;
  const td = link.tax_documents;
  return Array.isArray(td) ? td[0] : td;
}

type ChainState = "ok" | "warn" | "off" | "na";
const CHAIN_DOT: Record<ChainState, string> = {
  ok: "bg-emerald-500", warn: "bg-amber-400", off: "bg-red-400", na: "bg-slate-300",
};
const CHAIN_TEXT: Record<ChainState, string> = {
  ok: "text-emerald-700", warn: "text-amber-700", off: "text-red-600", na: "text-slate-400",
};

// Cadena de la orden: Venta → Documento (SII) → Liquidación (MP) → Banco.
// Cada paso refleja el dato real que ya trae la orden; "Banco" queda en n/d
// porque esa etapa (Fintoc) todavía no está conectada.
function ChainStrip({ steps }: { steps: { label: string; state: ChainState; note?: string }[] }) {
  return (
    <div className="flex items-stretch gap-1">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-1 flex-1 min-w-0">
          <div className="flex-1 min-w-0 rounded border border-slate-100 bg-slate-50 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${CHAIN_DOT[s.state]}`} />
              <span className="text-[10px] uppercase tracking-wider text-slate-500 truncate">{s.label}</span>
            </div>
            <p className={`text-[10px] mt-0.5 truncate ${CHAIN_TEXT[s.state]}`}>{s.note ?? "—"}</p>
          </div>
          {i < steps.length - 1 && <span className="text-slate-300 text-xs shrink-0">→</span>}
        </div>
      ))}
    </div>
  );
}

function RowLink({ label, href }: { label: string; href: string }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-slate-400 shrink-0 w-44 text-xs">{label}</span>
      <a href={href} target="_blank" rel="noopener noreferrer"
        className="text-xs text-blue-500 hover:underline break-all">
        Abrir ↗
      </a>
    </div>
  );
}

function LinkedSalesSection({ sales, docTotal }: { sales?: LinkedSale[] | null; docTotal?: number | null }) {
  // undefined = caller doesn't supply linked sales → render nothing.
  if (sales === undefined) return null;

  // null = fetch in flight
  if (sales === null) {
    return (
      <Section title="Ventas asociadas">
        <p className="text-xs text-slate-300 italic">Cargando…</p>
      </Section>
    );
  }

  // No linked sales
  if (sales.length === 0) {
    return (
      <Section title="Ventas asociadas">
        <p className="text-xs text-slate-300 italic">Sin ventas vinculadas</p>
      </Section>
    );
  }

  const isPack = sales.length > 1;
  // Pack reconciliation: each sale carries its gross_amount; sum should match doc total.
  const sumGross = sales.reduce((s, v) => s + (Number(v.gross_amount) || 0), 0);
  const total = Number(docTotal) || 0;
  const delta = sumGross - total;
  const cuadra = Math.abs(delta) <= 5;

  return (
    <Section title={`Ventas asociadas (${sales.length})`}>
      {isPack && (
        <div className="flex items-center gap-1.5 mb-2 text-violet-700 bg-violet-50 border border-violet-200 rounded px-2 py-1 w-fit">
          <span className="text-[10px] font-semibold uppercase tracking-wider">Pack · {sales.length} ventas en un documento</span>
        </div>
      )}

      {sales.map((s, i) => (
        <div key={s.order_id ?? i} className="pl-2 border-l-2 border-violet-100 mb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-800 font-medium break-all">{s.order_id}</span>
            <span className="text-xs text-slate-700 tabular-nums shrink-0">{CLP(s.gross_amount)}</span>
          </div>
          {s.product_title && <p className="text-[10px] text-slate-400 truncate">{s.product_title}</p>}
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-slate-400">{channelName(s.channel)}</span>
            {s.order_date && <span className="text-[10px] text-slate-300">· {String(s.order_date).slice(0, 10)}</span>}
            {s.customer_name && <span className="text-[10px] text-slate-300 truncate">· {s.customer_name}</span>}
          </div>
        </div>
      ))}

      {/* Cuadratura: suma de ventas vs total del documento */}
      <div className="mt-1.5 pt-1.5 border-t border-slate-100 space-y-0.5">
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">suma ventas</span>
          <span className="text-slate-700 tabular-nums">{CLP(sumGross)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">total documento</span>
          <span className="text-slate-700 tabular-nums">{CLP(total)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">diferencia</span>
          <span className={`tabular-nums font-medium ${cuadra ? "text-emerald-600" : "text-red-600"}`}>
            {cuadra ? "$0 ✓" : `${delta > 0 ? "+" : ""}${CLP(delta)}`}
          </span>
        </div>
      </div>
    </Section>
  );
}

export function DetailPanel({ title, data, onClose, linkedSales }: Props) {
  if (!data) return null;

  const raw = data.raw_data as any;
  const buyer = raw?.buyer || {};
  const billing = buyer.billing_info || {};
  const payments: any[] = raw?.payments || [];
  const items = raw?.order_items || [];
  const shipping = raw?.shipping || {};

  // Bsale fields
  const refs = raw?.references?.items || [];
  const isBsale = !!data.document_type;

  // ── Cadena de la orden (solo vista de orden ML) ───────────────────────────
  const linkedDoc = isBsale ? null : getLinkedDocFromOrder(data);
  const hasDoc = !!linkedDoc;
  const exact = data.has_exact_data === true;       // neto real confirmado por MercadoPago
  const released = data.money_release_date ? new Date(data.money_release_date) <= new Date() : false;

  const chainSteps: { label: string; state: ChainState; note?: string }[] = [
    {
      label: "Venta",
      state: isRealSale(data.status) ? "ok" : "off",
      note: isRealSale(data.status) ? "registrada" : (data.status ?? "descartada"),
    },
    {
      label: "Documento",
      state: hasDoc ? "ok" : "off",
      note: hasDoc ? (DOC_SHORT[linkedDoc?.document_type] ?? "emitido") : "sin DTE",
    },
    {
      label: "Liquidación",
      state: exact ? "ok" : "warn",
      note: exact ? (released ? "neto liberado" : "neto exacto") : "estimado",
    },
    { label: "Banco", state: "na", note: "Fintoc pausado" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      <div className="relative bg-white w-[440px] h-full shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <h2 className="font-semibold text-sm truncate pr-4">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 font-mono">

          {/* ── ML ORDER ─────────────────────────────── */}
          {!isBsale && (
            <>
              {/* Cadena de la orden de punta a punta */}
              <ChainStrip steps={chainSteps} />

              <Section title="Venta">
                <Row label="order_id"        value={data.order_id} />
                <Row label="fecha"           value={data.order_date?.slice(0, 10)} />
                <Row label="estado"          value={data.status} />
                <Row label="moneda"          value={data.currency_id} />
                <Row label="cuotas"          value={data.installments} />
              </Section>

              {/* ── DOCUMENTO TRIBUTARIO (SII) — leg 1 de la cadena ──────── */}
              <Section title="Documento tributario (SII)">
                {hasDoc ? (
                  <>
                    <Row label="tipo"   value={DOC_LABEL[linkedDoc?.document_type] ?? linkedDoc?.document_type ?? "—"} highlight />
                    <Row label="número" value={linkedDoc?.document_number} />
                    <Row label="estado" value={linkedDoc?.status} />
                    {linkedDoc?.external_url && <RowLink label="ver en Bsale" href={linkedDoc.external_url} />}
                  </>
                ) : (
                  <div className="flex items-center gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 w-fit">
                    <span className="text-[10px] font-semibold uppercase tracking-wider">
                      Sin DTE vigente vinculado
                    </span>
                  </div>
                )}
              </Section>

              {/* ── LIQUIDACIÓN (MercadoPago) — leg 2 de la cadena ────────── */}
              <Section title="Liquidación (MercadoPago)">
                <div className={`flex items-center gap-1.5 mb-1.5 rounded px-2 py-1 w-fit border ${exact ? "text-emerald-700 bg-emerald-50 border-emerald-200" : "text-amber-700 bg-amber-50 border-amber-200"}`}>
                  <span className="text-[10px] font-semibold uppercase tracking-wider">
                    {exact ? "Neto exacto (confirmado por MercadoPago)" : "Neto estimado (aún sin pago confirmado)"}
                  </span>
                </div>
                <Row label="monto bruto"     value={CLP(data.gross_amount)}         highlight />
                <Row label="descuento"       value={CLP(data.discount_amount)} />
                <Row label="envío"           value={CLP(data.shipping_cost)} />
                <Row label="comisión %"      value={PCT(data.commission_percentage)} />
                <Row label="comisión $"      value={CLP(data.commission_amount)} />
                <Row label="monto neto"      value={CLP(data.net_amount)}           highlight />
                <Row label="settlement"      value={CLP(data.settlement_amount)} />
                <Row label="liberación"      value={data.money_release_date?.slice(0, 10)} />
                {Number(data.net_amount) > Number(data.gross_amount) && (
                  <div className="flex items-center gap-1.5 mt-1.5 text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 w-fit">
                    <span className="text-[10px] font-semibold uppercase tracking-wider">
                      ⚠ neto mayor que bruto — revisar pagos abajo
                    </span>
                  </div>
                )}
              </Section>

              {/* Cada intento de pago de la orden, no solo el primero: un intento
                  "rejected" puede convivir con otro aprobado más abajo en el array,
                  que es el que realmente compone el monto neto de arriba. */}
              <Section title={`Pago${payments.length > 1 ? ` (${payments.length} intentos)` : ""}`}>
                <Row label="método"          value={data.payment_method} />
                {payments.length === 0 ? (
                  <Row label="payment_id" value={null} />
                ) : (
                  payments.map((p: any, i: number) => (
                    <div key={p.id ?? i} className="pl-2 border-l border-slate-100 mb-1.5 mt-1">
                      <Row label="payment_id"    value={p.id} />
                      <Row label="estado"        value={p.status}
                        highlight={p.status === "approved"} />
                      <Row label="aprobado"      value={p.date_approved?.slice(0, 10)} />
                      <Row label="money_release" value={p.money_release_date?.slice(0, 10)} />
                    </div>
                  ))
                )}
              </Section>

              <Section title="Comprador">
                <Row label="nickname"        value={buyer.nickname} />
                <Row label="email"           value={buyer.email} />
                <Row label="rut (doc_type)"  value={billing.doc_type} />
                <Row label="rut (doc_number)" value={billing.doc_number}            highlight />
                <Row label="customer_tax_id" value={data.customer_tax_id}           highlight />
              </Section>

              <Section title="Envío">
                <Row label="modo"            value={data.shipping_mode} />
                <Row label="shipping_id"     value={data.shipping_id || shipping.id} />
                <Row label="estado envío"    value={shipping.status} />
              </Section>

              {items.length > 0 && (
                <Section title={`Productos (${items.length})`}>
                  {items.map((item: any, i: number) => (
                    <div key={i} className="pl-2 border-l border-slate-100 mb-1.5">
                      <Row label="título"    value={item.item?.title} />
                      <Row label="sku"       value={item.item?.seller_custom_field} />
                      <Row label="cantidad"  value={item.quantity} />
                      <Row label="precio u." value={CLP(item.unit_price)} />
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}

          {/* ── BSALE DOC ────────────────────────────── */}
          {isBsale && (
            <>
              <Section title="Documento">
                <Row label="tipo"            value={raw?.typeName || data.document_type} />
                <Row label="número"          value={data.document_number} />
                <Row label="fecha"           value={data.document_date} />
                <Row label="estado"          value={data.status} />
                {data.external_url && <RowLink label="ver en Bsale" href={data.external_url} />}
              </Section>

              <Section title="Financiero">
                <Row label="neto"            value={CLP(data.net_amount)} />
                <Row label="IVA"             value={CLP(data.tax_amount)} />
                <Row label="total"           value={CLP(data.total_amount)}          highlight />
              </Section>

              <Section title="Cliente">
                <Row label="RUT"             value={data.client_tax_id}              highlight />
                <Row label="nombre"          value={data.client_name} />
                {raw?.clientNote && <Row label="nota"   value={raw.clientNote} />}
              </Section>

              <Section title="Pago">
                <Row label="método"          value={raw?.payment_method_name || raw?.coin?.name} />
              </Section>

              {refs.length > 0 && (
                <Section title={`Referencias (${refs.length})`}>
                  {refs.map((r: any, i: number) => (
                    <div key={i} className="pl-2 border-l border-slate-100 mb-1.5">
                      <Row label="reason"    value={r.reason} />
                      <Row label="number"    value={r.number} />
                    </div>
                  ))}
                </Section>
              )}

              {raw?.details?.length > 0 && (
                <Section title={`Productos (${raw.details.length})`}>
                  {raw.details.map((d: any, i: number) => (
                    <div key={i} className="pl-2 border-l border-slate-100 mb-1.5">
                      <Row label="descripción" value={d.description} />
                      <Row label="cantidad"    value={d.quantity} />
                      <Row label="neto u."     value={CLP(d.netAmount)} />
                    </div>
                  ))}
                </Section>
              )}

              {/* Ventas asociadas — soporta packs (1 documento ↔ N ventas) */}
              <LinkedSalesSection sales={linkedSales} docTotal={data.total_amount} />
            </>
          )}

        </div>
      </div>
    </div>
  );
}
