import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useToast } from "@/hooks/use-toast";
import { Loader2, MessageSquare, Trash2, ShieldAlert } from "lucide-react";

interface Row {
  id: string;
  user_email: string | null;
  module: string;
  route: string | null;
  message: string;
  status: string;
  admin_note: string | null;
  created_at: string;
}

const STATUSES = [
  { value: "pendiente", label: "Pendiente" },
  { value: "en_revision", label: "En revisión" },
  { value: "resuelto", label: "Resuelto" },
  { value: "descartado", label: "Descartado" },
];

export default function PageFeedback() {
  const { isAdmin, loading: loadingRole } = useIsAdmin();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("todos");
  const [moduleFilter, setModuleFilter] = useState<string>("todos");

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("feedback")
      .select("id, user_email, module, route, message, status, admin_note, created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) toast({ title: "Error al cargar", description: error.message, variant: "destructive" });
    setRows((data as Row[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const modules = useMemo(
    () => Array.from(new Set(rows.map((r) => r.module))).sort(),
    [rows]
  );

  const visible = rows.filter(
    (r) =>
      (filter === "todos" || r.status === filter) &&
      (moduleFilter === "todos" || r.module === moduleFilter)
  );

  const updateRow = async (id: string, patch: Partial<Row>) => {
    const { error } = await supabase.from("feedback").update(patch as never).eq("id", id);
    if (error) return toast({ title: "No se pudo actualizar", description: error.message, variant: "destructive" });
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = async (id: string) => {
    const { error } = await supabase.from("feedback").delete().eq("id", id);
    if (error) return toast({ title: "No se pudo eliminar", description: error.message, variant: "destructive" });
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 overflow-x-hidden">
        <header className="flex h-16 items-center gap-2.5 border-b bg-white px-6">
          <MessageSquare className="h-5 w-5 text-emerald-600" />
          <div>
            <h1 className="text-base font-semibold text-slate-950">Comentarios de usuarios</h1>
            <p className="text-[11px] text-slate-400">Observaciones registradas por módulo</p>
          </div>
        </header>

        {loadingRole ? (
          <div className="p-6 text-sm text-slate-400">Cargando…</div>
        ) : !isAdmin ? (
          <div className="m-6 flex items-start gap-2 rounded-lg border bg-white p-4 text-sm text-slate-600">
            <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-500" />
            Esta vista está reservada para la administración. Sus propios comentarios se muestran en el
            panel de cada módulo.
          </div>
        ) : (
          <div className="space-y-4 p-6">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs"
              >
                <option value="todos">Todos los estados</option>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <select
                value={moduleFilter}
                onChange={(e) => setModuleFilter(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs"
              >
                <option value="todos">Todos los módulos</option>
                {modules.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <span className="text-xs text-slate-400">{visible.length} registro(s)</span>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando comentarios…
              </div>
            ) : visible.length === 0 ? (
              <p className="text-sm text-slate-400">Sin comentarios registrados.</p>
            ) : (
              <div className="space-y-3">
                {visible.map((r) => (
                  <div key={r.id} className="rounded-lg border bg-white p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                        {r.module}
                      </span>
                      <span>{r.user_email ?? "—"}</span>
                      <span>{new Date(r.created_at).toLocaleString("es-CL")}</span>
                      {r.route && <span className="text-slate-300">{r.route}</span>}
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{r.message}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select
                        value={r.status}
                        onChange={(e) => updateRow(r.id, { status: e.target.value })}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs"
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                      <input
                        defaultValue={r.admin_note ?? ""}
                        onBlur={(e) => {
                          if (e.target.value !== (r.admin_note ?? "")) {
                            updateRow(r.id, { admin_note: e.target.value });
                          }
                        }}
                        placeholder="Respuesta o nota interna…"
                        className="flex-1 min-w-[12rem] rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                      />
                      <button
                        onClick={() => removeRow(r.id)}
                        className="rounded-md border border-slate-200 p-1.5 text-slate-400 hover:text-red-600"
                        title="Eliminar"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}