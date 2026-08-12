import { useEffect, useMemo, useState } from "react";
import { Nav } from "@/components/Nav";
import { supabase } from "@/integrations/supabase/client";
import { Search, KeyRound, Link2, Loader2 } from "lucide-react";

interface CatalogRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  is_unique: boolean;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
}

interface TableModel {
  name: string;
  columns: CatalogRow[];
}

const CARD_WIDTH = 280;
const CARD_HEIGHT = 330;
const GAP_X = 90;
const GAP_Y = 70;
const COLS = 4;

// Cada canal agrupa sus tablas por prefijo. Sirve para ocultar del diagrama
// las tablas de canales que la cuenta todavía no tiene conectados.
const CHANNEL_TABLES: Record<string, { label: string; accounts: string; prefixes: string[] }> = {
  meli: { label: "MercadoLibre", accounts: "meli_accounts", prefixes: ["meli_"] },
  mercadopago: { label: "Mercado Pago", accounts: "mercadopago_accounts", prefixes: ["mercadopago_"] },
  bsale: { label: "Bsale", accounts: "bsale_accounts", prefixes: ["bsale_"] },
  shopify: { label: "Shopify", accounts: "shopify_accounts", prefixes: ["shopify_"] },
  falabella: { label: "Falabella", accounts: "falabella_accounts", prefixes: ["falabella_"] },
  amazon: { label: "Amazon", accounts: "amazon_accounts", prefixes: ["amazon_"] },
};

function channelOfTable(tableName: string): string | null {
  for (const [key, cfg] of Object.entries(CHANNEL_TABLES)) {
    if (cfg.prefixes.some(p => tableName.startsWith(p))) return key;
  }
  return null;
}

export default function PageModeloDatos() {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [scale, setScale] = useState(0.85);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [hideDisconnected, setHideDisconnected] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data, error } = await (supabase as any).rpc("get_schema_catalog");
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      setRows((data || []) as CatalogRow[]);
      setLoading(false);
    };
    load();
  }, []);

  useEffect(() => {
    const loadConnections = async () => {
      const entries = await Promise.all(
        Object.entries(CHANNEL_TABLES).map(async ([key, cfg]) => {
          const { count } = await (supabase as any)
            .from(cfg.accounts)
            .select("id", { count: "exact", head: true });
          return [key, (count ?? 0) > 0] as const;
        }),
      );
      setConnected(Object.fromEntries(entries));
    };
    loadConnections();
  }, []);

  const tables = useMemo<TableModel[]>(() => {
    const map = new Map<string, CatalogRow[]>();
    for (const row of rows) {
      const list = map.get(row.table_name) || [];
      list.push(row);
      map.set(row.table_name, list);
    }
    const q = search.trim().toLowerCase();
    return [...map.entries()]
      .map(([name, columns]) => ({ name, columns }))
      .filter((table) => {
        if (!hideDisconnected) return true;
        const channel = channelOfTable(table.name);
        return !channel || connected[channel] !== false;
      })
      .filter((table) => !q || table.name.toLowerCase().includes(q) || table.columns.some(c => c.column_name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, search, hideDisconnected, connected]);

  const hiddenChannels = Object.entries(CHANNEL_TABLES)
    .filter(([key]) => connected[key] === false)
    .map(([, cfg]) => cfg.label);

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    tables.forEach((table, index) => {
      map.set(table.name, {
        x: (index % COLS) * (CARD_WIDTH + GAP_X),
        y: Math.floor(index / COLS) * (CARD_HEIGHT + GAP_Y),
      });
    });
    return map;
  }, [tables]);

  const relations = useMemo(() => {
    const visible = new Set(tables.map(t => t.name));
    const seen = new Set<string>();
    const result: Array<{ from: string; to: string }> = [];
    for (const row of rows) {
      if (!row.foreign_table_name || !visible.has(row.table_name) || !visible.has(row.foreign_table_name)) continue;
      const key = `${row.table_name}->${row.foreign_table_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ from: row.table_name, to: row.foreign_table_name });
    }
    return result;
  }, [rows, tables]);

  const canvasWidth = Math.max(1200, COLS * (CARD_WIDTH + GAP_X));
  const canvasHeight = Math.max(700, Math.ceil(tables.length / COLS) * (CARD_HEIGHT + GAP_Y));

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Nav />
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b bg-white px-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Modelo de datos</h1>
            <p className="text-xs text-slate-500">Tablas y relaciones reales del esquema public</p>
            {hideDisconnected && hiddenChannels.length > 0 && (
              <p className="text-[11px] text-slate-400">Ocultos: {hiddenChannels.join(", ")}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 rounded-md border bg-white px-3 h-9 text-xs text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideDisconnected}
                onChange={(e) => setHideDisconnected(e.target.checked)}
                className="h-3.5 w-3.5 accent-slate-700"
              />
              Ocultar canales no conectados
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar tabla o columna"
                className="h-9 w-64 rounded-md border bg-white pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-slate-200"
              />
            </div>
            <button onClick={() => setScale(s => Math.max(0.55, +(s - 0.1).toFixed(2)))} className="h-9 w-9 rounded-md border bg-white text-sm">−</button>
            <span className="w-12 text-center text-xs text-slate-500">{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale(s => Math.min(1.2, +(s + 0.1).toFixed(2)))} className="h-9 w-9 rounded-md border bg-white text-sm">+</button>
          </div>
        </header>

        <section className="flex-1 overflow-auto p-6">
          {loading && (
            <div className="h-full flex items-center justify-center text-sm text-slate-500">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Cargando esquema real…
            </div>
          )}
          {error && <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

          {!loading && !error && (
            <div className="origin-top-left" style={{ transform: `scale(${scale})`, width: canvasWidth, height: canvasHeight }}>
              <div className="relative" style={{ width: canvasWidth, height: canvasHeight }}>
                <svg className="absolute inset-0 pointer-events-none" width={canvasWidth} height={canvasHeight}>
                  {relations.map((rel) => {
                    const a = positions.get(rel.from);
                    const b = positions.get(rel.to);
                    if (!a || !b) return null;
                    const x1 = a.x + CARD_WIDTH / 2;
                    const y1 = a.y + CARD_HEIGHT / 2;
                    const x2 = b.x + CARD_WIDTH / 2;
                    const y2 = b.y + CARD_HEIGHT / 2;
                    return <line key={`${rel.from}-${rel.to}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(148 163 184)" strokeWidth="1.5" />;
                  })}
                </svg>

                {tables.map((table) => {
                  const pos = positions.get(table.name)!;
                  return (
                    <div
                      key={table.name}
                      className="absolute rounded-md border border-slate-300 bg-white shadow-sm overflow-hidden"
                      style={{ left: pos.x, top: pos.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
                    >
                      <div className="h-10 px-3 flex items-center justify-between border-b bg-slate-100">
                        <span className="text-sm font-semibold text-slate-900 truncate">{table.name}</span>
                        <span className="text-[10px] text-slate-500">{table.columns.length}</span>
                      </div>
                      <div className="h-[290px] overflow-auto py-1">
                        {table.columns.map((column) => (
                          <div key={column.column_name} className="px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-slate-50">
                            <span className="w-4 shrink-0 flex justify-center">
                              {column.is_primary_key ? (
                                <KeyRound className="h-3.5 w-3.5 text-slate-700" />
                              ) : column.foreign_table_name ? (
                                <Link2 className="h-3.5 w-3.5 text-slate-500" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-slate-800" title={column.column_name}>{column.column_name}</span>
                            <span className="shrink-0 text-[10px] text-slate-400" title={column.data_type}>{column.udt_name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
