import { useState } from "react";
import { FileSpreadsheet, Download, Loader2 } from "lucide-react";
import * as XLSX from "xlsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { es } from "date-fns/locale";

interface DashboardExportProps {
  period: string;
}

// Interfaces for data types
interface SummaryData {
  period: string;
  grossSales: number;
  commissions: number;
  financingFees: number;
  totalFees: number;
  netSales: number;
  ivaDebito: number;
  cashReceived: number;
  cashRetained: number;
  docsCount: number;
  linkedDocsCount: number;
}

interface SettlementRow {
  payment_date: string;
  external_payment_id: string | null;
  payment_provider: string | null;
  sales_count: number;
  gross_amount: number | null;
  fees_amount: number | null;
  net_amount: number | null;
  sales_without_doc_count: number;
}

interface TaxCrossRow {
  order_date: string;
  reference_id: string;
  customer_name: string;
  order_amount: number;
  document_type: string | null;
  document_number: string | null;
  document_date: string | null;
  doc_net: number | null;
  doc_iva: number | null;
  doc_total: number | null;
  match_source: string | null;
}

interface IVARow {
  document_type: string;
  cantidad: number;
  base_imponible: number;
  iva: number;
  total: number;
}

interface ConciliationRow {
  periodo: string;
  ventas_brutas: number;
  fees: number;
  neto_esperado: number;
  pagos_recibidos: number;
  diferencia: number;
  cantidad_ventas: number;
  cantidad_pagos: number;
}

interface SalesLedgerRow {
  document_type: string;
  document_number: string;
  document_date: string;
  client_tax_id: string | null;
  client_name: string | null;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
}

export function DashboardExport({ period }: DashboardExportProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStep, setProgressStep] = useState("");

  // Calculate date range from period
  const getDateRange = (period: string) => {
    const [year, month] = period.split("-").map(Number);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    return { startDate, endDate };
  };

  // Query 1: Fetch summary data for Resumen Contable
  const fetchSummaryData = async (period: string): Promise<SummaryData> => {
    const { startDate, endDate } = getDateRange(period);

    // a) Totales de ventas (excluir canceladas)
    const { data: orders } = await supabase
      .from('orders')
      .select('id, gross_amount, net_amount, commission_amount, financing_fee')
      .gte('order_date', startDate.toISOString())
      .lte('order_date', endDate.toISOString())
      .neq('status', 'cancelled');

    // b) Totales de pagos recibidos
    const { data: payments } = await supabase
      .from('payments')
      .select('net_amount')
      .gte('payment_date', startDate.toISOString())
      .lte('payment_date', endDate.toISOString());

    // c) IVA de documentos del período
    const { data: taxDocs } = await supabase
      .from('tax_documents')
      .select('tax_amount')
      .gte('document_date', startDate.toISOString().split('T')[0])
      .lte('document_date', endDate.toISOString().split('T')[0]);

    // d) Contar documentos emitidos
    const { count: docsCount } = await supabase
      .from('tax_documents')
      .select('*', { count: 'exact', head: true })
      .gte('document_date', startDate.toISOString().split('T')[0])
      .lte('document_date', endDate.toISOString().split('T')[0]);

    // e) Contar documentos vinculados
    const { count: linkedDocsCount } = await supabase
      .from('order_tax_documents')
      .select('*', { count: 'exact', head: true });

    // f) Órdenes con pago registrado (para calcular retenido)
    const { data: paymentSales } = await supabase
      .from('payment_sales')
      .select('sale_id');

    const paidSaleIds = new Set(paymentSales?.map(ps => ps.sale_id) || []);
    const confirmedOrders = orders || [];

    // Calcular totales
    const grossSales = confirmedOrders.reduce(
      (sum, o) => sum + (Number(o.gross_amount) || 0), 0
    );
    const commissions = confirmedOrders.reduce(
      (sum, o) => sum + (Number(o.commission_amount) || 0), 0
    );
    const financingFees = confirmedOrders.reduce(
      (sum, o) => sum + (Number(o.financing_fee) || 0), 0
    );
    const totalFees = commissions + financingFees;
    const netSales = grossSales - totalFees;

    const ivaDebito = (taxDocs || []).reduce(
      (sum, d) => sum + (Number(d.tax_amount) || 0), 0
    );
    const cashReceived = (payments || []).reduce(
      (sum, p) => sum + (Number(p.net_amount) || 0), 0
    );

    // Cash retenido = ventas sin pago (usar net_amount para coherencia con SellerDashboard)
    const retainedOrders = confirmedOrders.filter(o => !paidSaleIds.has(o.id));
    const cashRetained = retainedOrders.reduce(
      (sum, o) => sum + (Number(o.net_amount) || 0), 0
    );

    return {
      period,
      grossSales,
      commissions,
      financingFees,
      totalFees,
      netSales,
      ivaDebito,
      cashReceived,
      cashRetained,
      docsCount: docsCount || 0,
      linkedDocsCount: linkedDocsCount || 0,
    };
  };

  // Query 2: Fetch settlement details for Detalle Liquidaciones
  const fetchSettlementDetails = async (period: string): Promise<SettlementRow[]> => {
    const { startDate, endDate } = getDateRange(period);

    // Obtener pagos del período
    const { data: payments } = await supabase
      .from('payments')
      .select('id, payment_date, external_payment_id, payment_provider, gross_amount, fees_amount, net_amount')
      .gte('payment_date', startDate.toISOString())
      .lte('payment_date', endDate.toISOString())
      .order('payment_date', { ascending: false });

    if (!payments || payments.length === 0) return [];

    // Obtener ventas por pago
    const { data: paymentSales } = await supabase
      .from('payment_sales')
      .select('payment_id, sale_id');

    // Obtener documentos vinculados
    const { data: orderDocs } = await supabase
      .from('order_tax_documents')
      .select('order_id');

    const documentedSaleIds = new Set(orderDocs?.map(d => d.order_id) || []);

    // Calcular stats por payment_id
    const salesByPayment = new Map<string, { total: number; withoutDoc: number }>();
    (paymentSales || []).forEach(ps => {
      const current = salesByPayment.get(ps.payment_id) || { total: 0, withoutDoc: 0 };
      current.total++;
      if (!documentedSaleIds.has(ps.sale_id)) {
        current.withoutDoc++;
      }
      salesByPayment.set(ps.payment_id, current);
    });

    return payments.map(p => {
      const stats = salesByPayment.get(p.id) || { total: 0, withoutDoc: 0 };
      return {
        payment_date: p.payment_date,
        external_payment_id: p.external_payment_id,
        payment_provider: p.payment_provider,
        sales_count: stats.total,
        gross_amount: p.gross_amount,
        fees_amount: p.fees_amount,
        net_amount: p.net_amount,
        sales_without_doc_count: stats.withoutDoc,
      };
    });
  };

  // Query 3: Fetch tax cross reference for Cruce Tributario
  const fetchTaxCrossReference = async (period: string): Promise<TaxCrossRow[]> => {
    const { startDate, endDate } = getDateRange(period);

    // Obtener órdenes con documentos vinculados
    const { data: orders } = await supabase
      .from('orders')
      .select(`
        order_date,
        external_sale_id,
        order_id,
        customer_name,
        gross_amount,
        order_tax_documents (
          match_source,
          tax_document_id
        )
      `)
      .gte('order_date', startDate.toISOString())
      .lte('order_date', endDate.toISOString())
      .neq('status', 'cancelled')
      .order('order_date', { ascending: false });

    if (!orders || orders.length === 0) return [];

    // Obtener IDs de documentos vinculados
    const taxDocIds = orders
      .flatMap(o => o.order_tax_documents || [])
      .map(otd => otd.tax_document_id)
      .filter(Boolean);

    // Obtener detalles de documentos
    let taxDocsMap: Record<string, any> = {};
    if (taxDocIds.length > 0) {
      const { data: taxDocs } = await supabase
        .from('tax_documents')
        .select('id, document_type, document_number, document_date, net_amount, tax_amount, total_amount')
        .in('id', taxDocIds);

      taxDocsMap = (taxDocs || []).reduce((acc, doc) => {
        acc[doc.id] = doc;
        return acc;
      }, {} as Record<string, any>);
    }

    // Combinar data
    return orders.map(order => {
      const linkedDoc = order.order_tax_documents?.[0];
      const taxDoc = linkedDoc ? taxDocsMap[linkedDoc.tax_document_id] : null;

      return {
        order_date: order.order_date,
        reference_id: order.external_sale_id || order.order_id,
        customer_name: order.customer_name,
        order_amount: Number(order.gross_amount) || 0,
        document_type: taxDoc?.document_type || null,
        document_number: taxDoc?.document_number || null,
        document_date: taxDoc?.document_date || null,
        doc_net: taxDoc ? Number(taxDoc.net_amount) : null,
        doc_iva: taxDoc ? Number(taxDoc.tax_amount) : null,
        doc_total: taxDoc ? Number(taxDoc.total_amount) : null,
        match_source: linkedDoc?.match_source || null,
      };
    });
  };

  // Query 4: Fetch IVA summary data
  const fetchIVASummary = async (period: string): Promise<IVARow[]> => {
    const { startDate, endDate } = getDateRange(period);
    
    const { data: taxDocs } = await supabase
      .from('tax_documents')
      .select('document_type, net_amount, tax_amount, total_amount')
      .gte('document_date', startDate.toISOString().split('T')[0])
      .lte('document_date', endDate.toISOString().split('T')[0])
      .eq('status', 'issued');

    // Aggregate by document type
    const aggregated = (taxDocs || []).reduce((acc, doc) => {
      const type = doc.document_type;
      if (!acc[type]) {
        acc[type] = { document_type: type, cantidad: 0, base_imponible: 0, iva: 0, total: 0 };
      }
      acc[type].cantidad += 1;
      acc[type].base_imponible += Number(doc.net_amount) || 0;
      acc[type].iva += Number(doc.tax_amount) || 0;
      acc[type].total += Number(doc.total_amount) || 0;
      return acc;
    }, {} as Record<string, IVARow>);

    return Object.values(aggregated);
  };

  // Query 5: Fetch conciliation data
  const fetchConciliationData = async (period: string): Promise<ConciliationRow> => {
    const { startDate, endDate } = getDateRange(period);

    // Fetch orders (ventas)
    const { data: orders } = await supabase
      .from('orders')
      .select('gross_amount, commission_amount, financing_fee, net_amount')
      .gte('order_date', startDate.toISOString())
      .lte('order_date', endDate.toISOString())
      .neq('status', 'cancelled');

    // Fetch payments
    const { data: payments } = await supabase
      .from('payments')
      .select('net_amount')
      .gte('payment_date', startDate.toISOString())
      .lte('payment_date', endDate.toISOString());

    const ventasBrutas = (orders || []).reduce((sum, o) => sum + (Number(o.gross_amount) || 0), 0);
    const fees = (orders || []).reduce(
      (sum, o) => sum + (Number(o.commission_amount) || 0) + (Number(o.financing_fee) || 0), 0
    );
    const netoEsperado = ventasBrutas - fees;
    const pagosRecibidos = (payments || []).reduce((sum, p) => sum + (Number(p.net_amount) || 0), 0);
    const diferencia = netoEsperado - pagosRecibidos;

    return {
      periodo: period,
      ventas_brutas: ventasBrutas,
      fees: fees,
      neto_esperado: netoEsperado,
      pagos_recibidos: pagosRecibidos,
      diferencia: diferencia,
      cantidad_ventas: orders?.length || 0,
      cantidad_pagos: payments?.length || 0,
    };
  };

  // Query 6: Fetch sales ledger (libro de ventas)
  const fetchSalesLedger = async (period: string): Promise<SalesLedgerRow[]> => {
    const { startDate, endDate } = getDateRange(period);
    
    const { data: taxDocs } = await supabase
      .from('tax_documents')
      .select('document_type, document_number, document_date, client_tax_id, client_name, net_amount, tax_amount, total_amount')
      .gte('document_date', startDate.toISOString().split('T')[0])
      .lte('document_date', endDate.toISOString().split('T')[0])
      .eq('status', 'issued')
      .order('document_date', { ascending: true })
      .order('document_number', { ascending: true });

    return (taxDocs || []).map(doc => ({
      document_type: doc.document_type,
      document_number: doc.document_number,
      document_date: doc.document_date,
      client_tax_id: doc.client_tax_id,
      client_name: doc.client_name,
      net_amount: Number(doc.net_amount) || 0,
      tax_amount: Number(doc.tax_amount) || 0,
      total_amount: Number(doc.total_amount) || 0,
    }));
  };

  // Channel label helper
  const getChannelLabel = (provider: string | null): string => {
    const labels: Record<string, string> = {
      'MERCADOPAGO': 'MercadoLibre',
      'STRIPE': 'Shopify',
      'SANTANDER': 'Falabella',
      'WEBPAY': 'WebPay',
    };
    return labels[provider || ''] || provider || 'Otro';
  };

  // SII document codes
  const siiCodes: Record<string, { code: number; label: string }> = {
    boleta: { code: 39, label: "Boleta Electrónica" },
    factura: { code: 33, label: "Factura Electrónica" },
    factura_exenta: { code: 34, label: "Factura Exenta" },
    nota_credito: { code: 61, label: "Nota de Crédito" },
    nota_debito: { code: 56, label: "Nota de Débito" },
  };

  // Generate multi-sheet Excel workbook
  const generateMultiSheetReport = (
    summary: SummaryData,
    settlements: SettlementRow[],
    taxCross: TaxCrossRow[],
    ivaData: IVARow[],
    conciliationData: ConciliationRow,
    salesLedger: SalesLedgerRow[]
  ): XLSX.WorkBook => {
    const workbook = XLSX.utils.book_new();

    // Format period for display
    const [year, month] = summary.period.split("-");
    const monthName = format(new Date(parseInt(year), parseInt(month) - 1), 'MMMM yyyy', { locale: es });

    // Hoja 1: Resumen Contable
    const summaryData = [
      { Concepto: 'Período', Valor: monthName },
      { Concepto: '', Valor: '' },
      { Concepto: '--- VENTAS ---', Valor: '' },
      { Concepto: 'Ventas Brutas', Valor: summary.grossSales },
      { Concepto: 'Comisiones Canal', Valor: summary.commissions },
      { Concepto: 'Fees Financiamiento', Valor: summary.financingFees },
      { Concepto: 'Total Fees', Valor: summary.totalFees },
      { Concepto: 'Ventas Netas', Valor: summary.netSales },
      { Concepto: '', Valor: '' },
      { Concepto: '--- TRIBUTARIO ---', Valor: '' },
      { Concepto: 'IVA Débito (Documentos)', Valor: summary.ivaDebito },
      { Concepto: 'Documentos Emitidos', Valor: summary.docsCount },
      { Concepto: 'Documentos Vinculados a Ventas', Valor: summary.linkedDocsCount },
      { Concepto: '', Valor: '' },
      { Concepto: '--- FLUJO DE CAJA ---', Valor: '' },
      { Concepto: 'Pagos Recibidos (Neto)', Valor: summary.cashReceived },
      { Concepto: 'Cash Retenido (Por Liberar)', Valor: summary.cashRetained },
    ];
    const summarySheet = XLSX.utils.json_to_sheet(summaryData);
    
    // Set column widths
    summarySheet['!cols'] = [{ wch: 35 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen Contable');

    // Hoja 2: Detalle por Liquidación
    const settlementsFormatted = settlements.map(s => ({
      'Fecha Liquidación': s.payment_date ? format(new Date(s.payment_date), 'dd/MM/yyyy') : '',
      'ID Liquidación': s.external_payment_id || 'N/A',
      'Cant. Ventas': s.sales_count,
      'Monto Bruto': s.gross_amount || 0,
      'Fees': s.fees_amount || 0,
      'Neto Recibido': s.net_amount || 0,
    }));

    // Add totals row
    if (settlementsFormatted.length > 0) {
      const totals = settlements.reduce(
        (acc, s) => ({
          gross: acc.gross + (Number(s.gross_amount) || 0),
          fees: acc.fees + (Number(s.fees_amount) || 0),
          net: acc.net + (Number(s.net_amount) || 0),
          sales: acc.sales + s.sales_count,
        }),
        { gross: 0, fees: 0, net: 0, sales: 0 }
      );
      settlementsFormatted.push({
        'Fecha Liquidación': 'TOTAL',
        'ID Liquidación': '',
        'Cant. Ventas': totals.sales,
        'Monto Bruto': totals.gross,
        'Fees': totals.fees,
        'Neto Recibido': totals.net,
      });
    }

    const settlementsSheet = XLSX.utils.json_to_sheet(
      settlementsFormatted.length > 0 ? settlementsFormatted : [{ 'Mensaje': 'Sin liquidaciones en este período' }]
    );
    settlementsSheet['!cols'] = [{ wch: 18 }, { wch: 25 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(workbook, settlementsSheet, 'Detalle Liquidaciones');

    // Hoja 3: Cruce Tributario
    const taxCrossFormatted = taxCross.map(t => {
      const hasDoc = t.doc_total !== null;
      const cuadra = hasDoc 
        ? (Math.abs(t.order_amount - (t.doc_total || 0)) < 100 ? 'SÍ' : 'REVISAR')
        : 'SIN DOC';

      return {
        'Fecha Venta': t.order_date ? format(new Date(t.order_date), 'dd/MM/yyyy') : '',
        'ID MercadoLibre': t.reference_id,
        'Cliente': t.customer_name,
        'Monto Venta': t.order_amount,
        'Tipo Doc': t.document_type || '',
        'N° Doc': t.document_number || '',
        'Fecha Doc': t.document_date ? format(new Date(t.document_date), 'dd/MM/yyyy') : '',
        'Neto Doc': t.doc_net ?? '',
        'IVA Doc': t.doc_iva ?? '',
        'Total Doc': t.doc_total ?? '',
        'Vinculación': t.match_source || '',
        '¿Cuadra?': cuadra,
      };
    });

    const taxCrossSheet = XLSX.utils.json_to_sheet(
      taxCrossFormatted.length > 0 ? taxCrossFormatted : [{ 'Mensaje': 'Sin ventas en este período' }]
    );
    taxCrossSheet['!cols'] = [
      { wch: 12 }, { wch: 15 }, { wch: 25 }, { wch: 12 },
      { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 12 },
      { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(workbook, taxCrossSheet, 'Cruce Tributario');

    // Hoja 4: Conciliación de Liquidaciones (Multi-canal)
    const liquidationsData = settlements.map(s => ({
      'Canal': getChannelLabel(s.payment_provider),
      'Fecha Pago': s.payment_date ? format(new Date(s.payment_date), 'dd/MM/yyyy') : '',
      'ID Liquidación': s.external_payment_id || 'N/A',
      'Monto Bruto': s.gross_amount || 0,
      'Fees': s.fees_amount || 0,
      'Neto Recibido': s.net_amount || 0,
      'Ventas Incluidas': s.sales_count,
      'Estado': s.sales_without_doc_count === 0 ? 'Conciliada' : 'Pendiente',
    }));

    const liquidationsSheet = XLSX.utils.json_to_sheet(
      liquidationsData.length > 0 ? liquidationsData : [{ 'Mensaje': 'Sin liquidaciones en este período' }]
    );
    liquidationsSheet['!cols'] = [
      { wch: 15 }, { wch: 12 }, { wch: 25 }, { wch: 15 },
      { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(workbook, liquidationsSheet, 'Liquidaciones');

    // Hoja 5: Reporte IVA
    const ivaFormatted = ivaData.map(row => ({
      'Código SII': siiCodes[row.document_type]?.code || '',
      'Tipo Documento': siiCodes[row.document_type]?.label || row.document_type,
      'Cantidad': row.cantidad,
      'Base Imponible': row.base_imponible,
      'IVA 19%': row.iva,
      'Total': row.total,
    }));

    if (ivaFormatted.length > 0) {
      const ivaTotals = ivaData.reduce(
        (acc, row) => ({
          cantidad: acc.cantidad + row.cantidad,
          base_imponible: acc.base_imponible + row.base_imponible,
          iva: acc.iva + row.iva,
          total: acc.total + row.total,
        }),
        { cantidad: 0, base_imponible: 0, iva: 0, total: 0 }
      );
      ivaFormatted.push({
        'Código SII': '',
        'Tipo Documento': 'TOTAL',
        'Cantidad': ivaTotals.cantidad,
        'Base Imponible': ivaTotals.base_imponible,
        'IVA 19%': ivaTotals.iva,
        'Total': ivaTotals.total,
      });
    }

    const ivaSheet = XLSX.utils.json_to_sheet(
      ivaFormatted.length > 0 ? ivaFormatted : [{ 'Mensaje': 'Sin documentos tributarios en este período' }]
    );
    ivaSheet['!cols'] = [{ wch: 12 }, { wch: 25 }, { wch: 10 }, { wch: 18 }, { wch: 15 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(workbook, ivaSheet, 'Reporte IVA');

    // Hoja 6: Conciliación
    const conciliationFormatted = [{
      'Período': conciliationData.periodo,
      'Ventas Brutas': conciliationData.ventas_brutas,
      'Fees Marketplace': conciliationData.fees,
      'Neto Esperado': conciliationData.neto_esperado,
      'Pagos Recibidos': conciliationData.pagos_recibidos,
      'Diferencia': conciliationData.diferencia,
      'Cant. Ventas': conciliationData.cantidad_ventas,
      'Cant. Pagos': conciliationData.cantidad_pagos,
      'Estado': Math.abs(conciliationData.diferencia) < 100 ? 'Conciliado' : conciliationData.diferencia > 0 ? 'Timing' : 'Revisar',
    }];

    const conciliationSheet = XLSX.utils.json_to_sheet(conciliationFormatted);
    conciliationSheet['!cols'] = [
      { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 15 },
      { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(workbook, conciliationSheet, 'Conciliación');

    // Hoja 7: Libro de Ventas (formato SII)
    const salesLedgerFormatted = salesLedger.map(row => ({
      'Tipo Doc': siiCodes[row.document_type]?.code || '',
      'N° Documento': row.document_number,
      'Fecha': row.document_date,
      'RUT': row.client_tax_id || '',
      'Razón Social': row.client_name || '',
      'Monto Neto': row.net_amount,
      'IVA': row.tax_amount,
      'Monto Total': row.total_amount,
    }));

    if (salesLedgerFormatted.length > 0) {
      const ledgerTotals = salesLedger.reduce(
        (acc, row) => ({
          net_amount: acc.net_amount + row.net_amount,
          tax_amount: acc.tax_amount + row.tax_amount,
          total_amount: acc.total_amount + row.total_amount,
        }),
        { net_amount: 0, tax_amount: 0, total_amount: 0 }
      );
      salesLedgerFormatted.push({
        'Tipo Doc': '',
        'N° Documento': 'TOTAL',
        'Fecha': '',
        'RUT': '',
        'Razón Social': '',
        'Monto Neto': ledgerTotals.net_amount,
        'IVA': ledgerTotals.tax_amount,
        'Monto Total': ledgerTotals.total_amount,
      });
    }

    const salesLedgerSheet = XLSX.utils.json_to_sheet(
      salesLedgerFormatted.length > 0 ? salesLedgerFormatted : [{ 'Mensaje': 'Sin documentos en este período' }]
    );
    salesLedgerSheet['!cols'] = [
      { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 14 },
      { wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 15 }
    ];
    XLSX.utils.book_append_sheet(workbook, salesLedgerSheet, 'Libro de Ventas');

    return workbook;
  };

  const handleExport = async () => {
    setLoading(true);
    setProgress(0);
    
    try {
      // Step 1: Fetch summary data
      setProgressStep("Calculando resumen contable...");
      setProgress(10);
      const summary = await fetchSummaryData(period);
      setProgress(25);

      // Step 2: Fetch settlement details
      setProgressStep("Obteniendo detalle de liquidaciones...");
      const settlements = await fetchSettlementDetails(period);
      setProgress(40);

      // Step 3: Fetch tax cross reference
      setProgressStep("Generando cruce tributario...");
      const taxCross = await fetchTaxCrossReference(period);
      setProgress(55);

      // Step 4: Fetch IVA summary
      setProgressStep("Calculando reporte IVA...");
      const ivaData = await fetchIVASummary(period);
      setProgress(70);

      // Step 5: Fetch conciliation data
      setProgressStep("Generando conciliación...");
      const conciliationData = await fetchConciliationData(period);
      setProgress(80);

      // Step 6: Fetch sales ledger
      setProgressStep("Generando libro de ventas...");
      const salesLedger = await fetchSalesLedger(period);
      setProgress(90);

      // Step 7: Generate Excel
      setProgressStep("Generando archivo Excel...");
      const workbook = generateMultiSheetReport(summary, settlements, taxCross, ivaData, conciliationData, salesLedger);
      setProgress(95);

      // Generate filename with period
      const [year, month] = period.split("-");
      const monthName = format(new Date(parseInt(year), parseInt(month) - 1), 'MMMM', { locale: es });
      const filename = `reporte-contador-${monthName}-${year}.xlsx`;

      // Download file
      XLSX.writeFile(workbook, filename);
      setProgress(100);

      // Show success toast with summary
      const salesWithDocs = taxCross.filter(t => t.doc_total !== null).length;
      toast({
        title: "Reporte descargado",
        description: `${taxCross.length} ventas, ${settlements.length} liquidaciones, ${salesWithDocs} documentos vinculados`,
      });
    } catch (error: any) {
      console.error('Error exporting report:', error);
      toast({
        variant: "destructive",
        title: "Error al exportar",
        description: error.message || "No se pudo generar el reporte",
      });
    } finally {
      setLoading(false);
      setProgress(0);
      setProgressStep("");
    }
  };

  return (
    <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <FileSpreadsheet className="h-6 w-6 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">Reporte Consolidado para Contador</CardTitle>
            <CardDescription>
              Excel con 7 hojas: Resumen, Liquidaciones, Cruce Tributario, IVA, Conciliación, Libro de Ventas
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && (
          <div className="space-y-2">
            <Progress value={progress} className="h-2" />
            <p className="text-sm text-muted-foreground">{progressStep}</p>
          </div>
        )}
        
        <Button 
          onClick={handleExport} 
          disabled={loading}
          size="lg"
          className="w-full sm:w-auto"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generando reporte...
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              Descargar reporte para mi contador
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
