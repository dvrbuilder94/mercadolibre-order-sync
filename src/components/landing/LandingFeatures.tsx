import { FileText, AlertTriangle, Table, Lock } from "lucide-react";

const features = [
  {
    icon: FileText,
    text: "Vincula ventas con boletas, facturas y notas de crédito",
  },
  {
    icon: AlertTriangle,
    text: "Detecta diferencias y documentos faltantes",
  },
  {
    icon: Table,
    text: "Reduce trabajo manual y uso de Excel",
  },
  {
    icon: Lock,
    text: "Integración segura con Bsale",
  },
];

export const LandingFeatures = () => {
  return (
    <section className="py-20 md:py-28 border-b border-border">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl text-center">
            ¿Qué hace Quadra?
          </h2>
          
          <p className="mt-6 text-muted-foreground text-center text-lg leading-relaxed">
            Quadra reconcilia automáticamente las ventas de marketplaces con los documentos 
            tributarios existentes en Bsale para simplificar el cierre contable mensual.
          </p>

          <ul className="mt-12 grid gap-6 sm:grid-cols-2">
            {features.map((feature, index) => (
              <li 
                key={index}
                className="flex items-start gap-4 p-4 rounded-lg bg-muted/50"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <feature.icon className="h-5 w-5 text-primary" />
                </div>
                <span className="text-foreground leading-relaxed pt-2">
                  {feature.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
};
