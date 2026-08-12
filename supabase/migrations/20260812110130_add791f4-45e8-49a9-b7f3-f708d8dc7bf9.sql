-- One-time operational reset for Quadra.
--
-- Purpose:
--   Remove historical/reconstructed transactional data so it can be rebuilt
--   from the connected source systems, while preserving every account/OAuth
--   connection and user/configuration table.
--
-- IMPORTANT: this migration deliberately DOES NOT touch:
--   auth.users, profiles, user_roles,
--   meli_accounts, mercadopago_accounts, mercadopago_oauth_states,
--   bsale_accounts, shopify_accounts, falabella_accounts, amazon_accounts,
--   feedback, application settings/configuration, or repair/audit logs.
--
-- Before deleting anything, it snapshots the operational tables into a
-- dedicated backup schema. This makes the reset reversible from SQL if a
-- source system cannot reconstruct an old record.

create schema if not exists quadra_reset_backup_20260812;

-- Snapshot exactly what existed immediately before the reset.
-- The migration is one-shot, so plain CREATE TABLE is intentional: if these
-- names already exist, deployment stops rather than silently overwriting the
-- backup.
create table quadra_reset_backup_20260812.orders as table public.orders;
create table quadra_reset_backup_20260812.payments as table public.payments;
create table quadra_reset_backup_20260812.payment_sales as table public.payment_sales;
create table quadra_reset_backup_20260812.meli_payment_details as table public.meli_payment_details;
create table quadra_reset_backup_20260812.tax_documents as table public.tax_documents;
create table quadra_reset_backup_20260812.order_tax_documents as table public.order_tax_documents;
create table quadra_reset_backup_20260812.order_tax_match_candidates as table public.order_tax_match_candidates;
create table quadra_reset_backup_20260812.settlements as table public.settlements;
create table quadra_reset_backup_20260812.settlement_items as table public.settlement_items;
create table quadra_reset_backup_20260812.bank_movements as table public.bank_movements;
create table quadra_reset_backup_20260812.reconciliations as table public.reconciliations;
create table quadra_reset_backup_20260812.meli_claims as table public.meli_claims;
create table quadra_reset_backup_20260812.monthly_closings as table public.monthly_closings;
create table quadra_reset_backup_20260812.pipeline_sync_runs as table public.pipeline_sync_runs;
create table quadra_reset_backup_20260812.bsale_sync_checkpoints as table public.bsale_sync_checkpoints;

comment on schema quadra_reset_backup_20260812 is
  'One-time pre-reset snapshot of Quadra operational data. Connections/OAuth were never deleted.';

-- Delete only reconstructible/operational state. All FK-connected tables are
-- listed explicitly. We intentionally do NOT use CASCADE: if a new/unknown
-- dependent table exists, the migration must fail safely instead of deleting
-- data outside this reviewed list.
truncate table
  public.payment_sales,
  public.reconciliations,
  public.meli_payment_details,
  public.meli_claims,
  public.order_tax_documents,
  public.order_tax_match_candidates,
  public.settlement_items,
  public.bank_movements,
  public.payments,
  public.tax_documents,
  public.orders,
  public.settlements,
  public.monthly_closings,
  public.pipeline_sync_runs,
  public.bsale_sync_checkpoints
restart identity;

-- Safety assertions: connection tables must still exist after the reset.
do $$
begin
  if to_regclass('public.meli_accounts') is null
     or to_regclass('public.mercadopago_accounts') is null
     or to_regclass('public.bsale_accounts') is null
     or to_regclass('public.shopify_accounts') is null
     or to_regclass('public.falabella_accounts') is null
     or to_regclass('public.amazon_accounts') is null then
    raise exception 'Operational reset aborted: an expected connection table is missing';
  end if;
end $$;