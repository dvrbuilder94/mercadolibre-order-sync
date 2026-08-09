import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import {
  CheckCircle2, Loader2, Plug, Sparkles,
  ShoppingBag, FileText, Landmark, Lock, Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { MeliConnectWizard } from "@/components/MeliConnectWizard";
import { ConnectGuideDialog, CopyableValue } from "@/components/ConnectGuideDialog";

// ── Conexiones ───────────────────────────────────────────────────────────────
// Catálogo agrupado por categoría: marketplaces, ERPs y bancos. Las conexiones
// activas (MeLi, Bsale, Shopify) usan los mismos endpoints OAuth/form de antes,
// solo cambia la presentación. Los conectores "próximamente" son placeholders
// visuales — no llaman a ningún edge function aún.

type Status = "connected" | "disconnected" | "coming_soon";
type Category = "marketplace" | "payment" | "erp" | "bank";

interface ConnectorCard {
  id: string;
  name: string;
  category: Category;
  brand: { bg: string; fg: string; initial: string };
  status: Status;
  detail: string;
  action?: () => void | Promise<void>;
  loading?: boolean;
  custom?: () => React.ReactNode; // para shopify form, etc.
}

const CAT_LABEL: Record<Category, { title: string; sub: string; Icon: typeof ShoppingBag }> = {
  marketplace: { title: "Marketplaces",  sub: "De dónde vienen las ventas",   Icon: ShoppingBag },
  payment:     { title: "Pasarelas de pago", sub: "De dónde viene la plata",  Icon: Wallet },
  erp:         { title: "ERP / Facturación", sub: "De dónde vienen los DTE",  Icon: FileText },
  bank:        { title: "Bancos",         sub: "Para conciliar el payout",    Icon: Landmark },
};

export default function ConfigNew() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [meli, setMeli] = useState<{ connected: boolean; detail: string }>({ connected: false, detail: "No conectado" });
  const [bsale, setBsale] = useState<{ connected: boolean; detail: string }>({ connected: false, detail: "No conectado" });
  const [shopify, setShopify] = useState<{ connected: boolean; detail: string }>({ connected: false, detail: "No conectado" });
  const [connectingMeli, setConnectingMeli] = useState(false);
  const [meliWizardOpen, setMeliWizardOpen] = useState(false);
  const [showBsaleForm, setShowBsaleForm] = useState(false);
  const [bsaleToken, setBsaleToken] = useState("");
  const [connectingBsale, setConnectingBsale] = useState(false);
  const [bsaleError, setBsaleError] = useState<string | null>(null);
  const [showShopifyForm, setShowShopifyForm] = useState(false);
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyClientId, setShopifyClientId] = useState("");
  const [shopifyClientSecret, setShopifyClientSecret] = useState("");
  const [connectingShopify, setConnectingShopify] = useState(false);
  const [shopifyError, setShopifyError] = useState<string | null>(null);
  const [mercadopago, setMercadopago] = useState<{ connected: boolean; detail: string }>({ connected: false, detail: "No conectado" });
  const [showMpForm, setShowMpForm] = useState(false);
  const [connectingMp, setConnectingMp] = useState(false);
  const [mpError, setMpError] = useState<string | null>(null);
  const [comingSoonOpen, setComingSoonOpen] = useState<ConnectorCard | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
      else fetchConnections();
    });
  }, [navigate]);

  const fetchConnections = async () => {
    setLoading(true);
    try {
      const { data: meliData } = await supabase
        .from("meli_accounts")
        .select("seller_id, site_id, expires_at, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (meliData) {
        const expiresAt = meliData.expires_at ? new Date(meliData.expires_at) : null;
        const hoursLeft = expiresAt ? Math.round((expiresAt.getTime() - Date.now()) / 3600000) : null;
        const tokenOk = hoursLeft === null || hoursLeft > 0;
        setMeli({
          connected: !!meliData.seller_id,
          detail: meliData.seller_id
            ? `Seller ${meliData.seller_id} · ${hoursLeft !== null ? `token ${tokenOk ? `${hoursLeft}h restantes` : "vencido"}` : "token sin fecha"}`
            : "No conectado",
        });
      } else {
        setMeli({ connected: false, detail: "No conectado" });
      }

      const { data: bsaleData } = await supabase
        .from("bsale_accounts")
        .select("client_name, status, updated_at")
        .eq("status", "connected")
        .maybeSingle();

      if (bsaleData) {
        setBsale({
          connected: true,
          detail: `${bsaleData.client_name || "cuenta conectada"} · última sync ${bsaleData.updated_at?.slice(0, 10) || "—"}`,
        });
      } else {
        setBsale({ connected: false, detail: "No conectado" });
      }

      const { data: shopifyData } = await supabase
        .from("shopify_accounts")
        .select("shop_domain, updated_at")
        .maybeSingle();

      if (shopifyData) {
        setShopify({
          connected: true,
          detail: `${shopifyData.shop_domain} · última sync ${shopifyData.updated_at?.slice(0, 10) || "—"}`,
        });
      } else {
        setShopify({ connected: false, detail: "No conectado" });
      }

      const { data: mpData } = await supabase
        .from("mercadopago_accounts")
        .select("nickname, mp_user_id, site_id, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (mpData) {
        setMercadopago({
          connected: true,
          detail: `${mpData.nickname || `Cuenta ${mpData.mp_user_id}`} · ${mpData.site_id || "MLC"} · actualizada ${mpData.updated_at?.slice(0, 10) || "—"}`,
        });
      } else {
        setMercadopago({ connected: false, detail: "No conectado" });
      }
    } finally {
      setLoading(false);
    }
  };

  // MercadoLibre exige credenciales propias por vendedor (App ID + clave secreta
  // del DevCenter). Si la cuenta ya las tiene guardadas vamos directo al OAuth;
  // si no, abrimos el asistente que guía la creación de la aplicación.
  const connectMeli = async () => {
    setConnectingMeli(true);
    try {
      const { data: account } = await supabase
        .from("meli_accounts")
        .select("client_id, client_secret")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!account?.client_id || !account?.client_secret) {
        setMeliWizardOpen(true);
        return;
      }

      const { data, error } = await supabase.functions.invoke("get-meli-auth-url");
      if (error) {
        setMeliWizardOpen(true);
        return;
      }
      const authUrl = data?.authUrl || data?.auth_url;
      if (!authUrl) {
        setMeliWizardOpen(true);
        return;
      }
      window.location.assign(authUrl);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "No se pudo iniciar la conexión con MercadoLibre");
    } finally {
      setConnectingMeli(false);
    }
  };

  const connectBsale = async () => {
    setBsaleError(null);
    if (!bsaleToken.trim()) {
      setBsaleError("Ingresa el access token de Bsale");
      return;
    }
    setConnectingBsale(true);
    try {
      const { data, error } = await supabase.functions.invoke("connect-bsale", {
        body: { accessToken: bsaleToken.trim() },
      });
      if (error || !data?.success) {
        setBsaleError(data?.error || "No se pudo validar el token de Bsale");
        return;
      }
      setBsaleToken("");
      setShowBsaleForm(false);
      toast.success("Cuenta Bsale conectada");
      await fetchConnections();
    } catch (e: unknown) {
      setBsaleError(e instanceof Error ? e.message : "No se pudo conectar Bsale");
    } finally {
      setConnectingBsale(false);
    }
  };

  const connectShopify = async () => {
    setShopifyError(null);
    if (!shopifyDomain.trim() || !shopifyClientId.trim() || !shopifyClientSecret.trim()) {
      setShopifyError("Completa el shop domain, el Client ID y el Client Secret");
      return;
    }
    setConnectingShopify(true);
    try {
      const { data, error } = await supabase.functions.invoke("connect-shopify", {
        body: {
          shop_domain: shopifyDomain.trim(),
          client_id: shopifyClientId.trim(),
          client_secret: shopifyClientSecret.trim(),
        },
      });
      if (error || !data?.success) {
        setShopifyError(data?.error || "Error al conectar con Shopify");
        return;
      }
      setShopifyClientId("");
      setShopifyClientSecret("");
      setShowShopifyForm(false);
      await fetchConnections();
    } catch (e) {
      setShopifyError("Error al conectar con Shopify");
    } finally {
      setConnectingShopify(false);
    }
  };

  const connectMercadoPago = async () => {
    setMpError(null);
    setConnectingMp(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-mercadopago-auth-url");
      const authUrl = data?.authUrl;
      if (error || !authUrl) {
        setMpError(
          data?.error ||
          "No se pudo iniciar la autorización. Verificá que la aplicación de Mercado Pago esté configurada.",
        );
        return;
      }
      window.location.assign(authUrl);
    } catch (e: unknown) {
      setMpError(e instanceof Error ? e.message : "No se pudo conectar Mercado Pago");
    } finally {
      setConnectingMp(false);
    }
  };

  const connectors: ConnectorCard[] = [
    // Marketplaces
    {
      id: "meli", name: "MercadoLibre", category: "marketplace",
      brand: { bg: "bg-yellow-400", fg: "text-slate-900", initial: "M" },
      status: meli.connected ? "connected" : "disconnected",
      detail: meli.detail,
      action: connectMeli, loading: connectingMeli,
    },
    {
      id: "shopify", name: "Shopify", category: "marketplace",
      brand: { bg: "bg-emerald-500", fg: "text-white", initial: "S" },
      status: shopify.connected ? "connected" : "disconnected",
      detail: shopify.detail,
      action: () => { setShopifyError(null); setShowShopifyForm(true); },
    },
    {
      id: "falabella", name: "Falabella", category: "marketplace",
      brand: { bg: "bg-green-600", fg: "text-white", initial: "F" },
      status: "coming_soon", detail: "Próximamente",
    },
    {
      id: "paris", name: "Paris", category: "marketplace",
      brand: { bg: "bg-pink-500", fg: "text-white", initial: "P" },
      status: "coming_soon", detail: "Próximamente",
    },
    {
      id: "ripley", name: "Ripley", category: "marketplace",
      brand: { bg: "bg-purple-600", fg: "text-white", initial: "R" },
      status: "coming_soon", detail: "Próximamente",
    },
    {
      id: "amazon", name: "Amazon", category: "marketplace",
      brand: { bg: "bg-slate-900", fg: "text-amber-400", initial: "A" },
      status: "coming_soon", detail: "Próximamente",
    },
    // Pasarelas de pago
    {
      id: "mercadopago", name: "Mercado Pago", category: "payment",
      brand: { bg: "bg-sky-500", fg: "text-white", initial: "MP" },
      status: mercadopago.connected ? "connected" : "disconnected",
      detail: mercadopago.detail,
      action: () => { setMpError(null); setShowMpForm(true); }, loading: connectingMp,
    },
    {
      id: "transbank", name: "Transbank / Webpay", category: "payment",
      brand: { bg: "bg-orange-500", fg: "text-white", initial: "T" },
      status: "coming_soon", detail: "Próximamente",
    },
    // ERPs
    {
      id: "bsale", name: "Bsale", category: "erp",
      brand: { bg: "bg-blue-600", fg: "text-white", initial: "B" },
      status: bsale.connected ? "connected" : "disconnected",
      detail: bsale.detail,
      action: () => { setBsaleError(null); setShowBsaleForm(true); }, loading: connectingBsale,
    },
    {
      id: "defontana", name: "Defontana", category: "erp",
      brand: { bg: "bg-red-600", fg: "text-white", initial: "D" },
      status: "coming_soon", detail: "Próximamente",
    },
    {
      id: "nubox", name: "Nubox", category: "erp",
      brand: { bg: "bg-cyan-600", fg: "text-white", initial: "N" },
      status: "coming_soon", detail: "Próximamente",
    },
    // Bancos
    {
      id: "fintoc", name: "Fintoc", category: "bank",
      brand: { bg: "bg-violet-600", fg: "text-white", initial: "F" },
      status: "coming_soon", detail: "Próximamente · agregador bancario",
    },
  ];

  const grouped: Record<Category, ConnectorCard[]> = {
    marketplace: connectors.filter(c => c.category === "marketplace"),
    payment: connectors.filter(c => c.category === "payment"),
    erp: connectors.filter(c => c.category === "erp"),
    bank: connectors.filter(c => c.category === "bank"),
  };

  const connectedCount = connectors.filter(c => c.status === "connected").length;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />
      <main className="flex-1 p-8 max-w-5xl">
        <div className="mb-8">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Plug className="h-5 w-5 text-slate-400" />
            Conexiones
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {connectedCount} de {connectors.filter(c => c.status !== "coming_soon").length} conectadas ·
            agregamos más marketplaces, ERPs y bancos próximamente.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando...
          </div>
        ) : (
          <div className="space-y-10">
            {(Object.keys(grouped) as Category[]).map((cat) => {
              const meta = CAT_LABEL[cat];
              return (
                <section key={cat}>
                  <div className="flex items-baseline gap-2 mb-3">
                    <meta.Icon className="h-4 w-4 text-slate-400" />
                    <h2 className="text-sm font-semibold text-slate-700">{meta.title}</h2>
                    <p className="text-xs text-slate-400">· {meta.sub}</p>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {grouped[cat].map((c) => (
                      <ConnectorTile
                        key={c.id} c={c}
                        onComingSoon={() => setComingSoonOpen(c)}
                      />
                    ))}
                  </div>

                </section>
              );
            })}
          </div>
        )}

        {/* Coming-soon modal */}
        <Dialog open={!!comingSoonOpen} onOpenChange={(o) => !o && setComingSoonOpen(null)}>
          <DialogContent className="sm:max-w-sm">
            {comingSoonOpen && (
              <>
                <DialogHeader>
                  <div className="flex items-center gap-3 mb-2">
                    <BrandBadge brand={comingSoonOpen.brand} size="lg" />
                    <div>
                      <DialogTitle>{comingSoonOpen.name}</DialogTitle>
                      <p className="text-xs text-slate-400">Próximamente</p>
                    </div>
                  </div>
                  <DialogDescription>
                    Estamos trabajando en este conector. Si lo necesitás priorizar,
                    avisanos y lo subimos en la cola.
                  </DialogDescription>
                </DialogHeader>
              </>
            )}
          </DialogContent>
        </Dialog>

        <MeliConnectWizard open={meliWizardOpen} onOpenChange={setMeliWizardOpen} />

        {/* Bsale — pasos según la documentación oficial (docs.bsale.dev) */}
        <ConnectGuideDialog
          open={showBsaleForm}
          onOpenChange={(o) => { setShowBsaleForm(o); if (!o) setBsaleError(null); }}
          title="Conectar Bsale"
          subtitle="Generá un token de acceso en tu cuenta Bsale y pegalo aquí."
          docsUrl="https://docs.bsale.dev/"
          docsLabel="Ver documentación de la API de Bsale"
          steps={[
            { title: "Entrá a tu cuenta Bsale", body: <>Ingresá a <code className="rounded bg-muted px-1">app.bsale.io</code> con un usuario administrador.</> },
            { title: "Abrí Configuración → Integraciones", body: <>En el menú de configuración buscá la sección <strong>Integraciones</strong> y luego <strong>Token de acceso / API</strong>.</> },
            { title: "Generá el token", body: <>Presioná <strong>Generar token</strong>. Bsale muestra el token una sola vez: copialo antes de cerrar la ventana.</> },
            { title: "Pegalo abajo", body: <>Validamos el token contra <code className="rounded bg-muted px-1">api.bsale.io/v1/users.json</code> antes de guardarlo.</> },
          ]}
          note={<>Quadra usa Bsale en <strong>modo solo lectura</strong>: nunca emitimos ni anulamos documentos. Si el token se revoca en Bsale, la sincronización se detiene y hay que generar uno nuevo.</>}
          error={bsaleError}
          submitting={connectingBsale}
          onSubmit={connectBsale}
          form={
            <div className="space-y-1.5">
              <label htmlFor="bsale-token" className="text-xs text-slate-600">Access token de Bsale</label>
              <input
                id="bsale-token"
                type="password"
                value={bsaleToken}
                onChange={(e) => setBsaleToken(e.target.value)}
                placeholder="Token de acceso"
                autoComplete="off"
                className="w-full rounded-md border px-3 py-1.5 text-sm"
              />
            </div>
          }
        />

        {/* Shopify — pasos según shopify.dev (custom app + Admin API token) */}
        <ConnectGuideDialog
          open={showShopifyForm}
          onOpenChange={(o) => { setShowShopifyForm(o); if (!o) setShopifyError(null); }}
          title="Conectar Shopify"
          subtitle="Creá la app en el Dev Dashboard y pegá su Client ID y Client Secret. El token lo genera Quadra en el backend."
          docsUrl="https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant"
          docsLabel="Ver documentación oficial del client credentials grant"
          steps={[
            { title: "Creá la app en el Dev Dashboard", body: <>Entrá a <strong>shopify.dev → Dev Dashboard → Apps → Create app</strong> y ponele un nombre (por ejemplo “Quadra”).</> },
            { title: "Asociá la app a tu tienda", body: <>En la app: <strong>Overview → Install app</strong> y elegí tu tienda. Solo esa tienda queda habilitada (la app permanece privada).</> },
            { title: "Activá los permisos de solo lectura", body: <>En <strong>Configuration → Access scopes</strong> habilitá:<CopyableValue label="Copiar scopes" value="read_orders, read_all_orders, read_products, read_customers, read_fulfillments" /></> },
            { title: "Copiá las credenciales de la app", body: <>En <strong>Overview → Client credentials</strong> copiá el <strong>Client ID</strong> y el <strong>Client secret</strong>. Ya no hace falta ningún token <code className="rounded bg-muted px-1">shpat_</code>: Quadra genera un token de 24 h en el backend y lo renueva solo.</> },
            { title: "Usá el dominio .myshopify.com", body: <>En el shop domain va el dominio interno (<code className="rounded bg-muted px-1">mitienda.myshopify.com</code>), no tu dominio público. Lo ves en <code className="rounded bg-muted px-1">admin.shopify.com/store/<strong>mitienda</strong></code>.</> },
          ]}
          note={<>El Client Secret nunca viaja al navegador ni se guarda en tu equipo: se envía cifrado al backend, que es el único que habla con Shopify. La conexión se marca <strong>Conectada</strong> solo después de una consulta real a la tienda.</>}
          error={shopifyError}
          submitting={connectingShopify}
          onSubmit={connectShopify}
          form={
            <>
              <div className="space-y-1.5">
                <label htmlFor="shopify-domain" className="text-xs text-slate-600">Shop domain</label>
                <input
                  id="shopify-domain"
                  type="text"
                  value={shopifyDomain}
                  onChange={(e) => setShopifyDomain(e.target.value)}
                  placeholder="mitienda.myshopify.com"
                  className="w-full rounded-md border px-3 py-1.5 text-sm"
                />
                <p className="text-xs text-muted-foreground">Debe terminar en <code className="rounded bg-muted px-1">.myshopify.com</code>.</p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="shopify-client-id" className="text-xs text-slate-600">Client ID</label>
                <input
                  id="shopify-client-id"
                  type="text"
                  value={shopifyClientId}
                  onChange={(e) => setShopifyClientId(e.target.value)}
                  placeholder="Client ID de la app"
                  autoComplete="off"
                  className="w-full rounded-md border px-3 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="shopify-client-secret" className="text-xs text-slate-600">Client Secret</label>
                <input
                  id="shopify-client-secret"
                  type="password"
                  value={shopifyClientSecret}
                  onChange={(e) => setShopifyClientSecret(e.target.value)}
                  placeholder="Client secret de la app"
                  autoComplete="off"
                  className="w-full rounded-md border px-3 py-1.5 text-sm"
                />
              </div>
            </>
          }
        />

        {/* Mercado Pago — access token de producción (developers.mercadopago.cl) */}
        <ConnectGuideDialog
          open={showMpForm}
          onOpenChange={(o) => { setShowMpForm(o); if (!o) setMpError(null); }}
          title="Conectar Mercado Pago"
          subtitle="Autorizá a Quadra a leer los datos de tu cuenta. No pedimos credenciales."
          docsUrl="https://www.mercadopago.cl/developers/es/docs"
          docsLabel="Ver documentación de Mercado Pago"
          steps={[
            { title: "Presioná “Autorizar en Mercado Pago”", body: <>Te llevamos al sitio oficial de Mercado Pago para que inicies sesión con la cuenta que recibe los pagos.</> },
            { title: "Revisá y aceptá la autorización", body: <>Mercado Pago te muestra qué aplicación pide acceso. Confirmá con <strong>Permitir</strong>.</> },
            { title: "Volvés solo", body: <>Te devolvemos a Conexiones con la cuenta ya vinculada. Nunca vemos tu usuario ni tu contraseña.</> },
            { title: "Sincronización automática", body: <>Renovamos la autorización sola cada pocas horas, así la lectura de pagos no se corta.</> },
          ]}
          note={<>Quadra usa Mercado Pago en <strong>modo solo lectura</strong>: leemos pagos, comisiones, devoluciones, contracargos y liquidaciones. Nunca cobramos, reembolsamos ni movemos dinero — el sistema solo ejecuta consultas de lectura contra la API.</>}
          error={mpError}
          submitting={connectingMp}
          submitLabel="Autorizar en Mercado Pago"
          onSubmit={connectMercadoPago}
          form={
            <p className="text-xs text-slate-600">
              Al continuar vas a salir a <code className="rounded bg-muted px-1">mercadopago.cl</code> para
              aprobar el acceso. Podés revocarlo cuando quieras desde “Tus integraciones” en tu cuenta
              de Mercado Pago.
            </p>
          }
        />
      </main>
    </div>
  );
}

function BrandBadge({ brand, size = "md" }: { brand: ConnectorCard["brand"]; size?: "md" | "lg" }) {
  return (
    <div className={cn(
      "rounded-lg flex items-center justify-center font-bold shrink-0",
      brand.bg, brand.fg,
      size === "lg" ? "h-12 w-12 text-xl" : "h-10 w-10 text-base",
    )}>
      {brand.initial}
    </div>
  );
}

function ConnectorTile({ c, onComingSoon }: { c: ConnectorCard; onComingSoon: () => void }) {
  const isComingSoon = c.status === "coming_soon";
  const isConnected = c.status === "connected";
  const handleClick = () => {
    if (isComingSoon) return onComingSoon();
    c.action?.();
  };
  return (
    <div className={cn(
      "bg-white border rounded-lg p-4 flex flex-col gap-3 transition-all",
      isComingSoon ? "opacity-60 border-dashed" : "hover:border-slate-300 hover:shadow-sm",
    )}>
      <div className="flex items-start gap-3">
        <BrandBadge brand={c.brand} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-medium text-sm truncate">{c.name}</p>
            {isConnected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
            {isComingSoon && <Lock className="h-3 w-3 text-slate-300 shrink-0" />}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{c.detail}</p>
        </div>
      </div>
      <button onClick={handleClick} disabled={c.loading}
        className={cn(
          "w-full text-xs py-1.5 rounded-md border transition-colors",
          isComingSoon
            ? "border-dashed text-slate-400 hover:bg-slate-50 cursor-default"
            : isConnected
              ? "border-slate-200 text-slate-600 hover:bg-slate-50"
              : "bg-slate-900 text-white border-slate-900 hover:bg-slate-700",
        )}>
        {c.loading
          ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Conectando...</span>
          : isComingSoon
            ? <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3 w-3" /> Avisame cuando esté</span>
            : isConnected ? "Reconectar" : "Conectar"}
      </button>
    </div>
  );
}
