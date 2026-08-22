import type { ReactNode } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { clp, channelLabel } from "@/lib/tesoreria";

export type TesoreriaSummary = {
  count: number;
  gross: number;
  fees: number;
  net: number;
  released_net: number;
  pending_net: number;
  matched_count: number;
  partial_count: number;
  orphan_count: number;
  orphan_amount: number;
  unpaid_sales: number;
  unpaid_amount: number;
  paid_without_dte: number;
  daily: { date: string; net: number }[];
  methods: { name: string; value: number }[];
  channels: { name: string; value: number }[];
  upcoming: { date: string; count: number; net: number }[];
};

const COLORS = ["#0ea5e9", "#14b8a6", "#f59e0b", "#a855f7", "#ef4444", "#64748b"];

export function TesoreriaResumenFast({ summary, onJumpToDetail }: { summary: TesoreriaSummary; onJumpToDetail: (filter: "orphan" | "partial") => void }) {
  const matchedPct = summary.count > 0 ? Math.round((summary.matched_count / summary.count) * 100) : 0;
  const feesPct = summary.gross > 0 ? Math.round((summary.fees / summary.gross) * 100) : 0;
  const other = summary.gross - summary.fees - summary.net;
  const otherPct = summary.gross > 0 ? Math.round((other / summary.gross) * 100) : 0;
  const netPct = summary.gross > 0 ? Math.round((summary.net / summary.gross) * 100) : 0;
  const daily = (summary.daily || []).map((x) => ({ date: String(x.date).slice(5, 10), net: Number(x.net || 0) }));
  const methods = (summary.methods || []).map((x) => ({ name: x.name, value: Number(x.value || 0) }));
  const channels = (summary.channels || []).map((x) => ({ name: channelLabel(x.name), value: Number(x.value || 0) }));

  return <div className="space-y-5">
    <div className="bg-white border rounded-xl p-4"><p className="text-sm font-semibold text-slate-700 mb-3">Del bruto a tu bolsillo</p><div className="flex items-center gap-3 flex-wrap text-sm"><Bridge label="Bruto" value={clp(summary.gross)} /><span className="text-slate-300">−</span><Bridge label="Comisiones" value={clp(summary.fees)} sub={`${feesPct}%`} tone="red" /><span className="text-slate-300">−</span><Bridge label="Otros descuentos" value={clp(other)} sub={`${otherPct}%`} tone="red" /><span className="text-slate-300">=</span><Bridge label="Neto aprobado" value={clp(summary.net)} sub={`${netPct}%`} tone="green" /></div></div>
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3"><Kpi title="Neto aprobado" value={clp(summary.net)} hint={`${summary.count} pagos`} /><Kpi title="Liberado" value={clp(summary.released_net)} hint={`${clp(summary.pending_net)} pendiente`} tone="green" /><Kpi title="Match local" value={`${matchedPct}%`} hint={`${summary.orphan_count} sin venta · ${summary.partial_count} parciales`} onClick={summary.orphan_count ? () => onJumpToDetail("orphan") : undefined} /><Kpi title="Ventas sin pago" value={String(summary.unpaid_sales)} hint={`${clp(summary.unpaid_amount)} bruto`} tone={summary.unpaid_sales ? "amber" : "green"} /><Kpi title="Pagadas sin DTE" value={String(summary.paid_without_dte)} hint="venta con pago y sin documento vigente" tone={summary.paid_without_dte ? "amber" : "green"} /></div>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4"><Chart title="Neto por día" className="lg:col-span-2">{daily.length===0?<Empty/>:<ResponsiveContainer width="100%" height={230}><BarChart data={daily}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/><XAxis dataKey="date" tick={{fontSize:11}}/><YAxis tickFormatter={(v)=>`${Math.round(v/1000)}k`} tick={{fontSize:11}}/><Tooltip formatter={(v:any)=>clp(Number(v))}/><Bar dataKey="net" fill="#0ea5e9" radius={[3,3,0,0]}/></BarChart></ResponsiveContainer>}</Chart><Chart title="Por medio de pago">{methods.length===0?<Empty/>:<ResponsiveContainer width="100%" height={230}><PieChart><Pie data={methods} dataKey="value" nameKey="name" innerRadius={42} outerRadius={72}>{methods.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}</Pie><Tooltip formatter={(v:any)=>clp(Number(v))}/><Legend wrapperStyle={{fontSize:11}}/></PieChart></ResponsiveContainer>}</Chart></div>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4"><Chart title="Por canal">{channels.length===0?<Empty/>:<ResponsiveContainer width="100%" height={220}><BarChart data={channels} layout="vertical"><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/><XAxis type="number" tickFormatter={(v)=>`${Math.round(v/1000)}k`} tick={{fontSize:11}}/><YAxis dataKey="name" type="category" width={90} tick={{fontSize:11}}/><Tooltip formatter={(v:any)=>clp(Number(v))}/><Bar dataKey="value" fill="#14b8a6" radius={[0,3,3,0]}/></BarChart></ResponsiveContainer>}</Chart><div className="lg:col-span-2 bg-white border rounded-xl p-4"><h3 className="text-sm font-semibold text-slate-700 mb-3">Próximas liberaciones</h3>{(summary.upcoming||[]).length===0?<p className="text-xs text-slate-400">Sin liberaciones futuras pendientes.</p>:<table className="w-full text-sm"><thead><tr className="text-[11px] uppercase text-slate-400 border-b"><th className="py-2 text-left font-medium">Fecha</th><th className="py-2 text-right font-medium">Pagos</th><th className="py-2 text-right font-medium">Neto</th></tr></thead><tbody>{summary.upcoming.slice(0,10).map((r)=><tr key={r.date} className="border-b last:border-0"><td className="py-2">{String(r.date).slice(0,10)}</td><td className="py-2 text-right text-slate-500">{r.count}</td><td className="py-2 text-right font-medium">{clp(r.net)}</td></tr>)}</tbody></table>}</div></div>
    <div className="bg-white border rounded-xl p-4 flex items-center justify-between gap-4"><div><p className="text-sm font-medium text-slate-700">Matching pagos ↔ ventas</p><p className="text-xs text-slate-400 mt-1">Este diagnóstico usa solo datos ya persistidos. Para actualizar la fuente usa Sync Pagos.</p></div><div className="text-right text-xs text-slate-500"><div>{summary.orphan_count} sin matchear · {clp(summary.orphan_amount)}</div>{summary.partial_count>0&&<button className="text-sky-600 hover:underline mt-1" onClick={()=>onJumpToDetail("partial")}>Ver {summary.partial_count} parciales</button>}</div></div>
  </div>;
}

function Kpi({title,value,hint,tone="slate",onClick}:{title:string;value:string;hint:string;tone?:"slate"|"green"|"amber";onClick?:()=>void}){const c=tone==="green"?"text-emerald-600":tone==="amber"?"text-amber-600":"text-slate-900";return <button type="button" onClick={onClick} className={`bg-white border rounded-xl p-4 text-left ${onClick?"hover:border-slate-400 cursor-pointer":"cursor-default"}`}><p className="text-[11px] uppercase tracking-wide text-slate-400">{title}</p><p className={`text-xl font-bold mt-1 ${c}`}>{value}</p><p className="text-[11px] text-slate-400 mt-1">{hint}</p></button>}
function Bridge({label,value,sub,tone}:{label:string;value:string;sub?:string;tone?:"red"|"green"}){return <div><p className="text-[11px] text-slate-400">{label}</p><p className={`font-semibold ${tone==="red"?"text-red-600":tone==="green"?"text-emerald-600":"text-slate-900"}`}>{value}</p>{sub&&<p className="text-[10px] text-slate-400">{sub}</p>}</div>}
function Chart({title,children,className=""}:{title:string;children:ReactNode;className?:string}){return <div className={`bg-white border rounded-xl p-4 ${className}`}><h3 className="text-sm font-semibold text-slate-700 mb-3">{title}</h3>{children}</div>}
function Empty(){return <div className="h-[220px] flex items-center justify-center text-xs text-slate-400">Sin datos</div>}
