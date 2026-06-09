import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.74.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Order {
  id: string;
  order_id: string;
  customer_name: string;
  order_date: string;
  amount: number;
  reconciliation_status: string;
}

interface BankMovement {
  id: string;
  movement_date: string;
  amount: number;
  external_reference: string | null;
  description: string | null;
}

function stringSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

// Calculate confidence score for MELI orders (0-100) - OPTIMIZED ALGORITHM
function calculateMeliConfidenceScore(order: any, movement: BankMovement): number {
  let score = 0;

  // 1. Amount matching (40% weight - ±100 CLP tolerance)
  const amountToMatch = order.has_exact_data ? order.settlement_amount : order.net_amount || order.amount;
  const amountDiff = Math.abs(amountToMatch - movement.amount);
  const amountScore = amountDiff <= 100 ? 40 : Math.max(0, 40 - ((amountDiff - 100) / amountToMatch) * 100);
  score += amountScore;

  // 2. Date proximity (35% weight - ±3 days tolerance)
  const orderDate = new Date(order.settlement_date || order.order_date);
  const movementDate = new Date(movement.movement_date);
  const daysDiff = Math.abs((orderDate.getTime() - movementDate.getTime()) / (1000 * 60 * 60 * 24));
  const dateScore = daysDiff <= 3 ? 35 : Math.max(0, 35 - (daysDiff - 3) * 10); // Full score within ±3 days, -10% per extra day
  score += dateScore;

  // 3. Reference matching (25% weight - enhanced for multiple reference types)
  const description = (movement.description || '').toLowerCase();
  const externalRef = (movement.external_reference || '').toLowerCase();
  const orderIdMatch = description.includes(order.order_id.toLowerCase()) || 
                       externalRef.includes(order.order_id.toLowerCase());
  const bankRefMatch = order.bank_reference && 
                      (description.includes(order.bank_reference.toLowerCase()) ||
                       externalRef.includes(order.bank_reference.toLowerCase()));
  const meliKeywords = description.includes('mercadopago') || 
                       description.includes('mercado pago') ||
                       description.includes('meli');
  
  if (orderIdMatch || bankRefMatch) {
    score += 25;
  } else if (meliKeywords) {
    score += 10; // Partial points for MELI identification
  }

  console.log(`Order ${order.order_id}: amount=${amountScore.toFixed(1)}%, date=${dateScore.toFixed(1)}%, ref=${orderIdMatch || bankRefMatch ? 25 : (meliKeywords ? 10 : 0)}% → TOTAL=${score.toFixed(1)}%`);

  return Math.round(score);
}

function matchesReconciliationCriteria(
  order: Order,
  movement: BankMovement
): boolean {
  // Check amount (±100 CLP tolerance)
  const amountDiff = Math.abs(Number(order.amount) - Number(movement.amount));
  if (amountDiff > 100) return false;

  // Check date (±3 days tolerance)
  const orderDate = new Date(order.order_date);
  const movementDate = new Date(movement.movement_date);
  const daysDiff = Math.abs(
    (orderDate.getTime() - movementDate.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysDiff > 3) return false;

  // Check reference similarity if available
  if (movement.external_reference || movement.description) {
    const reference = (movement.external_reference || movement.description || '').toLowerCase();
    const nameSimilarity = stringSimilarity(
      order.customer_name.toLowerCase(),
      reference
    );
    const orderIdSimilarity = stringSimilarity(
      order.order_id.toLowerCase(),
      reference
    );
    
    if (nameSimilarity < 0.6 && orderIdSimilarity < 0.6) return false;
  }

  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Client with user context for reading data (respects RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    // Admin client for batch write operations (bypasses RLS)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('=== AUTO-RECONCILE 4-STAGE START ===');
    console.log('User ID:', user.id);

    let stage1 = 0, stage2 = 0, stage3 = 0, stage4 = 0;

    // ==========================================
    // STAGE 1: Bank Movement ↔ Settlement
    // ==========================================
    console.log('\n--- STAGE 1: Bank ↔ Settlement ---');
    
    const { data: unreconciledBankMovements } = await supabase
      .from('bank_movements')
      .select('*')
      .eq('user_id', user.id)
      .eq('reconciled', false)
      .order('movement_date', { ascending: false });

    const { data: unreconciledSettlements } = await supabase
      .from('settlements')
      .select('*')
      .eq('reconciled', false)
      .order('period_start', { ascending: false });

    console.log(`Found ${unreconciledBankMovements?.length || 0} unreconciled bank movements`);
    console.log(`Found ${unreconciledSettlements?.length || 0} unreconciled settlements`);

    for (const movement of unreconciledBankMovements || []) {
      let bestMatch = null;
      let bestScore = 0;

      for (const settlement of unreconciledSettlements || []) {
        if (settlement.bank_movement_id) continue; // Already linked

        let score = 0;

        // Amount matching (±200 CLP tolerance)
        const amountDiff = Math.abs(movement.amount - settlement.settlement_amount);
        if (amountDiff <= 200) {
          score += 50;
        } else if (amountDiff <= 1000) {
          score += 30;
        }

        // Date proximity (settlement within ±5 days of movement)
        const movementDate = new Date(movement.movement_date);
        const settlementEndDate = new Date(settlement.period_end);
        const daysDiff = Math.abs((movementDate.getTime() - settlementEndDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (daysDiff <= 5) {
          score += 40;
        } else if (daysDiff <= 10) {
          score += 20;
        }

        // Channel matching in description
        const desc = (movement.description || '').toLowerCase();
        if (settlement.channel === 'meli' && (desc.includes('mercado') || desc.includes('meli'))) {
          score += 10;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = settlement;
        }
      }

      if (bestScore >= 60 && bestMatch) {
        // Link bank movement to settlement
        await supabase
          .from('settlements')
          .update({ 
            bank_movement_id: movement.id,
            reconciled: true 
          })
          .eq('id', bestMatch.id);

        await supabase
          .from('bank_movements')
          .update({ reconciled: true })
          .eq('id', movement.id);

        stage1++;
        console.log(`✅ Stage 1: Linked bank movement ${movement.id} to settlement ${bestMatch.id} (${bestScore}%)`);
      }
    }

    // ==========================================
    // STAGE 2: Settlement Item ↔ Order (using meli_order_id)
    // ==========================================
    console.log('\n--- STAGE 2: Settlement Item ↔ Order ---');

    const { data: unreconciledItems } = await supabase
      .from('settlement_items')
      .select('*')
      .eq('recon_status', 'pending')
      .is('order_id', null);

    const { data: unreconciledOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('reconciliation_status', 'pending');

    console.log(`Found ${unreconciledItems?.length || 0} unreconciled settlement items`);
    console.log(`Found ${unreconciledOrders?.length || 0} unreconciled orders`);

    for (const item of unreconciledItems || []) {
      if (!item.meli_order_id) continue;

      // Match using meli_order_id (MercadoLibre order ID)
      const exactMatch = unreconciledOrders?.find(order => 
        order.channel === item.channel && 
        order.order_id === item.meli_order_id
      );

      if (exactMatch && !item.order_id) {
        await supabase
          .from('settlement_items')
          .update({ 
            order_id: exactMatch.id,
            recon_status: 'reconciled',
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);

        stage2++;
        console.log(`✅ Stage 2: Linked settlement item ${item.id} to order ${exactMatch.order_id} via meli_order_id`);
      }
    }

    // ==========================================
    // STAGE 3: Order ↔ Tax Document (Scoring-based Algorithm)
    // ==========================================
    console.log('\n--- STAGE 3: Order ↔ Tax Document (Scoring Algorithm) ---');

    // Helper: Normalize string for comparison
    const normalizeString = (str: string | null | undefined): string => {
      if (!str) return '';
      return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9\s]/g, '')
        .trim();
    };

    // Helper: Normalize RUT for comparison
    const normalizeRut = (rut: string | null | undefined): string => {
      if (!rut) return '';
      return rut.replace(/[^0-9kK]/g, '').toUpperCase();
    };

    // Helper: Detect generic Bsale boleta RUT (consumidor final = 66666666-6)
    const isGenericBoletaRut = (rut: string | null | undefined): boolean => {
      const n = normalizeRut(rut);
      return n === '666666666' || n === '66666666K' || n === '11111111K';
    };

    // Helper: Calculate name similarity (0-1)
    const calculateNameSimilarity = (name1: string, name2: string): number => {
      const n1 = normalizeString(name1);
      const n2 = normalizeString(name2);
      
      if (!n1 || !n2) return 0;
      if (n1 === n2) return 1;
      
      // Check if one contains the other
      if (n1.includes(n2) || n2.includes(n1)) return 0.8;
      
      // Word-based similarity
      const words1 = n1.split(/\s+/).filter(w => w.length > 2);
      const words2 = n2.split(/\s+/).filter(w => w.length > 2);
      
      if (words1.length === 0 || words2.length === 0) return 0;
      
      let matchingWords = 0;
      for (const w1 of words1) {
        if (words2.some(w2 => w1 === w2 || w1.includes(w2) || w2.includes(w1))) {
          matchingWords++;
        }
      }
      
      return matchingWords / Math.max(words1.length, words2.length);
    };

    // Helper: Calculate match score between order and tax document (1:1)
    const calculateMatchScore = (order: any, doc: any): { score: number; breakdown: any } => {
      let score = 0;
      const breakdown = {
        rut: 0,
        amount: 0,
        date: 0,
        name: 0
      };

      // 1. RUT Match (+40 exact, +25 generic boleta, +20 order has no RUT (ML case))
      const orderRut = normalizeRut(order.customer_tax_id);
      const docRut = normalizeRut(doc.client_tax_id);
      if (orderRut && docRut && orderRut === docRut) {
        breakdown.rut = 40;
        score += 40;
      } else if (isGenericBoletaRut(doc.client_tax_id)) {
        // Boleta a consumidor final: RUT genérico no descarta el match
        breakdown.rut = 25;
        score += 25;
      } else if (!orderRut) {
        // ML orders don't expose buyer RUT — don't penalize, allow amount+date to decide
        breakdown.rut = 20;
        score += 20;
      }

      // 2. Amount Match (+30 exact, +20 approximate ≤500)
      const orderAmount = order.gross_amount || order.amount || 0;
      const docAmount = doc.total_amount || 0;
      const amountDiff = Math.abs(orderAmount - docAmount);
      
      if (amountDiff === 0) {
        breakdown.amount = 30;
        score += 30;
      } else if (amountDiff <= 500) {
        breakdown.amount = 20;
        score += 20;
      }

      // 3. Date Proximity (+20 same day, +10 within ±2 days)
      const orderDate = new Date(order.order_date).setHours(0, 0, 0, 0);
      const docDate = new Date(doc.document_date).setHours(0, 0, 0, 0);
      const daysDiff = Math.abs((orderDate - docDate) / (24 * 60 * 60 * 1000));
      
      if (daysDiff === 0) {
        breakdown.date = 20;
        score += 20;
      } else if (daysDiff <= 2) {
        breakdown.date = 10;
        score += 10;
      }

      // 4. Name Similarity (+10 max)
      const nameSimilarity = calculateNameSimilarity(order.customer_name, doc.client_name);
      if (nameSimilarity >= 0.8) {
        breakdown.name = 10;
        score += 10;
      } else if (nameSimilarity >= 0.5) {
        breakdown.name = Math.round(nameSimilarity * 10);
        score += breakdown.name;
      }

      return { score, breakdown };
    };

    // ============================================================
    // CONSOLIDATED MATCHING (1:N) - New Algorithm
    // ============================================================

    // Helper: Generate combinations of given size from array
    function* generateCombinations<T>(arr: T[], size: number): Generator<T[]> {
      if (size > arr.length) return;
      if (size === 0) {
        yield [];
        return;
      }
      
      const indices = Array.from({ length: size }, (_, i) => i);
      
      while (true) {
        yield indices.map(i => arr[i]);
        
        // Find rightmost index that can be incremented
        let i = size - 1;
        while (i >= 0 && indices[i] === arr.length - size + i) {
          i--;
        }
        
        if (i < 0) break;
        
        indices[i]++;
        for (let j = i + 1; j < size; j++) {
          indices[j] = indices[j - 1] + 1;
        }
      }
    }

    // Helper: Calculate score for consolidated match
    const calculateConsolidatedScore = (
      orders: any[], 
      doc: any
    ): { score: number; breakdown: any } => {
      const docRut = normalizeRut(doc.client_tax_id);
      const docDate = new Date(doc.document_date).setHours(0, 0, 0, 0);
      const docAmount = doc.total_amount || 0;
      
      let score = 0;
      const breakdown: any = {
        rut: 0,
        amount: 0,
        date: 0,
        channel: 0,
        coherence: 0,
        consolidated: true,
        orders_count: orders.length,
        identity_source: 'RUT',
        identity_confidence: 'HIGH',
        matching_reasons: [] as string[],
        order_ids: orders.map(o => o.order_id),
        individual_amounts: orders.map(o => o.gross_amount || o.amount),
        sum_total: 0,
        document_amount: docAmount
      };

      // 1. RUT identical for ALL orders (+40)
      const allSameRut = orders.every(o => {
        const orderRut = normalizeRut(o.customer_tax_id);
        return orderRut && docRut && orderRut === docRut;
      });
      
      if (allSameRut) {
        breakdown.rut = 40;
        score += 40;
        breakdown.matching_reasons.push('SAME_RUT');
      }

      // 2. Sum matches document amount (+30 for ±$100)
      const totalSum = orders.reduce((sum, o) => sum + (o.gross_amount || o.amount || 0), 0);
      breakdown.sum_total = totalSum;
      const sumDiff = Math.abs(totalSum - docAmount);
      
      if (sumDiff <= 100) {
        breakdown.amount = 30;
        score += 30;
        breakdown.matching_reasons.push('EXACT_SUM');
      }

      // 3. All orders within ±3 days (+15)
      const allInDateWindow = orders.every(o => {
        const orderDate = new Date(o.order_date).setHours(0, 0, 0, 0);
        const daysDiff = Math.abs((orderDate - docDate) / (24 * 60 * 60 * 1000));
        return daysDiff <= 3;
      });
      
      if (allInDateWindow) {
        breakdown.date = 15;
        score += 15;
        breakdown.matching_reasons.push('WITHIN_3_DAYS');
      }

      // 4. All orders on SAME day as document (+5 bonus)
      const allSameDay = orders.every(o => {
        const orderDate = new Date(o.order_date).setHours(0, 0, 0, 0);
        return orderDate === docDate;
      });
      
      if (allSameDay) {
        breakdown.coherence = (breakdown.coherence || 0) + 5;
        score += 5;
        breakdown.matching_reasons.push('SAME_DAY');
      }

      // 5. All orders same channel (+5 bonus)
      const channels = [...new Set(orders.map(o => o.channel))];
      if (channels.length === 1) {
        breakdown.channel = 5;
        score += 5;
        breakdown.matching_reasons.push('SAME_CHANNEL');
      }

      // 6. Fewer orders bonus (+5 for 2 orders, +3 for 3, +1 for 4, 0 for 5)
      const orderCountBonus = Math.max(0, 6 - orders.length);
      if (orderCountBonus > 0) {
        breakdown.coherence = (breakdown.coherence || 0) + orderCountBonus;
        score += orderCountBonus;
      }

      return { score, breakdown };
    };

    // Helper: Find consolidated match for a document
    const findConsolidatedMatch = (
      doc: any,
      allOrders: any[],
      linkedOrderIds: Set<string>
    ): { orders: any[]; score: number; breakdown: any } | null => {
      const docRut = normalizeRut(doc.client_tax_id);
      const docDate = new Date(doc.document_date);
      const docAmount = doc.total_amount || 0;

      // GATEKEEPER: only block truly generic consumer RUTs — not missing RUT (ML case)
      // 66666666-6 is the Chilean "consumidor final" placeholder used for anonymous buyers
      if (isGenericBoletaRut(docRut)) {
        return null; // Can't group by generic RUT
      }

      // Find candidate orders (same RUT or no RUT (ML), ±3 days, CLP, not cancelled, not linked)
      const candidateOrders = allOrders.filter(order => {
        const orderRut = normalizeRut(order.customer_tax_id);
        // If document has RUT, order must match. If doc has no RUT, only match orders without RUT.
        if (docRut && orderRut && orderRut !== docRut) return false;

        // Not already linked
        if (linkedOrderIds.has(order.id)) return false;

        // Not cancelled
        if (order.status === 'cancelled') return false;

        // CLP currency
        if (order.currency_id && order.currency_id !== 'CLP') return false;

        // Within ±3 days
        const orderDate = new Date(order.order_date);
        const daysDiff = Math.abs((docDate.getTime() - orderDate.getTime()) / (24 * 60 * 60 * 1000));
        if (daysDiff > 3) return false;

        return true;
      });

      // Need at least 2 orders for consolidated match
      if (candidateOrders.length < 2) {
        return null;
      }

      console.log(`   📦 Doc ${doc.document_number} (RUT: ${docRut}): ${candidateOrders.length} candidate orders for consolidation`);

      // Group orders by "naturalness" - prioritize same day
      const docDateStr = docDate.toISOString().split('T')[0];
      const sameDayOrders = candidateOrders.filter(o => 
        new Date(o.order_date).toISOString().split('T')[0] === docDateStr
      );
      const otherOrders = candidateOrders.filter(o => 
        new Date(o.order_date).toISOString().split('T')[0] !== docDateStr
      );

      // Process groups in priority order
      const orderedGroups = [
        { name: 'same_day', orders: sameDayOrders },
        { name: 'other', orders: candidateOrders } // Include all for broader search
      ];

      const validCombinations: { orders: any[]; score: number; breakdown: any }[] = [];
      const tolerance = 100; // ±$100 tolerance

      for (const group of orderedGroups) {
        if (group.orders.length < 2) continue;

        // Generate combinations of sizes 2, 3, 4, 5
        for (let size = 2; size <= Math.min(5, group.orders.length); size++) {
          let combinationsChecked = 0;
          const maxCombinations = 100; // Safety limit

          for (const combo of generateCombinations(group.orders, size)) {
            combinationsChecked++;
            if (combinationsChecked > maxCombinations) break;

            const sum = combo.reduce((acc, o) => acc + (o.gross_amount || o.amount || 0), 0);
            
            // Check if sum matches document amount
            if (Math.abs(sum - docAmount) <= tolerance) {
              const { score, breakdown } = calculateConsolidatedScore(combo, doc);
              
              // Only consider if score >= 60
              if (score >= 60) {
                validCombinations.push({ orders: combo, score, breakdown });
              }
            }
          }
        }

        // Short-circuit: If we found valid combinations in same-day group, don't search further
        if (group.name === 'same_day' && validCombinations.length > 0) {
          break;
        }
      }

      if (validCombinations.length === 0) {
        return null;
      }

      // Sort by score (desc), then by order count (asc - fewer is better)
      validCombinations.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.orders.length - b.orders.length;
      });

      // Check for ambiguity
      const topScore = validCombinations[0].score;
      const topMatches = validCombinations.filter(c => c.score === topScore);

      if (topMatches.length > 1) {
        // Multiple combinations with same score - prefer fewer orders
        const sortedByOrders = topMatches.sort((a, b) => a.orders.length - b.orders.length);
        if (sortedByOrders[0].orders.length < sortedByOrders[1].orders.length) {
          return sortedByOrders[0]; // Clear winner by order count
        }
        // Still ambiguous - mark the best one with AMBIGUOUS flag
        const best = sortedByOrders[0];
        best.breakdown.ambiguous = true;
        best.breakdown.alternative_combinations = topMatches.length;
        return best;
      }

      return validCombinations[0];
    };

    // Fetch orders needing documents (PAGADA_SIN_DOCUMENTO equivalent)
    // These are orders that have payment (money_release_date NOT NULL) but no linked tax document
    // IMPORTANT: Using supabaseAdmin to avoid RLS issues and adding proper pagination
    // Note: Supabase has a default limit of 1000 rows, we need to fetch all orders
    // Include ALL non-cancelled orders — not just those with money_release_date.
    // ML API sometimes doesn't return payment dates on first sync; excluding them
    // causes orders to never be reconciled even when a Bsale doc exists.
    const { data: ordersWithPayment, error: ordersError } = await supabaseAdmin
      .from('orders')
      .select(`
        *,
        order_tax_documents(id)
      `)
      .neq('status', 'cancelled')
      .order('order_date', { ascending: false })
      .limit(5000);

    if (ordersError) {
      console.error('Error fetching orders:', ordersError.message);
    }

    console.log(`Fetched ${ordersWithPayment?.length || 0} non-cancelled orders (limit: 5000)`);

    // Filter to orders with payment but no document
    const ordersNeedingDocs = (ordersWithPayment || []).filter(order => {
      const hasDocument = order.order_tax_documents && order.order_tax_documents.length > 0;
      return !hasDocument;
    });

    // Fetch linked orders for consolidated matching check (using admin for consistency)
    const { data: linkedOrderTaxDocs } = await supabaseAdmin
      .from('order_tax_documents')
      .select('order_id, tax_document_id')
      .limit(10000);
    
    const linkedOrderIds = new Set((linkedOrderTaxDocs || []).map(d => d.order_id));
    const linkedDocIds = new Set((linkedOrderTaxDocs || []).map(d => d.tax_document_id));

    const { data: allDocs } = await supabaseAdmin
      .from('tax_documents')
      .select('*')
      .eq('status', 'issued')
      .in('document_type', ['boleta', 'factura', 'factura_exenta'])
      .limit(10000);

    // Post-filtro por codeSii válido para documentos tributarios
    // Códigos válidos: 33=Factura, 34=Factura Exenta, 39=Boleta, 41=Boleta Exenta
    // Excluir explícitamente: 52=Guía de Despacho (no tributario)
    const validCodesSii = ['33', '34', '39', '41'];
    const tributaryDocs = (allDocs || []).filter(doc => {
      const codeSii = doc.raw_data?.codeSii?.toString();
      // Si no tiene codeSii, confiar en document_type
      if (!codeSii) return true;
      // Excluir explícitamente Guías (52) y otros no tributarios
      return validCodesSii.includes(codeSii);
    });

    // Incluir todos los docs no vinculados — la clasificación B2B puede ser incorrecta
    // si sync-bsale-docs corrió antes que sync-meli-orders (sin órdenes para comparar RUT).
    // Si un doc B2B genuino no tiene orden, simplemente queda sin vincular. Sin daño.
    const allUnlinked = tributaryDocs.filter(doc => !linkedDocIds.has(doc.id));
    const excludedB2BCount = allUnlinked.filter(doc => doc.sales_channel === 'B2B').length;
    const unlinkedDocs = allUnlinked; // Intentar match en todos, incluyendo los clasificados B2B
    console.log(`Found ${ordersNeedingDocs.length} orders needing documents (with money_release_date)`);
    console.log(`Found ${allUnlinked.length} unlinked tributary documents`);
    console.log(`  Clasificados B2B (pueden ser mal clasificados si sync corrió antes de órdenes): ${excludedB2BCount}`);
    console.log(`  Total elegibles para match: ${unlinkedDocs.length}`);

    let autoLinkedCount = 0;
    let autoSoftCount = 0;
    let autoConsolidatedCount = 0;
    let autoConsolidatedOrdersCount = 0;
    let ambiguousCount = 0;
    let ignoredCount = 0;
    let candidatesSavedCount = 0;
    const ambiguousCases: any[] = [];

    // Track orders/docs linked during this run
    const newlyLinkedOrderIds = new Set<string>();
    const newlyLinkedDocIds = new Set<string>();

    // ==========================================
    // PHASE 0: HARD MATCH by external_order_id
    // ==========================================
    let hardLinkedCount = 0;
    const ordersByOrderId = new Map<string, any>(
      ordersNeedingDocs.map(o => [String(o.order_id), o])
    );
    for (const doc of unlinkedDocs) {
      const eoi = (doc as any).external_order_id;
      if (!eoi) continue;
      const order = ordersByOrderId.get(String(eoi));
      if (!order || linkedOrderIds.has(order.id) || newlyLinkedDocIds.has(doc.id)) continue;
      const { error: linkErr } = await supabaseAdmin
        .from('order_tax_documents')
        .insert({
          order_id: order.id,
          tax_document_id: doc.id,
          allocated_amount: doc.total_amount,
          created_by: user.id,
          match_source: 'AUTO_HARD_ORDER_ID',
          match_score: 100,
        });
      if (!linkErr) {
        newlyLinkedDocIds.add(doc.id);
        newlyLinkedOrderIds.add(order.id);
        hardLinkedCount++;
      }
    }
    console.log(`Stage 3 Phase 0 (Hard match external_order_id): ${hardLinkedCount} linked`);

    // ==========================================
    // PHASE A: CONSOLIDATED MATCHING (1:N) - NEW
    // ==========================================
    console.log('\n--- Stage 3A: Consolidated Matching (1:N) ---');

    for (const doc of unlinkedDocs) {
      // Skip if already linked in this run
      if (newlyLinkedDocIds.has(doc.id)) continue;

      // Try consolidated match first
      const consolidatedMatch = findConsolidatedMatch(
        doc, 
        ordersNeedingDocs.filter(o => !linkedOrderIds.has(o.id) && !newlyLinkedOrderIds.has(o.id)),
        new Set([...linkedOrderIds, ...newlyLinkedOrderIds])
      );

      if (consolidatedMatch) {
        const { orders, score, breakdown } = consolidatedMatch;
        
        // Check if ambiguous (multiple combinations with same score)
        if (breakdown.ambiguous) {
          ambiguousCount++;
          console.log(`⚠️ Stage 3A: AMBIGUOUS consolidated doc ${doc.document_number} - ${breakdown.alternative_combinations} combinations with same score`);
          
          // Save first candidate for review using admin client
          for (const order of orders) {
            const { error: candidateError } = await supabaseAdmin
              .from('order_tax_match_candidates')
              .upsert({
                tax_document_id: doc.id,
                order_id: order.id,
                match_score: score,
                breakdown: {
                  ...breakdown,
                  notes: `Consolidated match: ${orders.length} orders, ambiguous with ${breakdown.alternative_combinations} alternatives`
                },
                status: 'pending'
              }, { onConflict: 'tax_document_id,order_id' });

            if (!candidateError) candidatesSavedCount++;
          }
          continue;
        }

        // Check score threshold for auto-link
        if (score >= 80) {
          // Insert N records for consolidated match
          let insertSuccess = true;
          for (const order of orders) {
            const { error: insertError } = await supabaseAdmin
              .from('order_tax_documents')
              .insert({
                order_id: order.id,
                tax_document_id: doc.id,
                allocated_amount: order.gross_amount || order.amount,
                match_source: 'AUTO_CONSOLIDATED',
                match_score: score,
                created_by: user.id,
                resync_batch: doc.resync_batch
              });

            if (insertError) {
              console.error(`   ❌ Consolidated insert error for order ${order.order_id}: ${insertError.message}`);
              insertSuccess = false;
            } else {
              newlyLinkedOrderIds.add(order.id);
            }
          }

          if (insertSuccess) {
            autoConsolidatedCount++;
            autoConsolidatedOrdersCount += orders.length;
            newlyLinkedDocIds.add(doc.id);
            
            console.log(`✅ Stage 3A: AUTO_CONSOLIDATED doc ${doc.document_number} → ${orders.length} orders (score: ${score})`);
            console.log(`   Orders: ${orders.map(o => o.order_id).join(', ')}`);
            console.log(`   Sum: $${breakdown.sum_total.toLocaleString()} = Doc: $${breakdown.document_amount.toLocaleString()}`);
            console.log(`   Reasons: ${breakdown.matching_reasons.join(', ')}`);
          }
        } else if (score >= 60) {
        // Save as candidate for manual review using admin client
          for (const order of orders) {
            const { error: candidateError } = await supabaseAdmin
              .from('order_tax_match_candidates')
              .upsert({
                tax_document_id: doc.id,
                order_id: order.id,
                match_score: score,
                breakdown: {
                  ...breakdown,
                  notes: `Consolidated match: ${orders.length} orders, score ${score} needs review`
                },
                status: 'pending'
              }, { onConflict: 'tax_document_id,order_id' });

            if (!candidateError) candidatesSavedCount++;
          }
          console.log(`📋 Stage 3A: CANDIDATE consolidated doc ${doc.document_number} - ${orders.length} orders, score ${score} (saved for review)`);
        }
      }
    }

    console.log(`\nStage 3A Summary: ${autoConsolidatedCount} docs consolidated (${autoConsolidatedOrdersCount} orders)`);

    // ==========================================
    // PHASE B: SIMPLE MATCHING (1:1) - Existing
    // ==========================================
    console.log('\n--- Stage 3B: Simple Matching (1:1) ---');

    // Process each unlinked document (skip those already handled by consolidated matching)
    for (const doc of unlinkedDocs) {
      // Skip if already linked by consolidated matching
      if (newlyLinkedDocIds.has(doc.id)) continue;

      // Find candidate orders within date window ±5 days and amount ±2% or ±$500
      const docDate = new Date(doc.document_date);
      const docAmount = doc.total_amount || 0;
      const amountTolerance = Math.max(docAmount * 0.02, 500);

      // DEBUG: Log for specific documents
      const isDebugDoc = ['5461', '5462'].includes(doc.document_number);
      if (isDebugDoc) {
        console.log(`\n🔍 DEBUG Doc ${doc.document_number}: RUT=${doc.client_tax_id}, Amount=${docAmount}, Date=${doc.document_date}`);
        console.log(`   Total orders to check: ${ordersNeedingDocs.length}`);
      }

      const candidates = ordersNeedingDocs
        .filter(order => !linkedOrderIds.has(order.id) && !newlyLinkedOrderIds.has(order.id)) // Exclude linked orders
        .map(order => {
          const orderDate = new Date(order.order_date);
          const daysDiff = Math.abs((docDate.getTime() - orderDate.getTime()) / (24 * 60 * 60 * 1000));
          const orderAmount = order.gross_amount || order.amount || 0;
          const amountDiff = Math.abs(orderAmount - docAmount);
          
          // DEBUG: Log RUT matches for specific documents
          if (isDebugDoc && normalizeRut(order.customer_tax_id) === normalizeRut(doc.client_tax_id)) {
            console.log(`   🎯 RUT match found: Order ${order.order_id}`);
            console.log(`      Order amount: ${orderAmount}, Doc amount: ${docAmount}, Diff: ${amountDiff}`);
            console.log(`      Order date: ${order.order_date}, Doc date: ${doc.document_date}, Days diff: ${daysDiff.toFixed(2)}`);
            console.log(`      Amount tolerance: ${amountTolerance}, Passes: ${amountDiff <= amountTolerance}`);
            console.log(`      Days tolerance: 5, Passes: ${daysDiff <= 5}`);
          }
          
          // Pre-filter: within ±5 days and ±2% (or ±$500) amount
          if (daysDiff > 5) return null;
          if (amountDiff > amountTolerance) return null;
          
          const { score, breakdown } = calculateMatchScore(order, doc);
          
          // DEBUG: Log score breakdown for RUT matches
          if (isDebugDoc && normalizeRut(order.customer_tax_id) === normalizeRut(doc.client_tax_id)) {
            console.log(`      ✅ PASSED filters! Score: ${score}, Breakdown: RUT=${breakdown.rut}, Amount=${breakdown.amount}, Date=${breakdown.date}, Name=${breakdown.name}`);
          }
          
          return { order, score, breakdown };
        })
        .filter((c): c is { order: any; score: number; breakdown: any } => c !== null)
        .sort((a, b) => b.score - a.score);

      if (isDebugDoc) {
        console.log(`   Candidates found: ${candidates.length}`);
        candidates.slice(0, 3).forEach(c => {
          console.log(`      - Order ${c.order.order_id}: score=${c.score}, RUT=${c.order.customer_tax_id}`);
        });
      }

      if (candidates.length === 0) {
        ignoredCount++;
        continue;
      }

      const bestCandidate = candidates[0];
      const highScoreCandidates = candidates.filter(c => c.score >= 60);
      const candidates85Plus = candidates.filter(c => c.score >= 85);
      const candidates70Plus = candidates.filter(c => c.score >= 70);

      // Rule 1: If ONLY ONE candidate has score ≥85 → AUTO-LINK
      if (bestCandidate.score >= 85 && candidates85Plus.length === 1) {
        const { error: insertError } = await supabaseAdmin
          .from('order_tax_documents')
          .insert({
            order_id: bestCandidate.order.id,
            tax_document_id: doc.id,
            allocated_amount: doc.total_amount,
            match_source: 'AUTO',
            match_score: bestCandidate.score,
            created_by: user.id,
            resync_batch: doc.resync_batch  // Heredar batch del documento para trazabilidad
          });

        if (!insertError) {
          autoLinkedCount++;
          newlyLinkedDocIds.add(doc.id);
          newlyLinkedOrderIds.add(bestCandidate.order.id);
          console.log(`✅ Stage 3: AUTO-LINKED doc ${doc.document_number} → order ${bestCandidate.order.order_id} (score: ${bestCandidate.score})`);
          console.log(`   Breakdown: RUT=${bestCandidate.breakdown.rut}, Amount=${bestCandidate.breakdown.amount}, Date=${bestCandidate.breakdown.date}, Name=${bestCandidate.breakdown.name}`);
        } else {
          console.error(`   ❌ Insert error: ${insertError.message}`);
        }
      }
      // Rule 2: If ONLY ONE candidate has score 70-84 → AUTO_SOFT
      else if (bestCandidate.score >= 70 && candidates70Plus.length === 1) {
        const { error: insertError } = await supabaseAdmin
          .from('order_tax_documents')
          .insert({
            order_id: bestCandidate.order.id,
            tax_document_id: doc.id,
            allocated_amount: doc.total_amount,
            match_source: 'AUTO_SOFT',
            match_score: bestCandidate.score,
            created_by: user.id,
            resync_batch: doc.resync_batch  // Heredar batch del documento para trazabilidad
          });

        if (!insertError) {
          autoSoftCount++;
          newlyLinkedDocIds.add(doc.id);
          newlyLinkedOrderIds.add(bestCandidate.order.id);
          console.log(`✅ Stage 3: AUTO_SOFT doc ${doc.document_number} → order ${bestCandidate.order.order_id} (score: ${bestCandidate.score})`);
          console.log(`   Breakdown: RUT=${bestCandidate.breakdown.rut}, Amount=${bestCandidate.breakdown.amount}, Date=${bestCandidate.breakdown.date}, Name=${bestCandidate.breakdown.name}`);
        } else {
          console.error(`   ❌ Insert error: ${insertError.message}`);
        }
      }
      // Rule 3: If multiple candidates ≥60 → Check for PERFECT TIE N:N scenario
      else if (highScoreCandidates.length > 1) {
        // NEW: Detect perfect tie scenario (N docs : N orders with identical scores)
        const uniqueScores = [...new Set(highScoreCandidates.map(c => c.score))];
        const docRut = normalizeRut(doc.client_tax_id);
        
        // Check if all candidates have the same score (perfect tie)
        if (uniqueScores.length === 1 && docRut) {
          const tieScore = uniqueScores[0];
          const candidateOrders = highScoreCandidates.map(c => c.order);
          
          // Find related documents: same RUT, same amount, same date, not yet linked
          const relatedDocs = unlinkedDocs.filter(d => 
            !newlyLinkedDocIds.has(d.id) &&
            normalizeRut(d.client_tax_id) === docRut &&
            d.total_amount === doc.total_amount &&
            d.document_date === doc.document_date
          );

          console.log(`   🔍 Tie detection: ${relatedDocs.length} related docs, ${candidateOrders.length} candidate orders`);

          // Perfect N:N tie scenario: same number of docs and orders
          if (relatedDocs.length === candidateOrders.length && relatedDocs.length > 1 && tieScore >= 85) {
            console.log(`   ⚡ PERFECT TIE ${relatedDocs.length}:${candidateOrders.length} detected! Applying chronological tie-break...`);

            // Sort documents by document number (ascending)
            const sortedDocs = [...relatedDocs].sort((a, b) => 
              Number(a.document_number) - Number(b.document_number)
            );

            // Sort orders by creation date (ascending)
            const sortedOrders = [...candidateOrders].sort((a, b) => 
              new Date(a.created_at || a.order_date).getTime() - 
              new Date(b.created_at || b.order_date).getTime()
            );

            // Link 1:1 by position using admin client
            let tieBreakSuccess = true;
            for (let i = 0; i < sortedDocs.length; i++) {
              const tieDoc = sortedDocs[i];
              const tieOrder = sortedOrders[i];
              
              const { error: insertError } = await supabaseAdmin
                .from('order_tax_documents')
                .insert({
                  order_id: tieOrder.id,
                  tax_document_id: tieDoc.id,
                  allocated_amount: tieDoc.total_amount,
                  match_source: 'AUTO_TIE_BREAK',
                  match_score: tieScore,
                  created_by: user.id,
                  resync_batch: tieDoc.resync_batch
                });

              if (insertError) {
                console.error(`   ❌ Tie-break insert error for doc ${tieDoc.document_number} → order ${tieOrder.order_id}: ${insertError.message}`);
                tieBreakSuccess = false;
              } else {
                newlyLinkedDocIds.add(tieDoc.id);
                newlyLinkedOrderIds.add(tieOrder.id);
                autoLinkedCount++;
                console.log(`   ✅ TIE_BREAK: doc ${tieDoc.document_number} → order ${tieOrder.order_id} (score: ${tieScore})`);
              }
            }

            if (tieBreakSuccess) {
              console.log(`   🎯 Successfully resolved ${sortedDocs.length}:${sortedOrders.length} tie by chronological order`);
              continue; // Skip to next document, all related docs are now linked
            }
          }
        }

        // Fallback: Save as AMBIGUOUS candidates for manual review
        ambiguousCount++;
        
        // Save all candidates with score ≥60 to match_candidates table using admin client
        for (const candidate of highScoreCandidates) {
          const breakdown = {
            ...candidate.breakdown,
            notes: `Score ${candidate.score}: RUT=${candidate.breakdown.rut}, Amount=${candidate.breakdown.amount}, Date=${candidate.breakdown.date}, Name=${candidate.breakdown.name}`
          };
          
          const { error: candidateError } = await supabaseAdmin
            .from('order_tax_match_candidates')
            .upsert({
              tax_document_id: doc.id,
              order_id: candidate.order.id,
              match_score: candidate.score,
              breakdown,
              status: 'pending'
            }, { onConflict: 'tax_document_id,order_id' });

          if (!candidateError) {
            candidatesSavedCount++;
          } else if (!candidateError.message?.includes('duplicate')) {
            console.error(`   ⚠️ Candidate save error: ${candidateError.message}`);
          }
        }
        
        ambiguousCases.push({
          document: {
            id: doc.id,
            number: doc.document_number,
            date: doc.document_date,
            amount: doc.total_amount,
            client: doc.client_name,
            rut: doc.client_tax_id
          },
          candidates: highScoreCandidates.slice(0, 5).map(c => ({
            order_id: c.order.order_id,
            score: c.score,
            breakdown: c.breakdown,
            customer: c.order.customer_name,
            amount: c.order.gross_amount || c.order.amount
          }))
        });
        console.log(`⚠️ Stage 3: AMBIGUOUS doc ${doc.document_number} - ${highScoreCandidates.length} candidates with score ≥60 (saved to candidates table)`);
      }
      // Rule 4: If best score <60 → IGNORE (no action)
      else if (bestCandidate.score < 60) {
        ignoredCount++;
        console.log(`⏭️ Stage 3: IGNORED doc ${doc.document_number} - best score ${bestCandidate.score} < 60`);
      }
      // Edge case: Single candidate with score 60-69 (not high enough for AUTO_SOFT)
      else {
        // Save as candidate for manual review
        const breakdown = {
          ...bestCandidate.breakdown,
          notes: `Score ${bestCandidate.score}: Single candidate 60-69, needs manual review`
        };
        
        const { error: candidateError } = await supabaseAdmin
          .from('order_tax_match_candidates')
          .upsert({
            tax_document_id: doc.id,
            order_id: bestCandidate.order.id,
            match_score: bestCandidate.score,
            breakdown,
            status: 'pending'
          }, { onConflict: 'tax_document_id,order_id' });

        if (!candidateError) {
          candidatesSavedCount++;
          console.log(`📋 Stage 3: CANDIDATE doc ${doc.document_number} - score ${bestCandidate.score} (saved for review)`);
        }
        ignoredCount++;
      }
    }

    stage3 = autoLinkedCount + autoSoftCount + autoConsolidatedCount;

    console.log(`\nStage 3 Summary:`);
    console.log(`  Auto-consolidated (1:N): ${autoConsolidatedCount} docs (${autoConsolidatedOrdersCount} orders)`);
    console.log(`  Auto-linked 1:1 (≥85): ${autoLinkedCount}`);
    console.log(`  Auto-soft 1:1 (70-84): ${autoSoftCount}`);
    console.log(`  Ambiguous (multiple ≥60): ${ambiguousCount}`);
    console.log(`  Ignored/Skipped: ${ignoredCount}`);
    console.log(`  Candidates saved: ${candidatesSavedCount}`);

    // ==========================================
    // STAGE 4: Refunds without Credit Note
    // ==========================================
    console.log('\n--- STAGE 4: Refunds without NC ---');

    const { data: refundItems } = await supabase
      .from('settlement_items')
      .select(`
        *,
        orders (id, order_id, amount)
      `)
      .eq('item_type', 'REFUND')
      .eq('recon_status', 'pending');

    console.log(`Found ${refundItems?.length || 0} refund items`);

    let refundsProcessed = 0;
    for (const refund of refundItems || []) {
      if (!refund.order_id || !refund.orders) continue;

      // Check if there's a matching NC for this order
      const { data: creditNote } = await supabase
        .from('tax_documents')
        .select('id')
        .eq('document_type', 'NC')
        .eq('original_tax_document_id', refund.order_id)
        .maybeSingle();

      if (!creditNote) {
        // Flag as needs manual review
        await supabase
          .from('settlement_items')
          .update({ 
            recon_status: 'needs_nc',
            raw_data: {
              ...(refund.raw_data || {}),
              reconciliation_note: 'Refund without matching credit note - requires manual review'
            }
          })
          .eq('id', refund.id);

        stage4++;
        refundsProcessed++;
        console.log(`⚠️ Stage 4: Flagged refund ${refund.id} as needing NC`);
      }
    }

    console.log('\n=== AUTO-RECONCILE SUMMARY ===');
    console.log(`Stage 1 (Bank↔Settlement): ${stage1}`);
    console.log(`Stage 2 (Settlement↔Order): ${stage2}`);
    console.log(`Stage 3 (Order↔TaxDoc): ${hardLinkedCount} hard, ${autoConsolidatedCount} consolidated (${autoConsolidatedOrdersCount} orders), ${autoLinkedCount} auto, ${autoSoftCount} soft, ${ambiguousCount} ambiguous, ${excludedB2BCount} excluidos B2B`);
    console.log(`Stage 4 (Refunds flagged): ${stage4}`);
    console.log(`Total processed: ${stage1 + stage2 + stage3 + stage4}`);

    return new Response(
      JSON.stringify({ 
        success: true,
        message: 'Conciliación automática completada (4 etapas)',
        stage1_bank_settlement: stage1,
        stage2_settlement_order: stage2,
        stage3_order_taxdoc: {
          hard_linked: hardLinkedCount,
          auto_consolidated: autoConsolidatedCount,
          auto_consolidated_orders: autoConsolidatedOrdersCount,
          auto_linked: autoLinkedCount,
          auto_soft: autoSoftCount,
          ambiguous: ambiguousCount,
          ignored: ignoredCount,
          excluded_b2b: excludedB2BCount,
          candidates_saved: candidatesSavedCount,
          ambiguous_cases: ambiguousCases.slice(0, 10) // Return first 10 for debugging
        },
        stage4_refunds_flagged: stage4,
        total: stage1 + stage2 + stage3 + stage4,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error in auto-reconciliation:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});