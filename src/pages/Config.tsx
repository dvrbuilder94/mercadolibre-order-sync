import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, XCircle, ExternalLink, LogOut, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface MeliAccount {
  id: string;
  seller_id: string | null;
  site_id: string;
  access_token: string | null;
  expires_at: string | null;
  updated_at: string | null;
}

interface BsaleAccount {
  id: string;
  cpn_id: string | null;
  webhook_url: string | null;
  client_name: string | null;
  status: string | null;
}

export default function Config() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [meliAccount, setMeliAccount] = useState<MeliAccount | null>(null);
  const [bsaleAccount, setBsaleAccount] = useState<BsaleAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  
  // Bsale token form state
  const [showBsaleForm, setShowBsaleForm] = useState(false);
  const [bsaleToken, setBsaleToken] = useState("");
  const [connectingBsale, setConnectingBsale] = useState(false);

  // Sync states
  const [syncingMeli, setSyncingMeli] = useState(false);
  const [syncingBsale, setSyncingBsale] = useState(false);

  // Meli range sync
  const [showMeliRangeDialog, setShowMeliRangeDialog] = useState(false);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [meliFromMonth, setMeliFromMonth] = useState(currentMonth);
  const [meliToMonth, setMeliToMonth] = useState(currentMonth);
  const [meliRangeProgress, setMeliRangeProgress] = useState<string>("");

  useEffect(() => {
    checkAuth();
    fetchConnections();
  }, []);

  const checkAuth = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      navigate("/auth");
    }
  };

  const fetchConnections = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: meli } = await supabase
        .from("meli_accounts")
        .select("id, seller_id, site_id, access_token, expires_at, updated_at")
        .eq("user_id", user.id)
        .maybeSingle();

      setMeliAccount(meli);

      const { data: bsale } = await supabase
        .from("bsale_accounts")
        .select("id, cpn_id, webhook_url, client_name, status")
        .eq("user_id", user.id)
        .maybeSingle();

      setBsaleAccount(bsale);
    } catch (error) {
      console.error("Error fetching connections:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectMeli = async () => {
    setConnecting(true);
    try {
      const { data, error } = await supabase.functions.invoke('get-meli-auth-url');
      
      if (error) throw error;
      
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error('No se pudo obtener URL de autenticación');
      }
    } catch (error: any) {
      console.error('Error connecting to MELI:', error);
      toast.error('Error al conectar con Mercado Libre');
    } finally {
      setConnecting(false);
    }
  };

  const handleSyncMeli = async () => {
    setSyncingMeli(true);
    try {
      // Sync orders
      const { data: ordersData, error: ordersError } = await supabase.functions.invoke('sync-meli-orders');
      if (ordersError) throw ordersError;

      // Sync settlements
      const { data: settlementsData, error: settlementsError } = await supabase.functions.invoke('sync-meli-settlements');
      if (settlementsError) throw settlementsError;

      toast.success(`Sincronizado: ${ordersData?.orders || 0} órdenes, ${settlementsData?.payments || 0} liquidaciones`);
    } catch (error: any) {
      console.error('Error syncing Meli:', error);
      toast.error('Error al sincronizar Mercado Libre');
    } finally {
      setSyncingMeli(false);
    }
  };

  const handleSyncMeliRange = async () => {
    if (meliFromMonth > meliToMonth) {
      toast.error("El mes inicial debe ser anterior o igual al mes final");
      return;
    }
    setSyncingMeli(true);
    setMeliRangeProgress("");
    try {
      const months: string[] = [];
      const [fy, fm] = meliFromMonth.split("-").map(Number);
      const [ty, tm] = meliToMonth.split("-").map(Number);
      let y = fy, m = fm;
      while (y < ty || (y === ty && m <= tm)) {
        months.push(`${y}-${String(m).padStart(2, "0")}`);
        m++;
        if (m > 12) { m = 1; y++; }
      }

      let totalSynced = 0;
      let totalErrors = 0;
      for (let i = 0; i < months.length; i++) {
        const month = months[i];
        const [yy, mm] = month.split("-").map(Number);
        const dateFrom = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0)).toISOString();
        const dateTo = new Date(Date.UTC(yy, mm, 0, 23, 59, 59)).toISOString();

        setMeliRangeProgress(`Sincronizando ${month} (${i + 1}/${months.length})...`);

        const { data, error } = await supabase.functions.invoke('sync-meli-orders', {
          body: { date_from: dateFrom, date_to: dateTo, max_pages: 20 },
        });
        if (error) {
          console.error(`Error en ${month}:`, error);
          totalErrors++;
          continue;
        }
        totalSynced += data?.synced || 0;
      }

      toast.success(`Sincronización por rango completa: ${totalSynced} órdenes en ${months.length} mes(es)${totalErrors ? `, ${totalErrors} con error` : ""}`);
      setShowMeliRangeDialog(false);
    } catch (error: any) {
      console.error('Error syncing Meli range:', error);
      toast.error('Error al sincronizar el rango');
    } finally {
      setSyncingMeli(false);
      setMeliRangeProgress("");
    }
  };

  const handleConnectBsale = async () => {
    if (!bsaleToken.trim()) {
      toast.error("Ingresa tu Access Token de Bsale");
      return;
    }

    setConnectingBsale(true);
    try {
      const { data, error } = await supabase.functions.invoke('connect-bsale', {
        body: { accessToken: bsaleToken }
      });
      
      if (error) throw error;
      
      if (data.success) {
        toast.success("Bsale conectado correctamente");
        setBsaleToken("");
        setShowBsaleForm(false);
        fetchConnections();
      } else {
        toast.error(data.error || "Token inválido");
      }
    } catch (error: any) {
      console.error('Error connecting to Bsale:', error);
      toast.error("Error al conectar con Bsale");
    } finally {
      setConnectingBsale(false);
    }
  };

  const handleSyncBsale = async () => {
    setSyncingBsale(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-bsale-docs', {
        body: { days_back: 30, max_pages: 100 }
      });
      
      if (error) throw error;
      
      if (data.success) {
        const total = data.summary?.total_upserted ?? data.summary?.total_fetched ?? 0;
        const byType = data.summary?.by_type ? Object.entries(data.summary.by_type).map(([k, v]) => `${v} ${k}`).join(', ') : '';
        toast.success(`Sincronizado: ${total} documentos${byType ? ` (${byType})` : ''}`);
      } else {
        toast.error(data.error || "Error en sincronización");
      }
    } catch (error: any) {
      console.error('Error syncing Bsale:', error);
      toast.error("Error al sincronizar Bsale");
    } finally {
      setSyncingBsale(false);
    }
  };

  const handleDisconnectBsale = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase
        .from("bsale_accounts")
        .delete()
        .eq("user_id", user.id);

      if (error) throw error;

      setBsaleAccount(null);
      setBsaleToken("");
      setShowBsaleForm(false);
      toast.success("Bsale desconectado");
    } catch (error) {
      console.error("Error disconnecting Bsale:", error);
      toast.error("Error al desconectar Bsale");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  const meliConnected = meliAccount?.access_token && meliAccount?.seller_id;
  const bsaleConnected = bsaleAccount?.status === 'connected';

  const getMeliTokenStatus = () => {
    if (!meliAccount?.expires_at) return null;
    const expiresAt = new Date(meliAccount.expires_at);
    const now = new Date();
    const hoursLeft = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursLeft < 0) return { label: 'Token expirado', color: 'text-red-600', urgent: true };
    if (hoursLeft < 2) return { label: `Expira en ${Math.round(hoursLeft * 60)} min`, color: 'text-red-500', urgent: true };
    if (hoursLeft < 6) return { label: `Expira en ${Math.round(hoursLeft)}h`, color: 'text-amber-500', urgent: false };
    return { label: `Token activo (${Math.round(hoursLeft)}h restantes)`, color: 'text-green-600', urgent: false };
  };

  const meliTokenStatus = getMeliTokenStatus();

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Configuración</h1>
            <p className="text-muted-foreground">
              Conecta tus cuentas de marketplace y facturación
            </p>
          </div>
          <Button variant="outline" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Cerrar Sesión
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Marketplace Connection */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Marketplace</CardTitle>
                {meliConnected ? (
                  <Badge variant="default" className="bg-green-600">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Conectado
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    <XCircle className="h-3 w-3 mr-1" />
                    Desconectado
                  </Badge>
                )}
              </div>
              <CardDescription>
                Mercado Libre / Mercado Pago
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {meliConnected ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Seller ID:</span>
                    <span className="font-mono">{meliAccount?.seller_id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sitio:</span>
                    <span>{meliAccount?.site_id}</span>
                  </div>
                  {meliTokenStatus && (
                    <div className="flex justify-between items-center pt-1 border-t border-border/50">
                      <span className="text-muted-foreground">Token:</span>
                      <span className={`font-medium ${meliTokenStatus.color}`}>
                        {meliTokenStatus.urgent && <AlertCircle className="h-3 w-3 inline mr-1" />}
                        {meliTokenStatus.label}
                      </span>
                    </div>
                  )}
                  {meliAccount?.updated_at && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Último sync:</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(meliAccount.updated_at).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Conecta tu cuenta para sincronizar ventas y liquidaciones automáticamente.
                </p>
              )}
              <div className="flex gap-2">
                <Button 
                  onClick={handleConnectMeli} 
                  disabled={connecting}
                  variant={meliConnected ? "outline" : "default"}
                  className="flex-1"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <ExternalLink className="h-4 w-4 mr-2" />
                  )}
                  {meliConnected ? "Reconectar" : "Conectar"}
                </Button>
                {meliConnected && (
                  <>
                    <Button
                      onClick={handleSyncMeli}
                      disabled={syncingMeli}
                      variant="outline"
                      title="Sincronizar últimos 30 días"
                    >
                      {syncingMeli ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      onClick={() => setShowMeliRangeDialog(true)}
                      disabled={syncingMeli}
                      variant="outline"
                    >
                      Por mes
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Payment Provider */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Proveedor de Pago</CardTitle>
                {meliConnected ? (
                  <Badge variant="default" className="bg-green-600">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Incluido
                  </Badge>
                ) : (
                  <Badge variant="secondary">Pendiente</Badge>
                )}
              </div>
              <CardDescription>
                Liquidadores de marketplace
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span>Mercado Pago (automático con MercadoLibre)</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                MercadoPago actúa como liquidador principal.
              </p>
            </CardContent>
          </Card>

          {/* Bsale / ERP Connection */}
          <Card className={bsaleConnected ? "" : "border-primary/50"}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">ERP / Facturación</CardTitle>
                {bsaleConnected ? (
                  <Badge variant="default" className="bg-green-600">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Conectado
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="bg-amber-500/20 text-amber-700 border-amber-500/30">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Pendiente
                  </Badge>
                )}
              </div>
              <CardDescription>Bsale</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {bsaleConnected ? (
                <>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Empresa:</span>
                      <span>{bsaleAccount?.client_name || bsaleAccount?.cpn_id}</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Acceso de solo lectura. Revocable en cualquier momento.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={handleDisconnectBsale}>
                      Desconectar
                    </Button>
                    <Button 
                      onClick={handleSyncBsale} 
                      disabled={syncingBsale}
                      variant="outline"
                    >
                      {syncingBsale ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </>
              ) : showBsaleForm ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Para conectar Bsale, debes ser administrador en tu cuenta Bsale.
                    Genera tu access token en{" "}
                    <a 
                      href="https://account.bsale.dev" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary underline"
                    >
                      account.bsale.dev
                    </a>
                    {" "}y pégalo a continuación.
                  </p>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label htmlFor="bsale-token" className="text-sm">Access Token</Label>
                      <Input
                        id="bsale-token"
                        type="password"
                        placeholder="Pega tu token aquí"
                        value={bsaleToken}
                        onChange={(e) => setBsaleToken(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      onClick={() => {
                        setShowBsaleForm(false);
                        setBsaleToken("");
                      }} 
                      className="flex-1"
                    >
                      Cancelar
                    </Button>
                    <Button 
                      onClick={handleConnectBsale} 
                      disabled={connectingBsale || !bsaleToken.trim()}
                      className="flex-1"
                    >
                      {connectingBsale && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Conectar
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Quadra nunca crea ni modifica documentos. Acceso revocable en cualquier momento.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Para conectar Bsale, debes ser administrador en tu cuenta Bsale.
                  </p>
                  <Button 
                    onClick={() => setShowBsaleForm(true)} 
                    className="w-full"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Conectar Bsale
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog open={showMeliRangeDialog} onOpenChange={setShowMeliRangeDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Sincronizar Mercado Libre por meses</DialogTitle>
              <DialogDescription>
                Elige el rango de meses a sincronizar. Se consultará mes por mes para cubrir periodos largos.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="meli-from-month" className="text-sm">Desde</Label>
                <Input
                  id="meli-from-month"
                  type="month"
                  value={meliFromMonth}
                  max={currentMonth}
                  onChange={(e) => setMeliFromMonth(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="meli-to-month" className="text-sm">Hasta</Label>
                <Input
                  id="meli-to-month"
                  type="month"
                  value={meliToMonth}
                  max={currentMonth}
                  onChange={(e) => setMeliToMonth(e.target.value)}
                />
              </div>
            </div>
            {meliRangeProgress && (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                {meliRangeProgress}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowMeliRangeDialog(false)}
                disabled={syncingMeli}
              >
                Cancelar
              </Button>
              <Button onClick={handleSyncMeliRange} disabled={syncingMeli}>
                {syncingMeli && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Sincronizar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
