import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  Home, ShoppingBag, GitMerge, Activity, Settings, LogOut,
  Sparkles, Wrench, Landmark, FileText, Undo2, Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ADV_KEY = "quadra.advancedMode";

const primary = [
  { to: "/resumen",       label: "Resumen",       icon: Home },
  { to: "/ventas",        label: "Ventas",        icon: ShoppingBag },
  { to: "/documentos",    label: "Documentos",    icon: FileText },
  { to: "/liquidaciones", label: "Liquidaciones", icon: Landmark },
  { to: "/devoluciones",  label: "Devoluciones",  icon: Undo2 },
  { to: "/conciliacion",  label: "Conciliación",  icon: GitMerge },
  { to: "/config",        label: "Conexiones",    icon: Settings },
];

const advanced = [
  { to: "/pipeline",     label: "Sincronización", icon: Activity },
  { to: "/arquitectura", label: "Mapa del sistema", icon: Radio },
  { to: "/asistente",    label: "Asistente AI",   icon: Sparkles },
];

export function Nav() {
  const navigate = useNavigate();
  const [adv, setAdv] = useState(false);

  useEffect(() => {
    setAdv(localStorage.getItem(ADV_KEY) === "1");
  }, []);
  const toggleAdv = () => {
    const next = !adv;
    setAdv(next);
    localStorage.setItem(ADV_KEY, next ? "1" : "0");
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  const renderLink = ({ to, label, icon: Icon }: typeof primary[number]) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
          isActive
            ? "bg-slate-100 font-medium text-slate-900"
            : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  );

  return (
    <aside className="w-52 min-h-screen border-r bg-white flex flex-col py-6 px-3 shrink-0">
      <div className="px-3 mb-1">
        <p className="font-bold text-lg leading-none">Quadra</p>
        <p className="text-[10px] uppercase tracking-wider text-slate-400 mt-1">
          Multi-marketplace Ops
        </p>
      </div>

      <nav className="flex flex-col gap-1 flex-1 mt-6">
        {primary.map(renderLink)}

        {adv && (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-3 mt-5 mb-1">
              Avanzado
            </p>
            {advanced.map(renderLink)}
          </>
        )}
      </nav>

      <button
        onClick={toggleAdv}
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-md text-xs transition-colors mb-1",
          adv ? "text-primary hover:bg-slate-50" : "text-slate-400 hover:text-slate-700 hover:bg-slate-50"
        )}
        title="Muestra módulos técnicos: Sincronización, Asistente, Sandbox"
      >
        <Wrench className="h-3.5 w-3.5" />
        Modo avanzado {adv ? "· on" : "· off"}
      </button>

      <button
        onClick={handleLogout}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors"
      >
        <LogOut className="h-4 w-4" />
        Salir
      </button>
    </aside>
  );
}
