import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, KeyRound, Mail, Save, ShieldCheck, UserRound, Plus, Store } from "lucide-react";
import { toast } from "sonner";
import { Nav } from "@/components/Nav";
import { PinGateDialog } from "@/components/PinGateDialog";
import { supabase } from "@/integrations/supabase/client";

interface ProfileData {
  id: string;
  email: string;
  full_name: string | null;
  company_name: string | null;
}

interface OrgData {
  id: string;
  name: string;
  role: string;
}

interface MeliAccount {
  id: string;
  seller_id: string | null;
  site_id: string;
  updated_at: string;
}

export default function PageProfile() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [fullName, setFullName] = useState("");
  const [org, setOrg] = useState<OrgData | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [savingPin, setSavingPin] = useState(false);
  const [meliAccounts, setMeliAccounts] = useState<MeliAccount[]>([]);
  const [pinGateOpen, setPinGateOpen] = useState(false);
  const [addingMeli, setAddingMeli] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate("/auth");
        return;
      }
      await load(session.user.id);
    })();
  }, [navigate]);

  const load = async (userId: string) => {
    setLoading(true);
    try {
      const [{ data: p }, { data: orgId }, { data: pinReady }, { data: accounts }] = await Promise.all([
        supabase.from("profiles").select("id,email,full_name,company_name").eq("id", userId).single(),
        (supabase as any).rpc("current_user_organization_id"),
        (supabase as any).rpc("has_org_pin"),
        supabase.from("meli_accounts").select("id,seller_id,site_id,updated_at").not("seller_id", "is", null).order("updated_at", { ascending: false }),
      ]);

      if (p) {
        setProfile(p as ProfileData);
        setFullName((p as any).full_name || "");
      }
      setHasPin(Boolean(pinReady));
      setMeliAccounts((accounts || []) as MeliAccount[]);

      if (orgId) {
        const { data: member } = await (supabase as any)
          .from("organization_members")
          .select("role, organizations(id,name)")
          .eq("organization_id", orgId)
          .eq("user_id", userId)
          .single();
        const organization = Array.isArray(member?.organizations) ? member.organizations[0] : member?.organizations;
        if (organization) setOrg({ id: organization.id, name: organization.name, role: member.role });
      }
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName.trim() || null, updated_at: new Date().toISOString() } as any)
        .eq("id", profile.id);
      if (error) throw error;
      setProfile({ ...profile, full_name: fullName.trim() || null });
      toast.success("Perfil actualizado");
    } catch (e: any) {
      toast.error(e?.message || "No se pudo actualizar el perfil");
    } finally {
      setSaving(false);
    }
  };

  const savePin = async () => {
    if (!/^\d{6}$/.test(pin)) {
      toast.error("El PIN debe tener exactamente 6 dígitos");
      return;
    }
    if (pin !== pinConfirm) {
      toast.error("Los PIN no coinciden");
      return;
    }
    setSavingPin(true);
    try {
      const { data, error } = await (supabase as any).rpc("set_org_pin", { p_pin: pin });
      if (error || !data) throw error || new Error("No se pudo guardar el PIN");
      setHasPin(true);
      setPin("");
      setPinConfirm("");
      toast.success(hasPin ? "PIN actualizado" : "PIN de seguridad configurado");
    } catch (e: any) {
      toast.error(e?.message || "No se pudo guardar el PIN");
    } finally {
      setSavingPin(false);
    }
  };

  const startNewMeliAccount = async () => {
    setAddingMeli(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-meli-auth-url", {
        body: { new_account: true },
      });
      const authUrl = data?.authUrl || data?.auth_url;
      if (error || !authUrl) throw new Error(data?.error || "No se pudo iniciar la conexión");
      window.location.assign(authUrl);
    } catch (e: any) {
      toast.error(e?.message || "No se pudo agregar la cuenta Mercado Libre");
      setAddingMeli(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen bg-slate-50">
        <Nav />
        <main className="flex-1 p-8"><p className="text-sm text-slate-400">Cargando perfil...</p></main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">
        <div className="mb-7">
          <div className="flex items-center gap-2">
            <UserRound className="h-5 w-5 text-slate-400" />
            <h1 className="text-2xl font-semibold text-slate-900">Perfil</h1>
          </div>
          <p className="text-sm text-slate-500 mt-1">Tu perfil, organización y controles de seguridad.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <section className="bg-white border rounded-xl p-5">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2"><UserRound className="h-4 w-4" /> Perfil personal</h2>
            <div className="space-y-4 mt-5">
              <div>
                <label className="text-xs text-slate-500">Nombre</label>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Nombre del usuario" className="mt-1 w-full rounded-md border px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500 flex items-center gap-1"><Mail className="h-3 w-3" /> Email de acceso</label>
                <input value={profile?.email || "demo@demo.com"} disabled className="mt-1 w-full rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-500" />
                <p className="text-[11px] text-slate-400 mt-1">Por ahora mantenemos demo@demo.com. El cambio de correo se habilitará más adelante con verificación.</p>
              </div>
              <button onClick={saveProfile} disabled={saving} className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
                <Save className="h-4 w-4" /> {saving ? "Guardando..." : "Guardar perfil"}
              </button>
            </div>
          </section>

          <section className="bg-white border rounded-xl p-5">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2"><Building2 className="h-4 w-4" /> Organización</h2>
            <div className="mt-5 space-y-3">
              <div className="rounded-lg border p-4">
                <p className="text-xs text-slate-400">Organización</p>
                <p className="font-semibold mt-1">{org?.name || profile?.company_name || "Gnomo"}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs text-slate-400">Tu perfil</p>
                <p className="font-medium mt-1 capitalize">{org?.role || "owner"}</p>
                <p className="text-xs text-slate-400 mt-1">Este modelo ya permite sumar otros perfiles a la misma organización más adelante.</p>
              </div>
            </div>
          </section>
        </div>

        <section className="bg-white border rounded-xl p-5 mt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900 flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> PIN de seguridad</h2>
              <p className="text-sm text-slate-500 mt-1">Se solicita antes de agregar o modificar conexiones sensibles.</p>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${hasPin ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{hasPin ? "Configurado" : "Pendiente"}</span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-5 max-w-xl">
            <div>
              <label className="text-xs text-slate-500">Nuevo PIN</label>
              <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" autoComplete="off" className="mt-1 w-full rounded-md border px-3 py-2 text-center text-lg tracking-[0.4em]" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Confirmar PIN</label>
              <input type="password" inputMode="numeric" maxLength={6} value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" autoComplete="off" className="mt-1 w-full rounded-md border px-3 py-2 text-center text-lg tracking-[0.4em]" />
            </div>
          </div>
          <button onClick={savePin} disabled={savingPin || pin.length !== 6 || pinConfirm.length !== 6} className="mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-40">
            <KeyRound className="h-4 w-4" /> {savingPin ? "Guardando..." : hasPin ? "Cambiar PIN" : "Crear PIN"}
          </button>
          <p className="text-[11px] text-slate-400 mt-3">El PIN se guarda como hash bcrypt en Postgres. Después de 5 intentos fallidos se bloquea la verificación por 15 minutos.</p>
        </section>

        <section className="bg-white border rounded-xl p-5 mt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold text-slate-900 flex items-center gap-2"><Store className="h-4 w-4" /> Cuentas de la organización</h2>
              <p className="text-sm text-slate-500 mt-1">Mercado Libre admite múltiples cuentas bajo esta misma organización.</p>
            </div>
            <button
              onClick={() => hasPin ? setPinGateOpen(true) : toast.error("Primero configura el PIN de seguridad")}
              disabled={addingMeli}
              className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" /> {addingMeli ? "Abriendo Mercado Libre..." : "Agregar cuenta MELI"}
            </button>
          </div>

          <div className="mt-5 space-y-2">
            {meliAccounts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-sm text-slate-400">No hay cuentas Mercado Libre conectadas.</div>
            ) : meliAccounts.map((account) => (
              <div key={account.id} className="rounded-lg border p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-sm">Mercado Libre · Seller {account.seller_id}</p>
                  <p className="text-xs text-slate-400 mt-1">{account.site_id} · actualizada {account.updated_at?.slice(0, 10)}</p>
                </div>
                <span className="text-xs bg-emerald-50 text-emerald-700 rounded-full px-2 py-1">Conectada</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-4">Bsale y Shopify siguen con una cuenta por ahora porque sus sincronizadores actuales todavía asumen una sola conexión. No los abrimos a multi-cuenta hasta adaptar ese flujo de forma segura.</p>
        </section>
      </main>

      <PinGateDialog
        open={pinGateOpen}
        onOpenChange={setPinGateOpen}
        title="Autorizar nueva cuenta"
        description="Ingresa el PIN de la organización antes de agregar otra cuenta Mercado Libre."
        onVerified={startNewMeliAccount}
      />
    </div>
  );
}
