interface Props {
  title: string;
  data: Record<string, any> | null;
  onClose: () => void;
}

const CLP = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const PCT = (n: number | null | undefined) =>
  n == null ? "—" : `${n}%`;

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

export function DetailPanel({ title, data, onClose }: Props) {
  if (!data) return null;

  const raw = data.raw_data as any;
  const buyer = raw?.buyer || {};
  const billing = buyer.billing_info || {};
  const payment = raw?.payments?.[0] || {};
  const items = raw?.order_items || [];
  const shipping = raw?.shipping || {};

  // Bsale fields
  const refs = raw?.references?.items || [];
  const isBsale = !!data.document_type;

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
              <Section title="Venta">
                <Row label="order_id"        value={data.order_id} />
                <Row label="fecha"           value={data.order_date?.slice(0, 10)} />
                <Row label="estado"          value={data.status} />
                <Row label="moneda"          value={data.currency_id} />
                <Row label="cuotas"          value={data.installments} />
              </Section>

              <Section title="Financiero">
                <Row label="monto bruto"     value={CLP(data.gross_amount)}         highlight />
                <Row label="descuento"       value={CLP(data.discount_amount)} />
                <Row label="envío"           value={CLP(data.shipping_cost)} />
                <Row label="comisión %"      value={PCT(data.commission_percentage)} />
                <Row label="comisión $"      value={CLP(data.commission_amount)} />
                <Row label="monto neto"      value={CLP(data.net_amount)}           highlight />
                <Row label="settlement"      value={CLP(data.settlement_amount)} />
                <Row label="pago estimado"   value={data.money_release_date?.slice(0, 10)} />
              </Section>

              <Section title="Pago">
                <Row label="método"          value={data.payment_method} />
                <Row label="payment_id"      value={payment.id} />
                <Row label="estado pago"     value={payment.status} />
                <Row label="aprobado"        value={payment.date_approved?.slice(0, 10)} />
                <Row label="money_release"   value={payment.money_release_date?.slice(0, 10)} />
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

              {raw?.external_order_id && (
                <Section title="Vinculación">
                  <Row label="order ML"      value={raw.external_order_id}           highlight />
                </Section>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
