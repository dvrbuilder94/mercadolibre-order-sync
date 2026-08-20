import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Mail, Save, Shield, Trash2, UserPlus, UserRound, Users } from "lucide-react";
import { toast } from "sonner";
import { Nav } from "@/components/Nav";
import { supabase } from "@/integrations/supabase/client";

interface ProfileData {
  id: string;
  email: string;
  full_name: string | null;
  company_name: string | null;
}

interface TeamMember {
  user_id: string;
  role: "admin" | "viewer";
  email: string | null;
  full_name: string | null;
  is_owner: boolean;
}

export default function PageProfile() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [fullName, setFullName] = useState("");
  const [orgName, setOrgName] = useState("Gnomo");
  const [myRole, setMyRole] = useState<"admin" | "viewer">("viewer");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer">("viewer");
  const [inviting, setInviting] = useState(false);

  const canManage = myRole === "admin";

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
      const [{ data: p }, { data: orgId }, { data: role }, { data: team }] = await Promise.all([
        supabase.from("profiles").select("id,email,full_name,company_name").eq("id", userId).single(),
        (supabase as any).rpc("current_org_id"),
        (supabase as any).rpc("current_org_role"),
        (supabase as any).rpc("get_org_members"),
      ]);

      if (p) {
        setProfile(p as ProfileData);
        setFullName((p as any).full_name || "");
      }
      setMyRole(role === "owner" || role === "admin" ? "admin" : "viewer");
      setMembers((team || []) as TeamMember[]);

      if (orgId) {
        const { data: org } = await (supabase as any).from("organizations").select("name").eq("id", orgId).single();
        if (org?.name) setOrgName(org.name);
      }
    } finally {
      setLoading(false);
    }
  };

  const refreshTeam = async () => {
    const { data } = await (supabase as any).rpc("get_org_members");
    setMembers((data || []) as TeamMember[]);
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

  const invite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      toast.error("Ingresa un email válido");
      return;
    }
    setInviting(true);
    try {
      const { data, error } = await supabase.functions.invoke("invite-org-member", {
        body: { email, role: inviteRole, redirect_origin: window.location.origin },
      });
      if (error || !data?.success) throw new Error(data?.error || "No se pudo enviar la invitación");
      setInviteEmail("");
      toast.success(`Invitación enviada a ${email}`);
      await refreshTeam();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo invitar al usuario");
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (member: TeamMember, role: "admin" | "viewer") => {
    if (member.is_owner || member.role === role) return;
    try {
      const { data, error } = await (supabase as any).rpc("update_org_member_role", {
        p_user_id: member.user_id,
        p_role: role,
      });
      if (error || !data) throw error || new Error("No se pudo cambiar el rol");
      toast.success("Rol actualizado");
      await refreshTeam();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo cambiar el rol");
    }
  };

  const removeMember = async (member: TeamMember) => {
    if (member.is_owner) return;
    if (!window.confirm(`¿Quitar a ${member.email || "este usuario"} de ${orgName}?`)) return;
    try {
      const { data, error } = await (supabase as any).rpc("remove_org_member", { p_user_id: member.user_id });
      if (error || !data) throw error || new Error("No se pudo quitar el usuario");
      toast.success("Usuario quitado de la organización");
      await refreshTeam();
    } catch (e: any) {
      toast.error(e?.message || "No se pudo quitar el usuario");
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
            <h1 className="text-2xl font-semibold text-slate-900">Perfil y equipo</h1>
          </div>
          <p className="text-sm text-slate-500 mt-1">Datos personales y usuarios que tienen acceso a {orgName}.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          <section className="bg-white border rounded-xl p-5">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2"><UserRound className="h-4 w-4" /> Perfil</h2>
            <div className="space-y-4 mt-5">
              <div>
                <label className="text-xs text-slate-500">Nombre</label>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Nombre del usuario" className="mt-1 w-full rounded-md border px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500 flex items-center gap-1"><Mail className="h-3 w-3" /> Email</label>
                <input value={profile?.email || ""} disabled className="mt-1 w-full rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-500" />
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
                <p className="text-xs text-slate-400">Empresa</p>
                <p className="font-semibold mt-1">{orgName}</p>
              </div>
              <div className="rounded-lg border p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-400">Tu rol</p>
                  <p className="font-medium mt-1">{myRole === "admin" ? "Admin" : "Lectura"}</p>
                </div>
                <Shield className="h-5 w-5 text-slate-300" />
              </div>
            </div>
          </section>
        </div>

        <section className="bg-white border rounded-xl p-5 mt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold text-slate-900 flex items-center gap-2"><Users className="h-4 w-4" /> Equipo</h2>
              <p className="text-sm text-slate-500 mt-1">Admin puede gestionar usuarios y roles. Lectura solo puede consultar información.</p>
            </div>
          </div>

          {canManage && (
            <div className="mt-5 rounded-lg border bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-700">Invitar usuario</p>
              <div className="mt-3 grid sm:grid-cols-[1fr_150px_auto] gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="persona@empresa.com"
                  className="rounded-md border bg-white px-3 py-2 text-sm"
                />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "viewer")} className="rounded-md border bg-white px-3 py-2 text-sm">
                  <option value="viewer">Lectura</option>
                  <option value="admin">Admin</option>
                </select>
                <button onClick={invite} disabled={inviting} className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
                  <UserPlus className="h-4 w-4" /> {inviting ? "Enviando..." : "Invitar"}
                </button>
              </div>
            </div>
          )}

          <div className="mt-5 divide-y rounded-lg border">
            {members.map((member) => (
              <div key={member.user_id} className="flex items-center gap-4 p-4">
                <div className="h-9 w-9 rounded-full bg-slate-100 flex items-center justify-center text-sm font-semibold text-slate-600">
                  {(member.full_name || member.email || "U").slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 truncate">{member.full_name || member.email || "Usuario"}</p>
                  <p className="text-xs text-slate-400 truncate">{member.email}</p>
                </div>

                {canManage && !member.is_owner ? (
                  <select value={member.role} onChange={(e) => changeRole(member, e.target.value as "admin" | "viewer")} className="rounded-md border bg-white px-2 py-1.5 text-xs">
                    <option value="viewer">Lectura</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className="text-xs rounded-full bg-slate-100 px-2 py-1 text-slate-600">{member.role === "admin" ? "Admin" : "Lectura"}</span>
                )}

                {canManage && !member.is_owner && (
                  <button onClick={() => removeMember(member)} className="p-2 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50" title="Quitar usuario">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
