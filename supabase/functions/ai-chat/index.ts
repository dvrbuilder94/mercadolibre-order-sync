import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';
import { streamText } from 'npm:ai';
import { createLovableAiGatewayProvider, getLovableAiGatewayResponseHeaders, withLovableAiGatewayRunIdHeader } from '../_shared/ai-gateway.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Verify authentication and get user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { messages } = await req.json();

    // Query recent data to ground the assistant
    // 1. Get recent orders summary
    const { data: recentOrders } = await supabaseClient
      .from('orders')
      .select('id, order_id, order_date, gross_amount, net_amount, commission_amount, shipping_cost, status, channel, has_exact_data')
      .order('order_date', { ascending: false })
      .limit(10);

    // 2. Count active connections
    const { count: bsaleAccounts } = await supabaseClient.from('bsale_accounts').select('*', { count: 'exact', head: true });
    const { count: meliAccounts } = await supabaseClient.from('meli_accounts').select('*', { count: 'exact', head: true });

    // 3. Get monthly closings status
    const { data: recentClosings } = await supabaseClient
      .from('monthly_closings')
      .select('period, status, closed_at')
      .order('period', { ascending: false })
      .limit(3);

    // Grounding context
    const groundingContext = `
Información actual de la cuenta del usuario:
- Canales conectados: ${meliAccounts || 0} cuentas MercadoLibre, ${bsaleAccounts || 0} cuentas Bsale.
- Últimas 10 órdenes procesadas:
${(recentOrders || []).map(o => `  * Orden ID: ${o.order_id} (${o.channel}) - Fecha: ${o.order_date} - Bruto: $${o.gross_amount} - Neto: $${o.net_amount || 'N/D'} - Comisión: $${o.commission_amount || 'N/D'} - Estado: ${o.status} - Exacto: ${o.has_exact_data ? 'Sí' : 'No'}`).join('\n')}
- Cierres de período recientes:
${(recentClosings || []).map(c => `  * Período: ${c.period} - Estado: ${c.status} - Cerrado el: ${c.closed_at || 'N/D'}`).join('\n')}
`;

    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      return new Response(JSON.stringify({ error: 'LOVABLE_API_KEY is not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const gateway = createLovableAiGatewayProvider(lovableApiKey);
    const model = (gateway as any).chat('google/gemini-3-flash-preview');

    const systemPrompt = `Eres "Quadra AI", el copiloto de contabilidad e inteligencia financiera para conciliaciones de comercio electrónico.
Tu rol es ayudar a administradores, dueños de tiendas y contadores a entender sus estados de resultados, conciliaciones de MercadoLibre (MercadoPago) contra documentos tributarios de Bsale, y resolver discrepancias para el cierre mensual.

Directrices de tono y estilo:
1. Usa castellano formal de contabilidad chilena (ej. "documentos tributarios", "boletas", "facturas", "notas de crédito", "diferencias de cuadratura", "monto neto", "comisiones", "abonos"). No uses jerga técnica informática (ej. "endpoints", "payload", "base de datos", "arrays").
2. Muestra los RUTs como cuerpo numérico simple, sin puntos ni guiones (ej. 12345678), según las normas de interfaz de Quadra.
3. Sé conciso, preciso y directo. Explica claramente la lógica de conciliación: Ventas -> Pagos -> Documentos de Impuestos.
4. Si un usuario te pregunta por discrepancias o alertas, explícale que:
   - El cierre del mes se bloquea estrictamente si hay ventas en estado "PAGADA_SIN_DOCUMENTO" (ventas cobradas en MercadoLibre pero sin su boleta o factura emitida en Bsale).
   - El monto neto real de una venta se compone de: Bruto menos comisiones de Marketplace, costos de envío y comisiones de pasarela de pago.
   - Las devoluciones requieren una Nota de Crédito emitida en Bsale para no inflar los impuestos declarados al SII.

Aquí tienes información contextual en tiempo real de su cuenta:
${groundingContext}

Responde de manera profesional y amigable, guiando siempre a la resolución de problemas financieros.`;

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
    });

    const response = result.toUIMessageStreamResponse({
      headers: getLovableAiGatewayResponseHeaders(undefined, {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
      }),
    });

    return withLovableAiGatewayRunIdHeader(response, gateway, corsHeaders);

  } catch (error) {
    console.error('Error in ai-chat function:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
