import sys

with open('supabase/functions/auto-reconcile/index.ts', 'r') as f:
    lines = f.readlines()

content = "".join(lines)

# 1. Update calculateMatchScore to use pre-calculated meta
old_match_score = """    const calculateMatchScore = (order: any, doc: any): { score: number; breakdown: any } => {
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
      if (orderRut && docRut && orderRut === docRut) {"""

new_match_score = """    const calculateMatchScore = (order: any, doc: any): { score: number; breakdown: any } => {
      let score = 0;
      const breakdown = { rut: 0, amount: 0, date: 0, name: 0 };

      // Optimized: Use pre-calculated RUT if available
      const orderRut = order._normRut !== undefined ? order._normRut : normalizeRut(order.customer_tax_id);
      const docRut = doc._normRut !== undefined ? doc._normRut : normalizeRut(doc.client_tax_id);
      
      if (orderRut && docRut && orderRut === docRut) {"""

content = content.replace(old_match_score, new_match_score)

# 2. Update findConsolidatedMatch to use index
old_find_consolidated = """    const findConsolidatedMatch = (
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
        if (docRut && orderRut && orderRut !== docRut) return false;"""

new_find_consolidated = """    const findConsolidatedMatch = (
      doc: any,
      allOrders: any[],
      linkedOrderIds: Set<string>
    ): { orders: any[]; score: number; breakdown: any } | null => {
      const docRut = doc._normRut !== undefined ? doc._normRut : normalizeRut(doc.client_tax_id);
      const docTime = doc._dateMs !== undefined ? doc._dateMs : new Date(doc.document_date).getTime();
      const docAmount = doc.total_amount || 0;

      if (isGenericBoletaRut(docRut)) return null;

      // Optimized: Use index to avoid O(N) filtering
      const rutCandidates = docRut ? (ordersByRut.get(docRut) || []) : [];
      const potentialOrders = [...rutCandidates, ...ordersNoRut];

      const candidateOrders = potentialOrders.filter(order => {
        if (linkedOrderIds.has(order.id)) return false;
        if (order.status === 'cancelled') return false;
        if (order.currency_id && order.currency_id !== 'CLP') return false;

        const orderTime = order._dateMs || new Date(order.order_date).getTime();
        const daysDiff = Math.abs((docTime - orderTime) / (24 * 60 * 60 * 1000));
        if (daysDiff > 3) return false;"""

content = content.replace(old_find_consolidated, new_find_consolidated)

# 3. Add Pre-processing and index setup before Phase 0
old_stage3_start = """    const unlinkedDocs = allUnlinked; // Intentar match en todos, incluyendo los clasificados B2B
    console.log(`Found ${ordersNeedingDocs.length} orders needing documents (with money_release_date)`);
    console.log(`Found ${allUnlinked.length} unlinked tributary documents`);
    console.log(`  Clasificados B2B (pueden ser mal clasificados si sync corrió antes de órdenes): ${excludedB2BCount}`);
    console.log(`  Total elegibles para match: ${unlinkedDocs.length}`);

    let autoLinkedCount = 0;"""

new_stage3_start = """    const unlinkedDocs = allUnlinked; 
    
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
    const ordersByDateAsc = [...ordersWithMeta].sort((a, b) => a._dateMs - b._dateMs);
    
    const docListWithMeta = unlinkedDocs.map(d => ({
      ...d,
      _normRut: normalizeRut(d.client_tax_id),
      _dateMs: new Date(d.document_date).getTime(),
    }));

    console.log(`Found ${ordersNeedingDocs.length} orders needing docs, ${allUnlinked.length} unlinked docs`);

    let autoLinkedCount = 0;"""

content = content.replace(old_stage3_start, new_stage3_start)

# 4. Batching for Phase 0
old_phase0 = """    for (const doc of unlinkedDocs) {
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
    }"""

new_phase0 = """    const hardLinks: any[] = [];
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
    }"""

content = content.replace(old_phase0, new_phase0)

# 5. Batching for Phase 0B
old_phase0b = """      for (const order of packOrders) {
        const { error: linkErr } = await supabaseAdmin
          .from('order_tax_documents')
          .insert({
            order_id: order.id,
            tax_document_id: doc.id,
            allocated_amount: order.gross_amount || order.amount,
            created_by: user.id,
            match_source: 'AUTO_HARD_PACK_ID',
            match_score: 100,
          });
        if (!linkErr) {
          newlyLinkedOrderIds.add(order.id);
          packLinkedOrdersCount++;
          linkedAny = true;
        }
      }"""

new_phase0b = """      const packLinks: any[] = [];
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
      }"""

content = content.replace(old_phase0b, new_phase0b)

# 6. Optimization for Phase A (Consolidated) - use docListWithMeta and batching
old_phase_a_loop = """    for (const doc of unlinkedDocs) {
      // Skip if already linked in this run
      if (newlyLinkedDocIds.has(doc.id)) continue;

      // Try consolidated match first
      const consolidatedMatch = findConsolidatedMatch(
        doc, 
        ordersNeedingDocs.filter(o => !linkedOrderIds.has(o.id) && !newlyLinkedOrderIds.has(o.id)),
        new Set([...linkedOrderIds, ...newlyLinkedOrderIds])
      );"""

new_phase_a_loop = """    const consolidatedLinks: any[] = [];
    const consolidatedCandidates: any[] = [];
    
    for (const doc of docListWithMeta) {
      if (newlyLinkedDocIds.has(doc.id)) continue;

      const consolidatedMatch = findConsolidatedMatch(
        doc, 
        [], // allOrders is now used via index inside findConsolidatedMatch
        new Set([...linkedOrderIds, ...newlyLinkedOrderIds])
      );"""

content = content.replace(old_phase_a_loop, new_phase_a_loop)

# 7. Update Phase A inner logic for batching
old_phase_a_inner = """          for (const order of orders) {
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
        }"""

new_phase_a_inner = """          for (const order of orders) {
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
        }"""

content = content.replace(old_phase_a_inner, new_phase_a_inner)

# 8. Add Phase A batch execution
old_phase_a_end = """    console.log(`\\nStage 3A Summary: ${autoConsolidatedCount} docs consolidated (${autoConsolidatedOrdersCount} orders)`);"""

new_phase_a_end = """    if (consolidatedLinks.length > 0) {
      await supabaseAdmin.from('order_tax_documents').insert(consolidatedLinks);
    }
    if (consolidatedCandidates.length > 0) {
      await supabaseAdmin.from('order_tax_match_candidates').upsert(consolidatedCandidates, { onConflict: 'tax_document_id,order_id' });
    }
    console.log(`\\nStage 3A Summary: ${autoConsolidatedCount} docs consolidated (${autoConsolidatedOrdersCount} orders)`);"""

content = content.replace(old_phase_a_end, new_phase_a_end)

# 9. Optimization for Phase B (Simple Match) - use date search and metadata
old_phase_b_start = """    // Process each unlinked document (skip those already handled by consolidated matching)
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
        console.log(`\\n🔍 DEBUG Doc ${doc.document_number}: RUT=${doc.client_tax_id}, Amount=${docAmount}, Date=${doc.document_date}`);
        console.log(`   Total orders to check: ${ordersNeedingDocs.length}`);
      }

      const candidates = ordersNeedingDocs
        .filter(order => !linkedOrderIds.has(order.id) && !newlyLinkedOrderIds.has(order.id)) // Exclude linked orders
        .map(order => {
          const orderDate = new Date(order.order_date);
          const daysDiff = Math.abs((docDate.getTime() - orderDate.getTime()) / (24 * 60 * 60 * 1000));
          const orderAmount = order.gross_amount || order.amount || 0;
          const amountDiff = Math.abs(orderAmount - docAmount);"""

new_phase_b_start = """    const simpleLinks: any[] = [];
    const simpleCandidates: any[] = [];
    
    for (const doc of docListWithMeta) {
      if (newlyLinkedDocIds.has(doc.id)) continue;

      const docTime = doc._dateMs;
      const docAmount = doc.total_amount || 0;
      const amountTolerance = Math.max(docAmount * 0.02, 500);

      // OPTIMIZED: Use binary search for +/- 5 days
      const windowMs = 5 * 24 * 60 * 60 * 1000;
      const startTime = docTime - windowMs;
      const endTime = docTime + windowMs;
      
      let startIdx = 0, low = 0, high = ordersByDateAsc.length;
      while (low < high) {
        let mid = (low + high) >>> 1;
        if (ordersByDateAsc[mid]._dateMs < startTime) low = mid + 1;
        else high = mid;
      }
      startIdx = low;

      const candidates = [];
      for (let i = startIdx; i < ordersByDateAsc.length; i++) {
        const order = ordersByDateAsc[i];
        if (order._dateMs > endTime) break;
        if (linkedOrderIds.has(order.id) || newlyLinkedOrderIds.has(order.id)) continue;

        const amountDiff = Math.abs(order._amount - docAmount);
        if (amountDiff > amountTolerance) continue;

        const { score, breakdown } = calculateMatchScore(order, doc);
        candidates.push({ order, score, breakdown });
      }
      candidates.sort((a, b) => b.score - a.score);"""

content = content.replace(old_phase_b_start, new_phase_b_start)

# 10. Update Phase B inner logic for batching
old_phase_b_link = """      // Rule 1: If ONLY ONE candidate has score ≥85 → AUTO-LINK
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
      }"""

new_phase_b_link = """      if (bestCandidate.score >= 85 && candidates85Plus.length === 1) {
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
      }"""

content = content.replace(old_phase_b_link, new_phase_b_link)

# 11. Update Phase B Tie-break for batching
old_phase_b_tie = """            // Link 1:1 by position using admin client
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
            }"""

new_phase_b_tie = """            for (let i = 0; i < sortedDocs.length; i++) {
              const tieDoc = sortedDocs[i];
              const tieOrder = sortedOrders[i];
              simpleLinks.push({
                order_id: tieOrder.id, tax_document_id: tieDoc.id, allocated_amount: tieDoc.total_amount,
                match_source: 'AUTO_TIE_BREAK', match_score: tieScore, created_by: user.id, resync_batch: tieDoc.resync_batch
              });
              newlyLinkedDocIds.add(tieDoc.id);
              newlyLinkedOrderIds.add(tieOrder.id);
              autoLinkedCount++;
            }"""

content = content.replace(old_phase_b_tie, new_phase_b_tie)

# 12. Update Phase B candidate save for batching
old_phase_b_cand = """        // Save all candidates with score ≥60 to match_candidates table using admin client
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
        }"""

new_phase_b_cand = """        for (const candidate of highScoreCandidates) {
          simpleCandidates.push({
            tax_document_id: doc.id, order_id: candidate.order.id, match_score: candidate.score,
            breakdown: { ...candidate.breakdown, notes: `Score ${candidate.score}` },
            status: 'pending'
          });
          candidatesSavedCount++;
        }"""

content = content.replace(old_phase_b_cand, new_phase_b_cand)

# 13. Edge case for single candidate 60-69 batching
old_phase_b_edge = """        const { error: candidateError } = await supabaseAdmin
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
        }"""

new_phase_b_edge = """        simpleCandidates.push({
          tax_document_id: doc.id, order_id: bestCandidate.order.id, match_score: bestCandidate.score,
          breakdown, status: 'pending'
        });
        candidatesSavedCount++;"""

content = content.replace(old_phase_b_edge, new_phase_b_edge)

# 14. Add Phase B batch execution
old_phase_b_end = """    stage3 = autoLinkedCount + autoSoftCount + autoConsolidatedCount + packLinkedDocsCount;"""

new_phase_b_end = """    if (simpleLinks.length > 0) {
      await supabaseAdmin.from('order_tax_documents').insert(simpleLinks);
    }
    if (simpleCandidates.length > 0) {
      await supabaseAdmin.from('order_tax_match_candidates').upsert(simpleCandidates, { onConflict: 'tax_document_id,order_id' });
    }
    stage3 = autoLinkedCount + autoSoftCount + autoConsolidatedCount + packLinkedDocsCount + hardLinkedCount;"""

content = content.replace(old_phase_b_end, new_phase_b_end)

# 15. Stage 4 Optimization
old_stage4 = """    let refundsProcessed = 0;
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
    }"""

new_stage4 = """    const { data: allNCs } = await supabaseAdmin
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
    }"""

content = content.replace(old_stage4, new_stage4)

with open('supabase/functions/auto-reconcile/index.ts', 'w') as f:
    f.write(content)
