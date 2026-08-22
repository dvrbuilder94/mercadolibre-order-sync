const sources = [
  { name: "Mercado Libre", logo: "https://cdn.simpleicons.org/mercadolibre/FFFFFF" },
  { name: "Shopify", logo: "https://cdn.simpleicons.org/shopify/FFFFFF" },
  { name: "Mercado Pago", logo: "https://cdn.simpleicons.org/mercadopago/FFFFFF" },
  { name: "Bsale", mark: "B" },
  { name: "Bancos", mark: "$" },
  { name: "APIs", mark: "<>" },
];

const modules = [
  {
    number: "01",
    title: "Ventas",
    description: "Órdenes y transacciones de todos tus canales en una sola vista.",
  },
  {
    number: "02",
    title: "Pagos",
    description: "Recaudación, comisiones, descuentos y liquidaciones conectadas a cada venta.",
  },
  {
    number: "03",
    title: "Conciliación",
    description: "Matching automático entre venta, pago, documento y movimiento bancario.",
  },
  {
    number: "04",
    title: "Documentos",
    description: "Boletas, facturas y notas de crédito vinculadas a la operación correcta.",
  },
  {
    number: "05",
    title: "Devoluciones",
    description: "Seguimiento de anulaciones, reembolsos y diferencias por resolver.",
  },
  {
    number: "06",
    title: "Cierre",
    description: "Cuadratura operativa y financiera lista para revisión y cierre mensual.",
  },
];

const SourceCard = ({ name, logo, mark }: { name: string; logo?: string; mark?: string }) => (
  <div className="flex h-14 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4">
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-[10px] font-semibold text-white">
      {logo ? <img src={logo} alt="" className="h-4 w-4 object-contain" /> : mark}
    </div>
    <span className="text-sm font-medium text-white/80">{name}</span>
  </div>
);

const Landing = () => {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-white selection:text-black">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 lg:px-8">
          <a href="/" className="text-xl font-semibold tracking-[-0.04em]">
            quadra<span className="text-white/45">X</span>
          </a>
          <a
            href="/auth"
            className="rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:border-white/40 hover:text-white"
          >
            Entrar
          </a>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-7xl px-6 pb-20 pt-20 lg:px-8 lg:pb-28 lg:pt-28">
          <div className="max-w-4xl">
            <p className="mb-5 text-xs font-medium uppercase tracking-[0.24em] text-white/40">
              Financial operations infrastructure
            </p>
            <h1 className="text-5xl font-medium leading-[0.95] tracking-[-0.055em] sm:text-6xl lg:text-8xl">
              Todo lo que vendes.
              <br />
              Todo lo que cobras.
              <br />
              <span className="text-white/35">Cuadrado.</span>
            </h1>
          </div>

          <div className="mt-20 overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.025] lg:mt-28">
            <div className="grid lg:grid-cols-[1fr_0.9fr_1.25fr]">
              <div className="border-b border-white/10 p-6 sm:p-8 lg:border-b-0 lg:border-r">
                <div className="mb-6 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-white/35">Fuentes</span>
                  <span className="text-xs text-white/25">Canales · ERP · Pagos</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                  {sources.map((source) => (
                    <SourceCard key={source.name} {...source} />
                  ))}
                </div>
              </div>

              <div className="relative flex min-h-[280px] items-center justify-center border-b border-white/10 p-8 lg:border-b-0 lg:border-r">
                <div className="absolute left-0 top-1/2 hidden h-px w-8 -translate-y-1/2 bg-white/20 lg:block" />
                <div className="absolute right-0 top-1/2 hidden h-px w-8 -translate-y-1/2 bg-white/20 lg:block" />
                <div className="text-center">
                  <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-[26px] border border-white/15 bg-white text-black shadow-[0_0_80px_rgba(255,255,255,0.08)]">
                    <span className="text-2xl font-semibold tracking-[-0.06em]">qX</span>
                  </div>
                  <div className="text-lg font-medium tracking-[-0.025em]">quadraX core</div>
                  <p className="mx-auto mt-2 max-w-[220px] text-sm leading-6 text-white/40">
                    Normaliza, conecta y concilia cada evento financiero.
                  </p>
                </div>
              </div>

              <div className="p-6 sm:p-8">
                <div className="mb-6 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-white/35">Salida</span>
                  <span className="text-xs text-white/25">Una operación</span>
                </div>
                <div className="space-y-2">
                  {modules.map((module) => (
                    <div
                      key={module.number}
                      className="grid grid-cols-[42px_1fr] gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4"
                    >
                      <span className="pt-0.5 font-mono text-xs text-white/30">{module.number}</span>
                      <div>
                        <h2 className="text-sm font-medium text-white">{module.title}</h2>
                        <p className="mt-1 text-xs leading-5 text-white/40">{module.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-white/10">
          <div className="mx-auto max-w-7xl px-6 py-20 lg:px-8 lg:py-28">
            <div className="mb-12 flex max-w-3xl flex-col gap-5">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-white/35">Módulos</p>
              <h2 className="text-4xl font-medium tracking-[-0.045em] sm:text-5xl">
                Una capa financiera sobre toda tu operación.
              </h2>
            </div>

            <div className="grid border-l border-t border-white/10 sm:grid-cols-2 lg:grid-cols-3">
              {modules.map((module) => (
                <article key={module.number} className="min-h-[230px] border-b border-r border-white/10 p-6 sm:p-8">
                  <div className="flex h-full flex-col justify-between">
                    <span className="font-mono text-xs text-white/25">{module.number}</span>
                    <div>
                      <h3 className="text-2xl font-medium tracking-[-0.035em]">{module.title}</h3>
                      <p className="mt-3 max-w-sm text-sm leading-6 text-white/40">{module.description}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-8 text-xs text-white/30 lg:px-8">
          <span>quadraX</span>
          <span>Connected financial operations.</span>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
