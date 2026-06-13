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

    // Optional period scope (limits Stage 3 order/doc fetch for performance).
    // If omitted, Stage 3 scans the full history as before.
    const body = await req.json().catch(() => ({} as any));
    const periodFrom: string | null = body?.date_from || null;
    const periodTo: string | null = body?.date_to || null;

    console.log('=== AUTO-RECONCILE 4-STAGE START ===');
    console.log('=== build:paginate-docs-v2 ===');
    console.log('User ID:', user.id);
    if (periodFrom && periodTo) {
      console.log(`Period scope: ${periodFrom} – ${periodTo} (Stage 3, ±7d buffer)`);
    }

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
      // Body-only comparison (DV stored in separate column). Cover both legacy and new format.
      return n === '666666666' || n === '66666666K' || n === '11111111K'
          || n === '66666666' || n === '1111111';
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
      const breakdown = { rut: 0, amount: 0, date: 0, name: 0 };

      // Optimized: Use pre-calculated RUT if available
      const orderRut = order._normRut !== undefined ? order._normRut : normalizeRut(order.customer_tax_id);
      const docRut = doc._normRut !== undefined ? doc._normRut : normalizeRut(doc.client_tax_id);
      
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
      const docRut = doc._normRut !== undefined ? doc._normRut : normalizeRut(doc.client_tax_id);
      const docTime = doc._dateMs !== undefined ? doc._dateMs : new Date(doc.document_date).getTime();
      const docAmount = doc.total_amount || 0;

      if (!docRut || isGenericBoletaRut(docRut)) return null;

      const rutCandidates = docRut ? (ordersByRut.get(docRut) || []) : [];
      const potentialOrders = [...rutCandidates, ...ordersNoRut];

      const candidateOrders = potentialOrders.filter(order => {
        if (linkedOrderIds.has(order.id)) return false;
        if (order.status === 'cancelled') return false;
        if (order.currency_id && order.currency_id !== 'CLP') return false;
        const orderTime = order._dateMs || new Date(order.order_date).getTime();
        return Math.abs((docTime - orderTime) / (24 * 60 * 60 * 1000)) <= 3;
      });

      if (candidateOrders.length < 2) return null;

      const sameDayOrders = candidateOrders.filter(o => 
        Math.abs((docTime - (o._dateMs || new Date(o.order_date).getTime())) / (24 * 60 * 60 * 1000)) < 0.5
      );

      const orderedGroups = [
        { name: 'same_day', orders: sameDayOrders },
        { name: 'other', orders: candidateOrders }
      ];

      const validCombinations: { orders: any[]; score: number; breakdown: any }[] = [];
      const tolerance = 100;

      for (const group of orderedGroups) {
        if (group.orders.length < 2) continue;
        for (let size = 2; size <= Math.min(5, group.orders.length); size++) {
          let combinationsChecked = 0;
          for (const combo of generateCombinations(group.orders, size)) {
            if (++combinationsChecked > 100) break;
            const sum = combo.reduce((acc, o) => acc + (o._amount || 0), 0);
            if (Math.abs(sum - docAmount) <= tolerance) {
              const { score, breakdown } = calculateConsolidatedScore(combo, doc);
              if (score >= 60) validCombinations.push({ orders: combo, score, breakdown });
            }
          }
        }
        if (group.name === 'same_day' && validCombinations.length > 0) break;
      }

      if (validCombinations.length === 0) return null;

      validCombinations.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.orders.length - b.orders.length;
      });

      const topScore = validCombinations[0].score;
      const topMatches = validCombinations.filter(c => c.score === topScore);

      if (topMatches.length > 1) {
        const sortedByOrders = topMatches.sort((a, b) => a.orders.length - b.orders.length);
        if (sortedByOrders[0].orders.length < sortedByOrders[1].orders.length) return sortedByOrders[0];
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
    const BUFFER_MS = 7 * 24 * 60 * 60 * 1000; // catch cross-month order/doc pairs near period edges
    const PAGE_SIZE = 1000; // PostgREST impone un max-rows de ~1000 que .limit() no supera

    let bufferedFromISO: string | null = null;
    let bufferedToISO: string | null = null;
    if (periodFrom && periodTo) {
      bufferedFromISO = new Date(new Date(periodFrom).getTime() - BUFFER_MS).toISOString();
      bufferedToISO   = new Date(new Date(periodTo).getTime() + BUFFER_MS).toISOString();
    }

    // Paginar con .range(): igual que tax_documents más abajo, .limit(5000) se
    // cortaba en ~1000 filas server-side y dejaba miles de órdenes fuera de Stage 3.
    const ordersWithPayment: any[] = [];
    for (let page = 0; page < 10; page++) {
      let q = supabaseAdmin
        .from('orders')
        .select(`
          *,
          order_tax_documents(id)
        `)
        .neq('status', 'cancelled')
        .order('order_date', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (bufferedFromISO && bufferedToISO) {
        q = q.gte('order_date', bufferedFromISO).lte('order_date', bufferedToISO);
      }
      const { data: pageData, error: pageErr } = await q;
      if (pageErr) { console.error('orders page error:', pageErr.message); break; }
      if (!pageData || pageData.length === 0) break;
      ordersWithPayment.push(...pageData);
      if (pageData.length < PAGE_SIZE) break;
    }

    console.log(`Fetched ${ordersWithPayment.length} non-cancelled orders (paginated)`);

    // Filter to orders with payment but no document
    const ordersNeedingDocs = ordersWithPayment.filter(order => {
      const hasDocument = order.order_tax_documents && order.order_tax_documents.length > 0;
      return !hasDocument;
    });

    // Fetch linked orders for consolidated matching check (using admin for consistency),
    // paginado por la misma razón que la query de orders arriba.
    const linkedOrderTaxDocs: any[] = [];
    for (let page = 0; page < 10; page++) {
      const { data: pageData, error: pageErr } = await supabaseAdmin
        .from('order_tax_documents')
        .select('order_id, tax_document_id')
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (pageErr) { console.error('order_tax_documents page error:', pageErr.message); break; }
      if (!pageData || pageData.length === 0) break;
      linkedOrderTaxDocs.push(...pageData);
      if (pageData.length < PAGE_SIZE) break;
    }

    const linkedOrderIds = new Set(linkedOrderTaxDocs.map(d => d.order_id));
    const linkedDocIds = new Set(linkedOrderTaxDocs.map(d => d.tax_document_id));

    // Paginar explícitamente con .range() porque PostgREST impone un max-rows
    // de ~1000 en el servidor que .limit() no supera. Sin paginar, Stage 3
    // procesaba solo los primeros 600 docs y dejaba miles sin matchear.
    // Excluimos raw_data (JSONB pesado) para reducir tamaño de respuesta.
    const DOCS_COLUMNS = 'id, user_id, external_order_id, external_id, external_system, client_tax_id, client_tax_id_dv, client_name, total_amount, net_amount, tax_amount, document_date, document_number, document_type, sales_channel, detected_channel, status, resync_batch';
    const bufferedFromDate = bufferedFromISO ? bufferedFromISO.split('T')[0] : null;
    const bufferedToDate   = bufferedToISO ? bufferedToISO.split('T')[0] : null;
    const allDocs: any[] = [];
    for (let page = 0; page < 20; page++) {
      let q = supabaseAdmin
        .from('tax_documents')
        .select(DOCS_COLUMNS)
        .eq('status', 'issued')
        .in('document_type', ['boleta', 'factura', 'factura_exenta'])
        .order('document_date', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (bufferedFromDate && bufferedToDate) {
        q = q.gte('document_date', bufferedFromDate).lte('document_date', bufferedToDate);
      }
      const { data: pageData, error: pageErr } = await q;
      if (pageErr) { console.error('docs page error:', pageErr.message); break; }
      if (!pageData || pageData.length === 0) break;
      allDocs.push(...pageData);
      if (pageData.length < PAGE_SIZE) break;
    }
    console.log(`Fetched ${allDocs.length} tax_documents in scope (paginated)`);

    // El filtro por document_type ya excluye guías y no-tributarios.
    // (Anteriormente se re-filtraba por raw_data.codeSii, pero raw_data ya no se trae.)
    const tributaryDocs = (allDocs || []);

    // Incluir todos los docs no vinculados — la clasificación B2B puede ser incorrecta
    // si sync-bsale-docs corrió antes que sync-meli-orders (sin órdenes para comparar RUT).
    // Si un doc B2B genuino no tiene orden, simplemente queda sin vincular. Sin daño.
    const allUnlinked = tributaryDocs.filter(doc => !linkedDocIds.has(doc.id));
    const excludedB2BCount = allUnlinked.filter(doc => doc.sales_channel === 'B2B').length;
    const unlinkedDocs = allUnlinked; 
    
    // --- OPTIMIZATION: PRE-CALCULATE AND INDEX ---
    const ordersWithMeta = ordersNeedingDocs.map(o => ({
      ...o,
      _normRut: normalizeRut(o.customer_tax_id),
      _dateMs: new Date(o.order_date).getTime(),
      _amount: o.gross_amount || o.amount || 0,
    }));
    
    const ordersByRut = new Map<string, any[]>();
    const ordersNoRut: any[] = [];
    for (const o of ordersWithMeta) {
      if (o._normRut) {
        if (!ordersByRut.has(o._normRut)) ordersByRut.set(o._normRut, []);
        ordersByRut.get(o._normRut)!.push(o);
      } else {
        ordersNoRut.push(o);
      }
    }
    for (const orders of ordersByRut.values()) {
      orders.sort((a, b) => a._dateMs - b._dateMs);
    }
    const ordersNoRutByDateAsc = [...ordersNoRut].sort((a, b) => a._dateMs - b._dateMs);
    
    const docListWithMeta = unlinkedDocs.map(d => ({
      ...d,
      _normRut: normalizeRut(d.client_tax_id),
      _dateMs: new Date(d.document_date).getTime(),
    }));
    const relatedDocsByTieKey = new Map<string, any[]>();
    for (const doc of docListWithMeta) {
      const tieKey = `${doc._normRut}|${doc.total_amount}|${doc.document_date}`;
      if (!relatedDocsByTieKey.has(tieKey)) relatedDocsByTieKey.set(tieKey, []);
      relatedDocsByTieKey.get(tieKey)!.push(doc);
    }
    const hasOrdersWithoutRut = ordersNoRutByDateAsc.length > 0;

    console.log(`Found ${ordersNeedingDocs.length} orders needing docs, ${allUnlinked.length} unlinked docs`);

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
    const hardLinks: any[] = [];
    for (const doc of unlinkedDocs) {
      const eoi = (doc as any).external_order_id;
      if (!eoi) continue;
      const order = ordersByOrderId.get(String(eoi));
      if (!order || linkedOrderIds.has(order.id) || newlyLinkedDocIds.has(doc.id)) continue;
      hardLinks.push({
        order_id: order.id, tax_document_id: doc.id, allocated_amount: doc.total_amount,
        created_by: user.id, match_source: 'AUTO_HARD_ORDER_ID', match_score: 100
      });
      newlyLinkedDocIds.add(doc.id);
      newlyLinkedOrderIds.add(order.id);
      hardLinkedCount++;
    }
    if (hardLinks.length > 0) {
      await supabaseAdmin.from('order_tax_documents').insert(hardLinks);
    }
    console.log(`Stage 3 Phase 0 (Hard match external_order_id): ${hardLinkedCount} linked`);

    // ==========================================
    // PHASE 0B: HARD MATCH by pack_id (1:N)
    // MercadoLibre agrupa varias órdenes en un mismo "pack" (envío) y Bsale
    // emite un solo documento referenciando ese pack_id en external_order_id.
    // ==========================================
    let packLinkedDocsCount = 0;
    let packLinkedOrdersCount = 0;
    const ordersByPackId = new Map<string, any[]>();
    for (const o of ordersNeedingDocs) {
      const packId = o.raw_data?.pack_id;
      if (!packId) continue;
      const key = String(packId);
      if (!ordersByPackId.has(key)) ordersByPackId.set(key, []);
      ordersByPackId.get(key)!.push(o);
    }
    for (const doc of unlinkedDocs) {
      if (newlyLinkedDocIds.has(doc.id)) continue;
      const eoi = (doc as any).external_order_id;
      if (!eoi) continue;
      const packOrders = (ordersByPackId.get(String(eoi)) || [])
        .filter(o => !linkedOrderIds.has(o.id) && !newlyLinkedOrderIds.has(o.id));
      if (packOrders.length === 0) continue;
      let linkedAny = false;
      const packLinks: any[] = [];
      for (const order of packOrders) {
        packLinks.push({
          order_id: order.id, tax_document_id: doc.id, allocated_amount: order.gross_amount || order.amount,
          created_by: user.id, match_source: 'AUTO_HARD_PACK_ID', match_score: 100
        });
        newlyLinkedOrderIds.add(order.id);
        packLinkedOrdersCount++;
        linkedAny = true;
      }
      if (packLinks.length > 0) {
        await supabaseAdmin.from('order_tax_documents').insert(packLinks);
      }
      if (linkedAny) {
        newlyLinkedDocIds.add(doc.id);
        packLinkedDocsCount++;
      }
    }
    console.log(`Stage 3 Phase 0B (Hard match pack_id, 1:N): ${packLinkedDocsCount} docs, ${packLinkedOrdersCount} orders linked`);

    // ==========================================
    // PHASE A: CONSOLIDATED MATCHING (1:N) - NEW
    // ==========================================
    console.log('\n--- Stage 3A: Consolidated Matching (1:N) ---');
    const consolidatedLinks: any[] = [];
    const consolidatedCandidates: any[] = [];

    for (const doc of unlinkedDocs) {
      // Skip if already linked in this run
      if (newlyLinkedDocIds.has(doc.id)) continue;

      // Try consolidated match first
      const consolidatedMatch = findConsolidatedMatch(
        doc, 
        ordersNeedingDocs,
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
            consolidatedCandidates.push({
              tax_document_id: doc.id, order_id: order.id, match_score: score,
              breakdown: { ...breakdown, notes: `Consolidated match: ${orders.length} orders, ambiguous` },
              status: 'pending'
            });
            candidatesSavedCount++;
          }
          continue;
        }

        if (score >= 80) {
          for (const order of orders) {
            consolidatedLinks.push({
              order_id: order.id, tax_document_id: doc.id, allocated_amount: order.gross_amount || order.amount,
              match_source: 'AUTO_CONSOLIDATED', match_score: score, created_by: user.id, resync_batch: doc.resync_batch
            });
            newlyLinkedOrderIds.add(order.id);
          }
          autoConsolidatedCount++;
          autoConsolidatedOrdersCount += orders.length;
          newlyLinkedDocIds.add(doc.id);
        } else if (score >= 60) {
          for (const order of orders) {
            consolidatedCandidates.push({
              tax_document_id: doc.id, order_id: order.id, match_score: score,
              breakdown: { ...breakdown, notes: `Consolidated match: ${orders.length} orders, score ${score}` },
              status: 'pending'
            });
            candidatesSavedCount++;
          }
        }
      }
    }

    if (consolidatedLinks.length > 0) {
      await supabaseAdmin.from('order_tax_documents').insert(consolidatedLinks);
    }
    if (consolidatedCandidates.length > 0) {
      await supabaseAdmin.from('order_tax_match_candidates').upsert(consolidatedCandidates, { onConflict: 'tax_document_id,order_id' });
    }
    console.log(`\nStage 3A Summary: ${autoConsolidatedCount} docs consolidated (${autoConsolidatedOrdersCount} orders)`);

    // ==========================================
    // PHASE B: SIMPLE MATCHING (1:1) - Existing
    // ==========================================
    console.log('\n--- Stage 3B: Simple Matching (1:1) ---');

    const simpleLinks: any[] = [];
    const simpleCandidates: any[] = [];
    
    for (const doc of docListWithMeta) {
      if (newlyLinkedDocIds.has(doc.id)) continue;

      if ((!doc._normRut || isGenericBoletaRut(doc._normRut)) && !hasOrdersWithoutRut) {
        ignoredCount++;
        continue;
      }

      const docTime = doc._dateMs;
      const docAmount = doc.total_amount || 0;
      const amountTolerance = Math.max(docAmount * 0.02, 500);
      const candidatePool = doc._normRut && !isGenericBoletaRut(doc._normRut)
        ? (ordersByRut.get(doc._normRut) || [])
        : ordersNoRutByDateAsc;

      if (candidatePool.length === 0) {
        ignoredCount++;
        continue;
      }

      // OPTIMIZED: Use binary search for +/- 5 days
      const windowMs = 5 * 24 * 60 * 60 * 1000;
      const startTime = docTime - windowMs;
      const endTime = docTime + windowMs;
      
      let startIdx = 0, low = 0, high = candidatePool.length;
      while (low < high) {
        let mid = (low + high) >>> 1;
        if (candidatePool[mid]._dateMs < startTime) low = mid + 1;
        else high = mid;
      }
      startIdx = low;

      const candidates = [];
      for (let i = startIdx; i < candidatePool.length; i++) {
        const order = candidatePool[i];
        if (order._dateMs > endTime) break;
        if (linkedOrderIds.has(order.id) || newlyLinkedOrderIds.has(order.id)) continue;

        const amountDiff = Math.abs(order._amount - docAmount);
        if (amountDiff > amountTolerance) continue;

        const { score, breakdown } = calculateMatchScore(order, doc);
        candidates.push({ order, score, breakdown });
      }
      candidates.sort((a, b) => b.score - a.score);

      if (candidates.length === 0) {
        ignoredCount++;
        continue;
      }

      const bestCandidate = candidates[0];
      const highScoreCandidates = candidates.filter(c => c.score >= 60);
      const candidates85Plus = candidates.filter(c => c.score >= 85);
      const candidates70Plus = candidates.filter(c => c.score >= 70);

      if (bestCandidate.score >= 85 && candidates85Plus.length === 1) {
        simpleLinks.push({
          order_id: bestCandidate.order.id, tax_document_id: doc.id, allocated_amount: doc.total_amount,
          match_source: 'AUTO', match_score: bestCandidate.score, created_by: user.id, resync_batch: doc.resync_batch
        });
        autoLinkedCount++;
        newlyLinkedDocIds.add(doc.id);
        newlyLinkedOrderIds.add(bestCandidate.order.id);
      }
      else if (bestCandidate.score >= 70 && candidates70Plus.length === 1) {
        simpleLinks.push({
          order_id: bestCandidate.order.id, tax_document_id: doc.id, allocated_amount: doc.total_amount,
          match_source: 'AUTO_SOFT', match_score: bestCandidate.score, created_by: user.id, resync_batch: doc.resync_batch
        });
        autoSoftCount++;
        newlyLinkedDocIds.add(doc.id);
        newlyLinkedOrderIds.add(bestCandidate.order.id);
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

          const tieKey = `${doc._normRut}|${doc.total_amount}|${doc.document_date}`;
          const relatedDocs = (relatedDocsByTieKey.get(tieKey) || []).filter(d => 
            !newlyLinkedDocIds.has(d.id) &&
            d._normRut === docRut
          );

          // Perfect N:N tie scenario: same number of docs and orders
          if (relatedDocs.length === candidateOrders.length && relatedDocs.length > 1 && tieScore >= 85) {
            // Sort documents by document number (ascending)
            const sortedDocs = [...relatedDocs].sort((a, b) => 
              Number(a.document_number) - Number(b.document_number)
            );

            // Sort orders by creation date (ascending)
            const sortedOrders = [...candidateOrders].sort((a, b) => 
              new Date(a.created_at || a.order_date).getTime() - 
              new Date(b.created_at || b.order_date).getTime()
            );

            for (let i = 0; i < sortedDocs.length; i++) {
              const tieDoc = sortedDocs[i];
              const tieOrder = sortedOrders[i];
              simpleLinks.push({
                order_id: tieOrder.id, tax_document_id: tieDoc.id, allocated_amount: tieDoc.total_amount,
                match_source: 'AUTO_TIE_BREAK', match_score: tieScore, created_by: user.id, resync_batch: tieDoc.resync_batch
              });
              newlyLinkedDocIds.add(tieDoc.id);
              newlyLinkedOrderIds.add(tieOrder.id);
              autoLinkedCount++;
            }

            continue; // Skip to next document, all related docs are now linked
          }
        }

        // Fallback: Save as AMBIGUOUS candidates for manual review
        ambiguousCount++;
        
        for (const candidate of highScoreCandidates) {
          simpleCandidates.push({
            tax_document_id: doc.id, order_id: candidate.order.id, match_score: candidate.score,
            breakdown: { ...candidate.breakdown, notes: `Score ${candidate.score}` },
            status: 'pending'
          });
          candidatesSavedCount++;
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
      }
      // Edge case: Single candidate with score 60-69 (not high enough for AUTO_SOFT)
      else {
        // Save as candidate for manual review
        const breakdown = {
          ...bestCandidate.breakdown,
          notes: `Score ${bestCandidate.score}: Single candidate 60-69, needs manual review`
        };
        
        simpleCandidates.push({
          tax_document_id: doc.id, order_id: bestCandidate.order.id, match_score: bestCandidate.score,
          breakdown, status: 'pending'
        });
        candidatesSavedCount++;
        ignoredCount++;
      }
    }

    if (simpleLinks.length > 0) {
      await supabaseAdmin.from('order_tax_documents').insert(simpleLinks);
    }
    if (simpleCandidates.length > 0) {
      await supabaseAdmin.from('order_tax_match_candidates').upsert(simpleCandidates, { onConflict: 'tax_document_id,order_id' });
    }
    stage3 = autoLinkedCount + autoSoftCount + autoConsolidatedCount + packLinkedDocsCount + hardLinkedCount;

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

    const { data: allNCs } = await supabaseAdmin
      .from('tax_documents')
      .select('original_tax_document_id')
      .eq('document_type', 'NC');
    
    const ncOriginalIds = new Set(allNCs?.map(nc => nc.original_tax_document_id).filter(Boolean));
    const refundsToFlag = (refundItems || []).filter(r => r.order_id && !ncOriginalIds.has(r.order_id));

    for (const refund of refundsToFlag) {
      await supabaseAdmin
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
    }

    console.log('\n=== AUTO-RECONCILE SUMMARY ===');
    console.log(`Stage 1 (Bank↔Settlement): ${stage1}`);
    console.log(`Stage 2 (Settlement↔Order): ${stage2}`);
    console.log(`Stage 3 (Order↔TaxDoc): ${hardLinkedCount} hard, ${packLinkedDocsCount} pack_id (${packLinkedOrdersCount} orders), ${autoConsolidatedCount} consolidated (${autoConsolidatedOrdersCount} orders), ${autoLinkedCount} auto, ${autoSoftCount} soft, ${ambiguousCount} ambiguous, ${excludedB2BCount} excluidos B2B`);
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
          hard_linked_pack_id: packLinkedDocsCount,
          hard_linked_pack_id_orders: packLinkedOrdersCount,
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