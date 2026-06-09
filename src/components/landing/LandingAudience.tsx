import { Store, Calculator, Clock, Eye, AlertCircle, FileCheck, Zap, BarChart3 } from "lucide-react";

const audiences = [
  {
    icon: Store,
    title: "Vendedores de marketplaces",
    benefits: [
      { icon: Clock, text: "Cierre mensual más rápido" },
      { icon: Eye, text: "Visibilidad clara de impuestos" },
      { icon: Zap, text: "Menos fricción operativa" },
    ],
  },
  {
    icon: Calculator,
    title: "Contadores y equipos financieros",
    benefits: [
      { icon: FileCheck, text: "Información confiable" },
      { icon: AlertCircle, text: "Menos errores y reprocesos" },
      { icon: BarChart3, text: "Trazabilidad completa por período" },
    ],
  },
];

export const LandingAudience = () => {
  return (
    <section className="py-20 md:py-28 border-b border-border">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl text-center">
            ¿Para quién es?
          </h2>

          <div className="mt-12 grid gap-8 md:grid-cols-2">
            {audiences.map((audience, index) => (
              <div 
                key={index}
                className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-soft)]"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <audience.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-semibold text-foreground">
                    {audience.title}
                  </h3>
                </div>

                <ul className="mt-6 space-y-4">
                  {audience.benefits.map((benefit, benefitIndex) => (
                    <li key={benefitIndex} className="flex items-center gap-3">
                      <benefit.icon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-foreground">
                        {benefit.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
