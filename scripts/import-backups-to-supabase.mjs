#!/usr/bin/env node

/**
 * Import raw MELI/Bsale backup dumps into Quadra/Supabase.
 *
 * Safety:
 * - dry-run by default; pass --apply to write
 * - never uploads/commits backup JSON files
 * - deduplicates MELI by order.id and Bsale by document.id
 * - uses the same conflict keys as production sync functions
 * - preserves has_exact_data=true on already-enriched MELI orders
 *
 * Required env for --apply:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Required args:
 *   --user-id <uuid>
 *   --meli-account-id <uuid>
 *   --meli <file>            repeatable
 *   --bsale <file>           repeatable
 */

import fs from 'node:fs/promises';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const getOne = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const getMany = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
};

const apply = args.includes('--apply');
const userId = getOne('--user-id');
const meliAccountId = getOne('--meli-account-id');
const meliFiles = getMany('--meli');
const bsaleFiles = getMany('--bsale');

if (!userId || !meliAccountId || (meliFiles.length === 0 && bsaleFiles.length === 0)) {
  console.error(`Usage:\n  node scripts/import-backups-to-supabase.mjs \\\n    --user-id <uuid> \\\n    --meli-account-id <uuid> \\\n    --meli /path/meli-2026-05.json --meli /path/meli-2026-06.json \\\n    --bsale /path/bsale-2026-05.json --bsale /path/bsale-2026-06.json [--apply]`);
  process.exit(2);
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

function splitRut(rut) {
  if (!rut) return { body: null, dv: null };
  const clean = String(rut).replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 2) return { body: null, dv: null };
  return { body: clean.slice(0, -1), dv: clean.slice(-1) };
}

function mapMeliStatus(order) {
  const status = String(order?.status || '').toLowerCase();
  if (status === 'cancelled') return 'cancelled';
  if (status === 'paid') return 'confirmed';
  return 'pending';
}

function transformMeliOrder(order, preserveExact = false) {
  const buyer = order.buyer || {};
  const billingInfo = buyer.billing_info || {};
  const rawRut = billingInfo.doc_number || billingInfo.docNumber || null;
  const { body: customerTaxId, dv: customerTaxIdDv } = splitRut(rawRut);
  const shipping = order.shipping || {};
  const coupon = order.coupon || {};
  const firstItem = order.order_items?.[0];

  const row = {
    channel: 'meli',
    channel_account_id: meliAccountId,
    meli_account_id: meliAccountId,
    order_id: String(order.id),
    customer_name: buyer.nickname || 'Cliente',
    customer_email: buyer.email || null,
    customer_tax_id: customerTaxId,
    customer_tax_id_dv: customerTaxIdDv,
    order_date: new Date(order.date_created).toISOString(),
    amount: Number(order.total_amount || 0),
    gross_amount: Number(order.total_amount || 0),
    status: mapMeliStatus(order),
    items: order.order_items?.length || 1,
    raw_data: order,
    shipping_cost: Number(shipping.cost || 0),
    discount_amount: Number(coupon.amount || 0),
    currency_id: order.currency_id || 'CLP',
    shipping_mode: shipping.shipping_mode || null,
    shipping_id: shipping.id != null ? String(shipping.id) : null,
    date_shipped: shipping.date_shipped || null,
    date_delivered: shipping.date_delivered || null,
    seller_sku: firstItem?.item?.seller_custom_field || firstItem?.item?.seller_sku || null,
    product_title: firstItem?.item?.title || null,
  };

  // Match sync-meli-orders: routine commercial imports must never reset exact MP data.
  if (!preserveExact) row.has_exact_data = false;
  return row;
}

const VALID_SII = new Set([33, 34, 39, 41, 56, 61]);
function mapBsaleDocType(code) {
  const n = Number(code);
  if (n === 33) return 'factura';
  if (n === 34) return 'factura_exenta';
  if (n === 39 || n === 41) return 'boleta';
  if (n === 61) return 'nota_credito';
  if (n === 56) return 'nota_debito';
  return null;
}

function extractExternalOrderId(doc) {
  const re = /(\d{10,})/;
  const note = doc.client?.note;
  if (note) {
    const m = String(note).match(re);
    if (m) return m[1];
  }
  for (const ref of doc.references?.items || []) {
    const m = `${ref.reason || ''} ${ref.number || ''}`.match(re);
    if (m) return m[1];
  }
  for (const detail of doc.details?.items || []) {
    if (!detail.comment) continue;
    const m = String(detail.comment).match(re);
    if (m) return m[1];
  }
  return null;
}

function chileDateFromUnix(ts) {
  if (!ts) return null;
  return new Date(Number(ts) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

function transformBsaleDoc(doc, batchId) {
  const codeSii = Number(doc.document_type?.codeSii);
  if (!VALID_SII.has(codeSii)) return null;
  const documentType = mapBsaleDocType(codeSii);
  if (!documentType) return null;

  const clientName = doc.client?.firstName && doc.client?.lastName
    ? `${doc.client.firstName} ${doc.client.lastName}`.trim()
    : doc.client?.company || doc.client?.activity || 'Cliente';
  const { body: clientTaxId, dv: clientTaxIdDv } = splitRut(doc.client?.code);
  const externalOrderId = extractExternalOrderId(doc);
  const netAmount = Number(doc.netAmount || 0);
  const taxAmount = Number(doc.taxAmount || 0);
  const totalAmount = Number(doc.totalAmount || 0) || netAmount + taxAmount;

  return {
    user_id: userId,
    document_type: documentType,
    document_number: String(doc.number ?? doc.id),
    document_date: chileDateFromUnix(doc.emissionDate),
    net_amount: netAmount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    client_name: clientName,
    client_tax_id: clientTaxId,
    client_tax_id_dv: clientTaxIdDv,
    external_system: 'bsale',
    external_id: String(doc.id),
    external_order_id: externalOrderId,
    external_url: doc.urlPublicView || null,
    erp: 'BSALE',
    status: doc.state === 0 ? 'issued' : 'voided',
    resync_batch: batchId,
    raw_data: {
      id: doc.id,
      number: doc.number,
      emissionDate: doc.emissionDate,
      codeSii,
      typeName: doc.document_type?.name,
      clientNote: doc.client?.note,
      references: doc.references,
      coin: doc.coin || null,
      office: doc.office,
      external_order_id: externalOrderId,
      details: (doc.details?.items || []).map((d) => ({
        description: d.comment,
        quantity: d.quantity,
        netAmount: d.netAmount,
      })),
    },
  };
}

async function collectMeli(files) {
  const byId = new Map();
  const paymentIds = new Set();
  const duplicatePaymentIds = new Set();
  let input = 0;
  let embeddedPayments = 0;

  for (const file of files) {
    const dump = await readJson(file);
    for (const order of dump.orders || []) {
      input++;
      for (const payment of Array.isArray(order.payments) ? order.payments : []) {
        embeddedPayments++;
        if (payment?.id != null) {
          const id = String(payment.id);
          if (paymentIds.has(id)) duplicatePaymentIds.add(id);
          paymentIds.add(id);
        }
      }
      byId.set(String(order.id), order);
    }
  }

  return { input, unique: [...byId.values()], embeddedPayments, duplicatePaymentIds };
}

async function collectBsale(files) {
  const byId = new Map();
  let input = 0;
  const duplicateIds = new Set();
  for (const file of files) {
    const dump = await readJson(file);
    for (const doc of dump.documents || []) {
      input++;
      const id = String(doc.id);
      if (byId.has(id)) duplicateIds.add(id);
      // Last file wins. Stable external_id + upsert makes repeated runs idempotent.
      byId.set(id, doc);
    }
  }
  return { input, unique: [...byId.values()], duplicateIds };
}

async function upsertChunks(supabase, table, rows, onConflict, chunkSize = 250) {
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, {
      onConflict,
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`${table} chunk ${i / chunkSize + 1}: ${error.message}`);
    written += chunk.length;
    console.log(`  ${table}: ${written}/${rows.length}`);
  }
}

async function getExactOrderIds(supabase, orderIds, chunkSize = 250) {
  const exact = new Set();
  for (let i = 0; i < orderIds.length; i += chunkSize) {
    const ids = orderIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('orders')
      .select('order_id')
      .eq('channel', 'meli')
      .eq('channel_account_id', meliAccountId)
      .eq('has_exact_data', true)
      .in('order_id', ids);
    if (error) throw new Error(`checking exact MELI orders: ${error.message}`);
    for (const row of data || []) exact.add(String(row.order_id));
  }
  return exact;
}

const meli = await collectMeli(meliFiles);
const bsale = await collectBsale(bsaleFiles);
const validBsale = bsale.unique.filter((d) => VALID_SII.has(Number(d.document_type?.codeSii)));

console.log('=== Quadra backup import ===');
console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`MELI input orders: ${meli.input}`);
console.log(`MELI unique orders: ${meli.unique.length}`);
console.log(`MELI duplicate orders removed: ${meli.input - meli.unique.length}`);
console.log(`MELI embedded payment records retained in raw_data: ${meli.embeddedPayments}`);
console.log(`MELI duplicate embedded payment IDs observed: ${meli.duplicatePaymentIds.size}`);
console.log(`Bsale input documents: ${bsale.input}`);
console.log(`Bsale unique document IDs: ${bsale.unique.length}`);
console.log(`Bsale duplicate IDs removed: ${bsale.duplicateIds.size}`);
console.log(`Bsale valid tributary docs: ${validBsale.length}`);

if (!apply) {
  console.log('\nDry run only. Re-run with --apply after reviewing these counts.');
  process.exit(0);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --apply');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const batchId = `backup-${new Date().toISOString()}`;
const exactOrderIds = await getExactOrderIds(supabase, meli.unique.map((order) => String(order.id)));
const normalOrderRows = [];
const exactPreservedRows = [];
for (const order of meli.unique) {
  const preserveExact = exactOrderIds.has(String(order.id));
  (preserveExact ? exactPreservedRows : normalOrderRows).push(transformMeliOrder(order, preserveExact));
}
const taxRows = validBsale.map((doc) => transformBsaleDoc(doc, batchId)).filter(Boolean);

console.log(`\nExisting exact MELI orders preserved: ${exactPreservedRows.length}`);
console.log('Writing MELI orders...');
await upsertChunks(supabase, 'orders', normalOrderRows, 'channel_account_id,order_id');
await upsertChunks(supabase, 'orders', exactPreservedRows, 'channel_account_id,order_id');

console.log('\nWriting Bsale tax documents...');
await upsertChunks(supabase, 'tax_documents', taxRows, 'user_id,external_system,external_id');

console.log('\nImport complete. Safe to run again: all writes are idempotent upserts.');
