import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import {
  CheckCircle2, Loader2, Plug, Sparkles,
  ShoppingBag, FileText, Landmark, Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// ── Conexiones ───────────────────────────────────────────────────────────────
// Catálogo agrupado por categoría: marketplaces, ERPs y bancos. Las conexiones
// activas (MeLi, Bsale, Shopify) usan los mismos endpoints OAuth/form de antes,
// solo cambia la presentación. Los conectores "próximamente" son placeholders
// visuales — no llaman a ningún edge function aún.

type Status = "connected" | "disconnected" | "coming_soon";
type Category = "marketplace" | "erp" | "bank";

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
  const [showShopifyForm, setShowShopifyForm] = useState(false);
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyToken, setShopifyToken] = useState("");
  const [connectingShopify, setConnectingShopify] = useState(false);
  const [shopifyError, setShopifyError] = useState<string | null>(null);
  const [comingSoonOpen, setComingSoonOpen] = useState<ConnectorCard | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate("/auth");
      else fetchConnections();
    });
  }, []);

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
    } finally {
      setLoading(false);
    }
  };

  const connectMeli = async () => {
    setConnectingMeli(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-meli-auth-url");
      if (error) throw error;
      window.location.href = data.auth_url;
    } catch (e) {
      setConnectingMeli(false);
    }
  };

  const connectBsale = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("get-bsale-auth-url");
      if (error) throw error;
      window.location.href = data.url || data.auth_url;
    } catch (e) {
      alert("Error al obtener URL de Bsale");
    }
  };

  const connectShopify = async () => {
    setShopifyError(null);
    if (!shopifyDomain.trim() || !shopifyToken.trim()) {
      setShopifyError("Completa el shop domain y el access token");
      return;
    }
    setConnectingShopify(true);
    try {
      const { data, error } = await supabase.functions.invoke("connect-shopify", {
        body: { shop_domain: shopifyDomain.trim(), access_token: shopifyToken.trim() },
      });
      if (error || !data?.success) {
        setShopifyError(data?.error || "Error al conectar con Shopify");
        return;
      }
      setShopifyToken("");
      setShowShopifyForm(false);
      await fetchConnections();
    } catch (e) {
      setShopifyError("Error al conectar con Shopify");
    } finally {
      setConnectingShopify(false);
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
      action: () => setShowShopifyForm(v => !v),
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
    // ERPs
    {
      id: "bsale", name: "Bsale", category: "erp",
      brand: { bg: "bg-blue-600", fg: "text-white", initial: "B" },
      status: bsale.connected ? "connected" : "disconnected",
      detail: bsale.detail,
      action: connectBsale,
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

                  {/* Shopify inline form */}
                  {cat === "marketplace" && showShopifyForm && (
                    <div className="mt-4 bg-white border rounded-lg p-4 space-y-3">
                      <p className="text-xs text-slate-500">
                        Creá una app personalizada en tu admin de Shopify (Settings → Apps → Develop apps),
                        dale el scope <code className="bg-slate-100 px-1 rounded">read_orders</code> e instalala
                        para obtener el Admin API access token.
                      </p>
                      <div>
                        <label className="text-xs text-slate-600">Shop domain</label>
                        <input type="text" value={shopifyDomain}
                          onChange={(e) => setShopifyDomain(e.target.value)}
                          placeholder="mitienda.myshopify.com"
                          className="mt-1 w-full border rounded-md px-3 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-slate-600">Admin API access token</label>
                        <input type="password" value={shopifyToken}
                          onChange={(e) => setShopifyToken(e.target.value)}
                          placeholder="shpat_..."
                          className="mt-1 w-full border rounded-md px-3 py-1.5 text-sm" />
                      </div>
                      {shopifyError && <p className="text-sm text-red-500">{shopifyError}</p>}
                      <div className="flex gap-2">
                        <button onClick={connectShopify} disabled={connectingShopify}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-700 disabled:opacity-50">
                          {connectingShopify && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          Guardar y validar
                        </button>
                        <button onClick={() => setShowShopifyForm(false)}
                          className="px-3 py-1.5 text-sm border rounded-md hover:bg-slate-50">
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
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
