import { MapPin, Store, Zap } from "lucide-react";

const reasons = [
  {
    icon: MapPin,
    title: "Diseñado para la realidad tributaria chilena",
    description: "Entendemos boletas, facturas, notas de crédito y los requisitos del SII.",
  },
  {
    icon: Store,
    title: "Enfocado en vendedores de marketplaces",
    description: "MercadoLibre, Falabella, Shopify y más. Donde vendes, Quadra cuadra.",
  },
  {
    icon: Zap,
    title: "Simple, rápido y sin riesgo",
    description: "Implementación en minutos. Sin modificar tus sistemas actuales.",
  },
];

export const LandingWhy = () => {
  return (
    <section className="py-20 md:py-28 border-b border-border">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl text-center">
            ¿Por qué Quadra?
          </h2>

          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {reasons.map((reason, index) => (
              <div 
                key={index}
                className="flex flex-col items-center text-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <reason.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mt-4 font-medium text-foreground">
                  {reason.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {reason.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
