import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { CHANNEL_COLOR } from "@/lib/constants";
import { channelLabel, clp, docTypeLabel, TesoreriaPayment, TesoreriaPaymentRaw, toTesoreriaPayment } from "@/lib/tesoreria";

const PAGE_SIZE = 50;
type MatchFilter = "all" | "matched" | "partial" | "orphan";
type Response = { rows: TesoreriaPaymentRaw[]; total: number; providers: string[]; channels: string[]; methods: string[]; };

export function TesoreriaDetalleFast({ period, initialMatchFilter = "all", onOpenOrder }: { period: string; initialMatchFilter?: MatchFilter; onOpenOrder: (id: string) => void }) {
  const [match, setMatch] = useState<MatchFilter>(initialMatchFilter);
  const [provider, setProvider] = useState("all");
  const [channel, setChannel] = useState("all");
  const [method, setMethod] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Response>({ rows: [], total: 0, providers: [], channels: [], methods: [] });
  useEffect(() => { setMatch(initialMatchFilter); setPage(0); }, [initialMatchFilter]);
  useEffect(() => { const t=window.setTimeout(()=>setSearch(searchInput.trim()),300); return ()=>window.clearTimeout(t); }, [searchInput]);
  useEffect(() => { setPage(0); }, [period, match, provider, channel, method, search]);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const { data: rpc, error } = await (supabase as any).rpc("get_tesoreria_page", { p_period: period, p_match: match, p_provider: provider, p_channel: channel, p_method: method, p_search: search, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE });
      if (error) throw error;
      setData({ rows: Array.isArray(rpc?.rows) ? rpc.rows : [], total: Number(rpc?.total || 0), providers: Array.isArray(rpc?.providers) ? rpc.providers.filter(Boolean).sort() : [], channels: Array.isArray(rpc?.channels) ? rpc.channels.filter(Boolean).sort() : [], methods: Array.isArray(rpc?.methods) ? rpc.methods.filter(Boolean).sort() : [] });
    } catch (e) { console.error("Error cargando movimientos de tesorería:", e); setData((d) => ({ ...d, rows: [], total: 0 })); }
    finally { setLoading(false); }
  }, [period, match, provider, channel, method, search, page]);

  useEffect(() => { fetchPage(); }, [fetchPage]);
  const payments = useMemo(() => data.rows.map(toTesoreriaPayment), [data.rows]);
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return <div className="space-y-3">
    <div className="bg-white border rounded-xl p-3 flex flex-wrap gap-2 items-center"><div className="relative"><Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/><input value={searchInput} onChange={(e)=>setSearchInput(e.target.value)} placeholder="Payment ID, orden, cliente…" className="text-xs pl-7 pr-3 py-1.5 border rounded-md w-64 focus:outline-none focus:ring-1 focus:ring-slate-300"/></div><Select value={match} onChange={(v)=>setMatch(v as MatchFilter)} options={[["all","Todos"],["matched","Completo"],["partial","Parcial"],["orphan","Sin matchear"]]}/><Select value={provider} onChange={setProvider} options={[["all","Todas las pasarelas"],...data.providers.map(x=>[x,x] as [string,string])]}/><Select value={channel} onChange={setChannel} options={[["all","Todos los canales"],...data.channels.map(x=>[x,channelLabel(x)] as [string,string])]}/><Select value={method} onChange={setMethod} options={[["all","Todos los medios"],...data.methods.map(x=>[x,x] as [string,string])]}/><span className="ml-auto text-xs text-slate-400">{data.total.toLocaleString("es-CL")} pagos</span></div>
    <div className="bg-white border rounded-xl overflow-x-auto"><table className="w-full text-sm min-w-[1100px]"><thead><tr className="border-b bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400"><Th>Fecha</Th><Th>ID pago</Th><Th>Pasarela</Th><Th>Canal</Th><Th>Bruto</Th><Th>Comisión</Th><Th>Neto</Th><Th>Ventas</Th><Th>Documento</Th><Th>Match</Th></tr></thead><tbody>{loading?<tr><td colSpan={10} className="py-16 text-center text-slate-400"><Loader2 className="h-4 w-4 animate-spin inline mr-2"/>Cargando…</td></tr>:payments.length===0?<tr><td colSpan={10} className="py-16 text-center text-slate-400">Sin movimientos para estos filtros.</td></tr>:payments.map((p)=><Row key={p.id} payment={p} onOpenOrder={onOpenOrder}/>)}</tbody></table></div>
    {pages>1&&<div className="flex items-center justify-between text-xs text-slate-400"><span>Página {page+1} de {pages}</span><div className="flex gap-2"><button className="px-3 py-1.5 border bg-white rounded disabled:opacity-40" disabled={page===0||loading} onClick={()=>setPage(p=>Math.max(0,p-1))}><ChevronLeft className="h-3.5 w-3.5 inline"/> Anterior</button><button className="px-3 py-1.5 border bg-white rounded disabled:opacity-40" disabled={page>=pages-1||loading} onClick={()=>setPage(p=>Math.min(pages-1,p+1))}>Siguiente <ChevronRight className="h-3.5 w-3.5 inline"/></button></div></div>}
  </div>;
}

function Row({payment:p,onOpenOrder}:{payment:TesoreriaPayment;onOpenOrder:(id:string)=>void}){return <tr className="border-b last:border-0 align-top hover:bg-slate-50"><Td>{String(p.paymentDate).slice(0,10)}</Td><Td><span className="font-mono text-xs">{p.paymentId}</span></Td><Td>{p.provider}</Td><Td>{p.channels.length?<div className="flex flex-wrap gap-1">{p.channels.map(ch=><span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded ${CHANNEL_COLOR[ch]||"bg-slate-100 text-slate-600"}`}>{channelLabel(ch)}</span>)}</div>:"—"}</Td><Td className="text-right">{clp(p.gross)}</Td><Td className="text-right text-slate-500">{p.fees?`-${clp(p.fees)}`:"—"}</Td><Td className="text-right font-semibold">{clp(p.net)}</Td><Td>{p.sales.length===0?<span className="text-slate-300">0</span>:<div className="space-y-1">{p.sales.slice(0,3).map(s=><button key={s.id} onClick={()=>onOpenOrder(s.id)} className="block text-xs text-sky-600 hover:underline">{s.orderId}</button>)}{p.sales.length>3&&<span className="text-[10px] text-slate-400">+{p.sales.length-3} más</span>}</div>}</Td><Td>{p.docs.length===0?<span className="text-xs text-slate-400">—</span>:<div>{p.docs.slice(0,2).map(d=>d.url?<a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="block text-[11px] text-sky-600 hover:underline">{docTypeLabel(d.type)} {d.number}<ExternalLink className="h-3 w-3 inline ml-1"/></a>:<span key={d.id} className="block text-[11px]">{docTypeLabel(d.type)} {d.number}</span>)}</div>}</Td><Td><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${p.matchState==="matched"?"bg-emerald-100 text-emerald-700":p.matchState==="partial"?"bg-amber-100 text-amber-700":"bg-red-100 text-red-700"}`}>{p.matchState==="matched"?"Completo":p.matchState==="partial"?"Parcial":"Sin matchear"}</span></Td></tr>}
function Select({value,onChange,options}:{value:string;onChange:(v:string)=>void;options:[string,string][]}){return <select value={value} onChange={(e)=>onChange(e.target.value)} className="text-xs px-2.5 py-1.5 border rounded-md bg-white text-slate-600">{options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>}
function Th({children}:{children:ReactNode}){return <th className="px-3 py-3 text-left font-medium">{children}</th>}
function Td({children,className=""}:{children:ReactNode;className?:string}){return <td className={`px-3 py-3 text-xs text-slate-600 ${className}`}>{children}</td>}
