interface Props {
  title: string;
  data: Record<string, any> | null;
  onClose: () => void;
}

const SKIP = ["raw_data", "order_tax_documents"];

function renderValue(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "number") return v.toLocaleString("es-CL");
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

function isLong(v: any) {
  return typeof v === "object" && v !== null;
}

export function DetailPanel({ title, data, onClose }: Props) {
  if (!data) return null;

  const simple = Object.entries(data).filter(([k]) => !SKIP.includes(k) && !isLong(data[k]));
  const raw    = data.raw_data;

  // Key fields from raw_data we actually care about
  const rawFields: [string, any][] = [];
  if (raw) {
    if (raw.buyer) {
      rawFields.push(["buyer.nickname",        raw.buyer.nickname]);
      rawFields.push(["buyer.email",           raw.buyer.email]);
      rawFields.push(["buyer.billing.doc_type",   raw.buyer.billing_info?.doc_type]);
      rawFields.push(["buyer.billing.doc_number", raw.buyer.billing_info?.doc_number]);
    }
    if (raw.payments?.length) {
      rawFields.push(["payment.method",    raw.payments[0]?.payment_method_id]);
      rawFields.push(["payment.status",    raw.payments[0]?.status]);
      rawFields.push(["payment.amount",    raw.payments[0]?.transaction_amount]);
      rawFields.push(["payment.approved",  raw.payments[0]?.date_approved]);
      rawFields.push(["payment.release",   raw.payments[0]?.money_release_date]);
    }
    if (raw.order_items?.length) {
      raw.order_items.forEach((item: any, i: number) => {
        rawFields.push([`item[${i}].title`, item.item?.title]);
        rawFields.push([`item[${i}].qty`,   item.quantity]);
        rawFields.push([`item[${i}].price`, item.unit_price]);
      });
    }
    // Bsale raw fields
    if (raw.references) {
      const refs = raw.references?.items || [];
      refs.forEach((r: any, i: number) => {
        rawFields.push([`ref[${i}].reason`, r.reason]);
        rawFields.push([`ref[${i}].number`, r.number]);
      });
    }
    if (raw.payment_method_name) rawFields.push(["payment_method_name", raw.payment_method_name]);
    if (raw.reference_reason)    rawFields.push(["reference_reason",    raw.reference_reason]);
    if (raw.external_order_id)   rawFields.push(["external_order_id",   raw.external_order_id]);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-white w-[420px] h-full shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-sm">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6 font-mono text-xs">

          {/* DB fields */}
          <div>
            <p className="text-slate-400 uppercase tracking-wider text-[10px] mb-2">Datos guardados</p>
            <div className="space-y-1">
              {simple.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-slate-400 shrink-0 w-40">{k}</span>
                  <span className="text-slate-800 break-all">{renderValue(v)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Raw API fields */}
          {rawFields.length > 0 && (
            <div>
              <p className="text-slate-400 uppercase tracking-wider text-[10px] mb-2">Datos de la API</p>
              <div className="space-y-1">
                {rawFields.map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-slate-400 shrink-0 w-40">{k}</span>
                    <span className={`break-all ${v === null || v === undefined ? "text-slate-300 italic" : "text-slate-800"}`}>
                      {renderValue(v)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
