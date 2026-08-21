import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// Entry/auth stay eager so login and OAuth callbacks are always immediate.
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import MeliCallback from "./pages/MeliCallback";
import MercadoPagoCallback from "./pages/MercadoPagoCallback";
import NotFound from "./pages/NotFound";

// Operational modules are route-split. Opening Tesorería no downloads the code
// for Documentos, Conciliación, Devoluciones, Sync, etc.
const PageSyncCanonical = lazy(() => import("./pages/PageSyncCanonical"));
const PageVentas = lazy(() => import("./pages/PageVentas"));
const ConfigNew = lazy(() => import("./pages/ConfigNew"));
const PageTesoreria = lazy(() => import("./pages/PageTesoreria"));
const PageDevoluciones = lazy(() => import("./pages/PageDevoluciones"));
const PageDocumentos = lazy(() => import("./pages/PageDocumentos"));
const PageDocumentosResumen = lazy(() => import("./pages/PageDocumentosResumen"));
const PageConciliacion = lazy(() => import("./pages/PageConciliacion"));
const PageFeedback = lazy(() => import("./pages/PageFeedback"));
const PageModeloDatos = lazy(() => import("./pages/PageModeloDatos"));
const PageImportMeliBackup = lazy(() => import("./pages/PageImportMeliBackup"));
const PageProfile = lazy(() => import("./pages/PageProfile"));

const queryClient = new QueryClient();

const RouteLoading = () => (
  <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-400">
    Cargando módulo…
  </div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<Auth />} />

            <Route path="/resumen" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/ventas" element={<PageVentas />} />
            <Route path="/documentos" element={<PageDocumentosResumen />} />
            <Route path="/documentos/listado" element={<PageDocumentos />} />
            <Route path="/conciliacion" element={<PageConciliacion />} />
            <Route path="/tesoreria" element={<PageTesoreria />} />
            <Route path="/trazabilidad" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/liquidaciones" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/billing" element={<Navigate to="/tesoreria?tab=cargos" replace />} />
            <Route path="/devoluciones" element={<PageDevoluciones />} />

            <Route path="/sync" element={<PageSyncCanonical />} />
            <Route path="/pipeline" element={<Navigate to="/sync" replace />} />
            <Route path="/workflow" element={<Navigate to="/sync" replace />} />

            <Route path="/modelo-datos" element={<PageModeloDatos />} />
            <Route path="/arquitectura" element={<Navigate to="/modelo-datos" replace />} />
            <Route path="/asistente" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/config" element={<ConfigNew />} />
            <Route path="/perfil" element={<PageProfile />} />
            <Route path="/admin/import-meli" element={<PageImportMeliBackup />} />
            <Route path="/feedback" element={<PageFeedback />} />

            <Route path="/meli-callback" element={<MeliCallback />} />
            <Route path="/mercadopago/callback" element={<MercadoPagoCallback />} />

            <Route path="/dashboard" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/sandbox-mp" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/mercadolibre" element={<Navigate to="/ventas" replace />} />
            <Route path="/bsale" element={<Navigate to="/ventas" replace />} />
            <Route path="/flujo" element={<Navigate to="/tesoreria" replace />} />
            <Route path="/sales" element={<Navigate to="/mercadolibre" replace />} />
            <Route path="/payments" element={<Navigate to="/sync" replace />} />
            <Route path="/payments/:id" element={<Navigate to="/sync" replace />} />
            <Route path="/orders/:id" element={<Navigate to="/mercadolibre" replace />} />
            <Route path="/bsale-documents" element={<Navigate to="/bsale" replace />} />
            <Route path="/reports/*" element={<Navigate to="/sync" replace />} />
            <Route path="/pending-sales" element={<Navigate to="/mercadolibre" replace />} />
            <Route path="/sales/issues" element={<Navigate to="/mercadolibre" replace />} />
            <Route path="/closing" element={<Navigate to="/sync" replace />} />
            <Route path="/ledger" element={<Navigate to="/sync" replace />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
