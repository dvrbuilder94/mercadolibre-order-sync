import { Eye, FileX, UserCheck } from "lucide-react";

const trustItems = [
  {
    icon: Eye,
    title: "Acceso solo lectura",
    description: "Quadra únicamente lee información de Bsale, sin modificar nada.",
  },
  {
    icon: FileX,
    title: "No se crean ni modifican documentos",
    description: "Tus documentos tributarios permanecen intactos. Quadra no tiene permisos de escritura.",
  },
  {
    icon: UserCheck,
    title: "El control siempre queda en el usuario",
    description: "Tú decides qué vincular y cuándo. Sin automatizaciones sorpresivas.",
  },
];

export const LandingTrust = () => {
  return (
    <section className="py-20 md:py-28 bg-muted/30 border-b border-border">
      <div className="container px-4 md:px-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl text-center">
            Integración segura con Bsale
          </h2>
          
          <p className="mt-4 text-muted-foreground text-center">
            Diseñado para la tranquilidad de tu negocio
          </p>

          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {trustItems.map((item, index) => (
              <div 
                key={index}
                className="flex flex-col items-center text-center p-6"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <item.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mt-4 font-medium text-foreground">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
