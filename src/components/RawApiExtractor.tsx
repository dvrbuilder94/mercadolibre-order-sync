import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Download, FileJson, RotateCw } from "lucide-react";

type Source = "meli" | "bsale";

interface Job {
  id: string;
  source: Source;
  period: string;
  status: "pending" | "running" | "done" | "error";
  current_step: string | null;
  progress: number;
  total: number;
  file_path: string | null;
  file_size_bytes: number | null;
  error_message: string | null;
  updated_at: string;
}

interface Props {
  period: string;
  onLog?: (msg: string) => void;
}

const labels: Record<Source, string> = {
  meli: "Mercado Libre",
  bsale: "Bsale",
};

function SourceCard({ source, period, onLog }: { source: Source; period: string; onLog?: (m: string) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef<number | null>(null);

  const fetchStatus = useCallback(async (jobId?: string) => {
    const params: any = { source, period };
    if (jobId) params.job_id = jobId;
    const { data, error } = await supabase.functions.invoke("raw-extract-status", { body: params });
    if (error) {
      onLog?.(`⚠ Raw API ${labels[source]}: status error (${error.message || "?"})`);
      return;
    }
    if (data?.job) setJob(data.job);
    if (data?.download_url) setDownloadUrl(data.download_url);
    else if (data?.job?.status === "done") {
      onLog?.(`⚠ Raw API ${labels[source]}: job listo pero sin URL (file_path=${data.job.file_path || "null"})`);
    }
  }, [source, period, onLog]);

  // Load latest job for this source+period
  useEffect(() => {
    setJob(null);
    setDownloadUrl(null);
    fetchStatus();
  }, [fetchStatus]);

  // Polling while running
  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (job && (job.status === "running" || job.status === "pending")) {
      pollRef.current = window.setInterval(() => fetchStatus(job.id), 2000);
    }
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [job?.id, job?.status, fetchStatus]);

  const launch = async () => {
    setLaunching(true);
    setDownloadUrl(null);
    onLog?.(`› Raw API ${labels[source]}: iniciando extracción de ${period}...`);
    try {
      const fn = source === "meli" ? "raw-extract-meli" : "raw-extract-bsale";
      const { data, error } = await supabase.functions.invoke(fn, { body: { period } });
      if (error) throw error;
      onLog?.(`✓ Raw API ${labels[source]}: job ${data?.job_id?.slice(0, 8)} en curso`);
      await fetchStatus(data?.job_id);
    } catch (e: any) {
      onLog?.(`❌ Raw API ${labels[source]}: ${e?.message || "error"}`);
    } finally {
      setLaunching(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadUrl) return;
    setDownloading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const isEdgeFn = downloadUrl.includes("/functions/v1/");
      const finalUrl = isEdgeFn && session?.access_token
        ? `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(session.access_token)}`
        : downloadUrl;
      const anchor = document.createElement("a");
      anchor.href = finalUrl;
      anchor.download = `${source}-${period}.json`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      onLog?.(`✓ Raw API ${labels[source]}: descarga iniciada`);
    } catch (e: any) {
      onLog?.(`❌ Raw API ${labels[source]}: no se pudo descargar (${e?.message || "error"})`);
    } finally {
      setDownloading(false);
    }
  };

  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.progress / job.total) * 100)) : 0;
  const running = job?.status === "running" || job?.status === "pending";
  const sizeMB = job?.file_size_bytes ? (job.file_size_bytes / 1024 / 1024).toFixed(2) : null;

  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-800 flex items-center gap-2">
            <FileJson className="h-4 w-4 text-slate-500" />
            Raw API — {labels[source]}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            JSON crudo de la API de {labels[source]} para {period}. Corre en background, sin timeout.
          </p>
        </div>
        <button
          onClick={launch}
          disabled={launching || running}
          className="shrink-0 flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white text-sm font-medium rounded-lg"
        >
          {launching || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          {running ? "Corriendo" : job?.status === "done" ? "Re-extraer" : "Extraer"}
        </button>
      </div>

      {job && (
        <div className="mt-3">
          {running && (
            <>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${pct || 5}%` }}
                />
              </div>
              <p className="text-xs text-slate-500 mt-1.5">
                {job.current_step || "Trabajando..."}
                {job.total > 0 && ` · ${job.progress}/${job.total}`}
              </p>
            </>
          )}
          {job.status === "done" && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-green-700">
                ✓ {job.current_step}{sizeMB ? ` · ${sizeMB} MB` : ""}
              </p>
              {downloadUrl ? (
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium rounded"
                >
                  {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Descargar JSON
                </button>
              ) : (
                <button
                  onClick={() => fetchStatus(job.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-600 hover:bg-slate-700 text-white text-xs font-medium rounded"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Generar enlace
                </button>
              )}
            </div>
          )}
          {job.status === "error" && (
            <p className="text-xs text-red-600">❌ {job.error_message || "Error desconocido"}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function RawApiExtractor({ period, onLog }: Props) {
  return (
    <div className="bg-white border rounded-lg p-4 mb-8">
      <p className="text-sm font-medium text-slate-800 mb-1">Raw API (auditoría con Claude)</p>
      <p className="text-xs text-slate-500 mb-3">
        Trae la data tal como la devuelven Mercado Libre y Bsale para {period}. Un JSON por sistema, sin transformar.
      </p>
      <div className="grid md:grid-cols-2 gap-3">
        <SourceCard source="meli" period={period} onLog={onLog} />
        <SourceCard source="bsale" period={period} onLog={onLog} />
      </div>
    </div>
  );
}