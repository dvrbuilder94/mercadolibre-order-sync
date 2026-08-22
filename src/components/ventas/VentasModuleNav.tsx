import { useLocation, useNavigate } from "react-router-dom";

export function VentasModuleNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const isList = location.pathname === "/ventas/listado";

  return (
    <div className="inline-flex bg-slate-100 rounded-lg p-1">
      <button
        onClick={() => navigate("/ventas")}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          !isList ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-800"
        }`}
      >
        Resumen
      </button>
      <button
        onClick={() => navigate("/ventas/listado")}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          isList ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-800"
        }`}
      >
        Ventas
      </button>
    </div>
  );
}
