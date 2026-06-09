import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import SellerDashboard from "./pages/SellerDashboard";
import Payments from "./pages/Payments";
import PaymentDetail from "./pages/PaymentDetail";
import OrderDetail from "./pages/OrderDetail";
import Sales from "./pages/Sales";
import Config from "./pages/Config";
import MeliCallback from "./pages/MeliCallback";
import BsaleDocuments from "./pages/BsaleDocuments";
import Reports from "./pages/Reports";
import ReportIVA from "./pages/ReportIVA";
import ReportConciliation from "./pages/ReportConciliation";
import ReportSalesLedger from "./pages/ReportSalesLedger";
import ReportFees from "./pages/ReportFees";
import ReportTaxCross from "./pages/ReportTaxCross";
import Debug from "./pages/Debug";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Landing page */}
          <Route path="/" element={<Landing />} />
          <Route path="/auth" element={<Auth />} />
          
          {/* MVP Views */}
          <Route path="/dashboard" element={<SellerDashboard />} />
          <Route path="/sales" element={<Sales />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/payments/:paymentId" element={<PaymentDetail />} />
          <Route path="/orders/:orderId" element={<OrderDetail />} />
          <Route path="/bsale-documents" element={<BsaleDocuments />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/iva" element={<ReportIVA />} />
          <Route path="/reports/conciliation" element={<ReportConciliation />} />
          <Route path="/reports/sales-ledger" element={<ReportSalesLedger />} />
          <Route path="/reports/fees" element={<ReportFees />} />
          <Route path="/reports/tax-cross" element={<ReportTaxCross />} />
          <Route path="/config" element={<Config />} />
          <Route path="/debug" element={<Debug />} />
          
          {/* Redirects from old routes */}
          <Route path="/pending-sales" element={<Navigate to="/sales?filter=pendientes" replace />} />
          <Route path="/sales/issues" element={<Navigate to="/sales?filter=sin_documento" replace />} />
          <Route path="/closing" element={<Navigate to="/dashboard" replace />} />
          <Route path="/ledger" element={<Navigate to="/sales" replace />} />
          
          {/* OAuth Callback */}
          <Route path="/meli-callback" element={<MeliCallback />} />
          
          {/* Catch-all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
