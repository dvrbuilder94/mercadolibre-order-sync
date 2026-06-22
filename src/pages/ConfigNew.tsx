import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Nav } from "@/components/Nav";
import { CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react";

interface Connection {
  name: string;
  connected: boolean;
  detail: string;
}

export default function ConfigNew() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [meli, setMeli] = useState<Connection | null>(null);
  const [bsale, setBsale] = useState<Connection | null>(null);
  const [shopify, setShopify] = useState<Connection | null>(null);
  const [connectingMeli, setConnectingMeli] = useState(false);
  const [showShopifyForm, setShowShopifyForm] = useState(false);
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyToken, setShopifyToken] = useState("");
  const [connectingShopify, setConnectingShopify] = useState(false);
  const [shopifyError, setShopifyError] = useState<string | null>(null);

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
          name: "MercadoLibre",
          connected: !!meliData.seller_id,
          detail: meliData.seller_id
            ? `Seller ${meliData.seller_id} · ${hoursLeft !== null ? `token ${tokenOk ? `${hoursLeft}h restantes` : "vencido"}` : "token sin fecha"}`
            : "No conectado",
        });
      } else {
        setMeli({ name: "MercadoLibre", connected: false, detail: "No conectado" });
      }

      const { data: bsaleData } = await supabase
        .from("bsale_accounts")
        .select("client_name, status, updated_at")
        .eq("status", "connected")
        .maybeSingle();

      if (bsaleData) {
        setBsale({
          name: "Bsale",
          connected: true,
          detail: `${bsaleData.client_name || "cuenta conectada"} · última sync ${bsaleData.updated_at?.slice(0, 10) || "—"}`,
        });
      } else {
        setBsale({ name: "Bsale", connected: false, detail: "No conectado" });
      }

      const { data: shopifyData } = await supabase
        .from("shopify_accounts")
        .select("shop_domain, status, updated_at")
        .eq("status", "connected")
        .maybeSingle();

      if (shopifyData) {
        setShopify({
          name: "Shopify",
          connected: true,
          detail: `${shopifyData.shop_domain} · última sync ${shopifyData.updated_at?.slice(0, 10) || "—"}`,
        });
      } else {
        setShopify({ name: "Shopify", connected: false, detail: "No conectado" });
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

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav />

      <main className="flex-1 p-8 max-w-2xl">
        <h1 className="text-xl font-semibold mb-8">Conexiones</h1>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando...
          </div>
        ) : (
          <div className="space-y-4">
            {/* MercadoLibre */}
            <div className="bg-white border rounded-lg p-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {meli?.connected
                  ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                  : <XCircle className="h-5 w-5 text-red-400" />}
                <div>
                  <p className="font-medium">MercadoLibre</p>
                  <p className="text-sm text-slate-400">{meli?.detail}</p>
                </div>
              </div>
              <button
                onClick={connectMeli}
                disabled={connectingMeli}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                {connectingMeli
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <ExternalLink className="h-3.5 w-3.5" />}
                {meli?.connected ? "Reconectar" : "Conectar"}
              </button>
            </div>

            {/* Bsale */}
            <div className="bg-white border rounded-lg p-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {bsale?.connected
                  ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                  : <XCircle className="h-5 w-5 text-red-400" />}
                <div>
                  <p className="font-medium">Bsale</p>
                  <p className="text-sm text-slate-400">{bsale?.detail}</p>
                </div>
              </div>
              <button
                onClick={connectBsale}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md hover:bg-slate-50 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {bsale?.connected ? "Reconectar" : "Conectar"}
              </button>
            </div>

            {/* Shopify */}
            <div className="bg-white border rounded-lg p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {shopify?.connected
                    ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                    : <XCircle className="h-5 w-5 text-red-400" />}
                  <div>
                    <p className="font-medium">Shopify</p>
                    <p className="text-sm text-slate-400">{shopify?.detail}</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowShopifyForm((v) => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md hover:bg-slate-50 transition-colors"
                >
                  {shopify?.connected ? "Reconectar" : "Conectar"}
                </button>
              </div>

              {showShopifyForm && (
                <div className="mt-4 pt-4 border-t space-y-3">
                  <p className="text-xs text-slate-400">
                    Crea una app personalizada en tu admin de Shopify (Settings → Apps → Develop apps),
                    dale el scope <code className="bg-slate-100 px-1 rounded">read_orders</code> e instálala
                    para obtener el Admin API access token.
                  </p>
                  <div>
                    <label className="text-sm text-slate-600">Shop domain</label>
                    <input
                      type="text"
                      value={shopifyDomain}
                      onChange={(e) => setShopifyDomain(e.target.value)}
                      placeholder="mitienda.myshopify.com"
                      className="mt-1 w-full border rounded-md px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">Admin API access token</label>
                    <input
                      type="password"
                      value={shopifyToken}
                      onChange={(e) => setShopifyToken(e.target.value)}
                      placeholder="shpat_..."
                      className="mt-1 w-full border rounded-md px-3 py-1.5 text-sm"
                    />
                  </div>
                  {shopifyError && <p className="text-sm text-red-500">{shopifyError}</p>}
                  <button
                    onClick={connectShopify}
                    disabled={connectingShopify}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-700 disabled:opacity-50 transition-colors"
                  >
                    {connectingShopify && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Guardar y validar
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
