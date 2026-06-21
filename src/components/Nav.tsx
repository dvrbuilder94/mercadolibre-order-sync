import { NavLink, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Home, ShoppingBag, GitMerge, Activity, Settings, LogOut, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { to: "/resumen",      label: "Resumen",       icon: Home },
  { to: "/ventas",       label: "Ventas",         icon: ShoppingBag },
  { to: "/conciliacion", label: "Conciliación",  icon: GitMerge },
  { to: "/pipeline",     label: "Sincronización", icon: Activity },
  { to: "/asistente",    label: "Asistente AI",   icon: Sparkles },
  { to: "/config",       label: "Configuración", icon: Settings },
];

export function Nav() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  return (
    <aside className="w-48 min-h-screen border-r bg-white flex flex-col py-6 px-3 shrink-0">
      <p className="font-bold text-lg px-3 mb-8">Quadra</p>

      <nav className="flex flex-col gap-1 flex-1">
        {links.map(({ to, label, icon: Icon }) => (
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
        ))}
      </nav>

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
