import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { MessageSquarePlus, X, Send, Loader2, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { moduleFromPath } from "@/lib/modules";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  message: string;
  status: string;
  admin_note: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  en_revision: "En revisión",
  resuelto: "Resuelto",
  descartado: "Descartado",
};

export function FeedbackWidget() {
  const location = useLocation();
  const modulo = moduleFromPath(location.pathname);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    const { data } = await supabase
      .from("feedback")
      .select("id, message, status, admin_note, created_at")
      .eq("module", modulo)
      .order("created_at", { ascending: true })
      .limit(50);
    setItems((data as Item[]) ?? []);
  };

  useEffect(() => {
    if (open) { load(); setTimeout(() => inputRef.current?.focus(), 50); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modulo]);

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setSending(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Debe iniciar sesión para enviar comentarios.");
      const { error } = await supabase.from("feedback").insert({
        user_id: user.id,
        user_email: user.email,
        module: modulo,
        route: location.pathname,
        message,
      });
      if (error) throw error;
      setText("");
      await load();
      toast({ title: "Comentario registrado", description: "Queda guardado para revisión." });
    } catch (e: any) {
      toast({ title: "No se pudo guardar", description: e.message, variant: "destructive" });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-slate-900 px-4 py-3 text-xs font-medium text-white shadow-lg transition-colors hover:bg-emerald-600"
          title={`Dejar comentario sobre ${modulo}`}
        >
          <MessageSquarePlus className="h-4 w-4" />
          Comentarios
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-50 flex h-[28rem] w-[22rem] flex-col rounded-xl border bg-white shadow-2xl">
          <header className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Comentarios</p>
              <p className="text-[11px] text-slate-400">Módulo: {modulo}</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {items.length === 0 && (
              <p className="text-xs leading-relaxed text-slate-400">
                Escriba aquí lo que falta o no se visualiza en este módulo. Sus observaciones quedan
                registradas para revisión.
              </p>
            )}
            {items.map((it) => (
              <div key={it.id} className="space-y-1">
                <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-none bg-slate-900 px-3 py-2 text-xs leading-relaxed text-slate-100">
                  {it.message}
                </div>
                <div className="flex items-center justify-end gap-1 text-[10px] text-slate-400">
                  <span>{new Date(it.created_at).toLocaleString("es-CL")}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5",
                      it.status === "resuelto"
                        ? "bg-emerald-50 text-emerald-600"
                        : it.status === "en_revision"
                        ? "bg-blue-50 text-blue-600"
                        : it.status === "descartado"
                        ? "bg-slate-100 text-slate-500"
                        : "bg-amber-50 text-amber-600"
                    )}
                  >
                    {STATUS_LABEL[it.status] ?? it.status}
                  </span>
                </div>
                {it.admin_note && (
                  <div className="max-w-[90%] rounded-2xl rounded-tl-none border bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700">
                    <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold text-emerald-600">
                      <CheckCircle2 className="h-3 w-3" /> Respuesta
                    </span>
                    {it.admin_note}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-end gap-2 border-t p-3">
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={2}
              placeholder="Ej.: falta el total de comisiones en esta vista…"
              className="flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button
              onClick={send}
              disabled={sending || !text.trim()}
              className="rounded-lg bg-slate-900 p-2 text-white transition-colors hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
    </>
  );
}