import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { Nav } from "@/components/Nav";
import DocumentosResumen from "@/components/documentos/DocumentosResumen";
import { supabase } from "@/integrations/supabase/client";
import { chilePeriodNow } from "@/lib/chileDate";
import { CHANNEL_LABEL } from "@/lib/constants";

const ALL_CHANNELS = Object.keys(CHANNEL_LABEL);

const periodLabel = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return format(new Date(y, m - 1, 1), "MMMM yyyy", { locale: es });
};

export default function PageDocumentosResumen() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState(chilePeriodNow);
  const [channelFilter, setChannelFilter] = useState("todos");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
    });
  }, [navigate]);

  const changePeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    setPeriod(format(new Date(y, m - 1 + delta, 1), "yyyy-MM"));
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-slate-400" />
              <h1 className="text-2xl font-semibold text-slate-900">Documentos</h1>
            </div>
            <p className="text-sm text-slate-400 mt-1">Control tributario: qué ventas están documentadas, cuáles faltan y qué DTE no se pueden explicar.</p>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => changePeriod(-1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-base font-semibold capitalize w-40 text-center">{periodLabel(period)}</span>
            <button onClick={() => changePeriod(1)} className="p-1 hover:bg-slate-200 rounded">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <div className="inline-flex bg-slate-100 rounded-lg p-1">
            <button className="px-4 py-2 text-sm font-medium rounded-md bg-white shadow-sm text-slate-900">Resumen</button>
            <button onClick={() => navigate("/documentos/listado")} className="px-4 py-2 text-sm font-medium rounded-md text-slate-500 hover:text-slate-800">Documentos</button>
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            {["todos", ...ALL_CHANNELS].map((ch) => (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  channelFilter === ch
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"
                }`}
              >
                {ch === "todos" ? "Todos" : (CHANNEL_LABEL[ch] ?? ch)}
              </button>
            ))}
          </div>
        </div>

        <DocumentosResumen
          period={period}
          channelFilter={channelFilter}
          onReview={() => navigate("/conciliacion")}
        />
      </main>
    </div>
  );
}
