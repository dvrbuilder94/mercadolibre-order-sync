import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2 } from "lucide-react";

const Brand = ({ onClick }: { onClick: () => void }) => (
  <button type="button" onClick={onClick} className="group inline-flex items-center gap-3" aria-label="Volver a quadraX">
    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-black text-sm font-semibold tracking-[-0.06em] text-white transition-transform group-hover:scale-[1.03]">
      qX
    </span>
    <span className="text-lg font-semibold tracking-[-0.04em] text-foreground">quadraX</span>
  </button>
);

const Auth = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const inviteMode = new URLSearchParams(location.search).get("invite") === "1";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [invitePasswordConfirm, setInvitePasswordConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [inviteSessionReady, setInviteSessionReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (inviteMode) {
        setInviteSessionReady(Boolean(session));
      } else if (session) {
        navigate("/tesoreria");
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (inviteMode) {
        if (session) setInviteSessionReady(true);
      } else if (session) {
        navigate("/tesoreria");
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate, inviteMode]);

  const handleInvitePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invitePassword.length < 8) {
      toast({ variant: "destructive", title: "Contraseña muy corta", description: "Usa al menos 8 caracteres." });
      return;
    }
    if (invitePassword !== invitePasswordConfirm) {
      toast({ variant: "destructive", title: "Las contraseñas no coinciden" });
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: invitePassword });
      if (error) throw error;
      toast({ title: "Acceso configurado", description: "Ya puedes usar quadraX con tu usuario." });
      navigate("/tesoreria", { replace: true });
    } catch (error: any) {
      toast({ variant: "destructive", title: "No se pudo configurar el acceso", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth` },
      });
      if (error) {
        toast({ variant: "destructive", title: "Error al registrarse", description: error.message });
      } else {
        toast({ title: "¡Cuenta creada!", description: "Ya puedes iniciar sesión con tu cuenta." });
      }
    } catch (error: any) {
      toast({ variant: "destructive", title: "Error", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) toast({ variant: "destructive", title: "Error al iniciar sesión", description: error.message });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Error", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  if (inviteMode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl font-bold text-center">Bienvenido a quadraX</CardTitle>
            <CardDescription className="text-center">Define tu contraseña para terminar de activar el acceso a tu organización.</CardDescription>
          </CardHeader>
          <CardContent>
            {!inviteSessionReady ? (
              <p className="text-sm text-muted-foreground text-center">Validando invitación...</p>
            ) : (
              <form onSubmit={handleInvitePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="invite-password">Nueva contraseña</Label>
                  <Input id="invite-password" type="password" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} minLength={8} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-password-confirm">Confirmar contraseña</Label>
                  <Input id="invite-password-confirm" type="password" value={invitePasswordConfirm} onChange={(e) => setInvitePasswordConfirm(e.target.value)} minLength={8} required />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Activar acceso
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-background p-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between py-4">
        <Brand onClick={() => navigate("/")} />
        <button
          type="button"
          onClick={() => navigate("/")}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver al inicio
        </button>
      </div>

      <div className="flex min-h-[calc(100vh-88px)] items-center justify-center pb-16">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-black text-base font-semibold tracking-[-0.06em] text-white">
              qX
            </div>
            <CardTitle className="text-2xl font-bold">quadraX</CardTitle>
            <CardDescription>Operación financiera conectada</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Iniciar Sesión</TabsTrigger>
                <TabsTrigger value="signup">Registrarse</TabsTrigger>
              </TabsList>
              <TabsContent value="signin">
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signin-email">Email</Label>
                    <Input id="signin-email" type="email" placeholder="tu@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signin-password">Contraseña</Label>
                    <Input id="signin-password" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Iniciar Sesión
                  </Button>
                </form>
              </TabsContent>
              <TabsContent value="signup">
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input id="signup-email" type="email" placeholder="tu@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Contraseña</Label>
                    <Input id="signup-password" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Crear Cuenta
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Auth;
