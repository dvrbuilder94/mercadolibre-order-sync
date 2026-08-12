const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      success: false,
      deprecated: true,
      error: 'sync-meli-settlements fue retirado del flujo activo porque construía liquidaciones y payments sintéticos desde orders.',
      use_instead: 'Usar sync-meli-payment-details/check-orphan-payments para pagos reales de Mercado Pago y sync-mercadopago-settlements para liquidaciones reales cuando corresponda.',
    }),
    {
      status: 410,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
