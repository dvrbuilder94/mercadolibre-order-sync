import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

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
      toast({ title: "Acceso configurado", description: "Ya puedes usar Quadra con tu usuario." });
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
            <CardTitle className="text-2xl font-bold text-center">Bienvenido a Quadra</CardTitle>
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
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Quadra</CardTitle>
          <CardDescription className="text-center">Conciliación contable para marketplaces</CardDescription>
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
  );
};

export default Auth;
