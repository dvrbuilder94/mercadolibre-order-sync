import { RefreshCw } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

export function DocumentosModuleNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const isList = location.pathname === "/documentos/listado";

  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex bg-slate-100 rounded-lg p-1">
        <button onClick={() => navigate("/documentos")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${!isList ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-800"}`}>Resumen</button>
        <button onClick={() => navigate("/documentos/listado")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${isList ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-800"}`}>Documentos</button>
      </div>
      <button onClick={() => navigate("/sync?domain=documentos")} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border rounded-lg text-slate-600 hover:bg-slate-50">
        <RefreshCw className="h-3.5 w-3.5" /> Sync Documentos
      </button>
    </div>
  );
}
