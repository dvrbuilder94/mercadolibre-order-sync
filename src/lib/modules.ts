export const MODULE_LABEL: Record<string, string> = {
  "/tesoreria": "Tesorería",
  "/ventas": "Ventas",
  "/documentos": "Documentos",
  "/conciliacion": "Revisión",
  "/devoluciones": "Devoluciones",
  "/config": "Conexiones",
  "/workflow": "Workflow",
  "/pipeline": "Sincronización",
  "/feedback": "Feedback",
};

export function moduleFromPath(pathname: string): string {
  const base = "/" + (pathname.split("/")[1] || "");
  return MODULE_LABEL[base] ?? (base === "/" ? "Inicio" : base.replace("/", ""));
}