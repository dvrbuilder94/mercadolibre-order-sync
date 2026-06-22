export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      amazon_accounts: {
        Row: {
          access_token: string | null
          created_at: string
          expires_at: string | null
          id: string
          marketplace_id: string
          refresh_token: string
          region: string
          seller_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          marketplace_id: string
          refresh_token: string
          region?: string
          seller_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          marketplace_id?: string
          refresh_token?: string
          region?: string
          seller_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bank_movements: {
        Row: {
          amount: number
          bank_account: string | null
          created_at: string | null
          description: string | null
          external_reference: string | null
          id: string
          movement_date: string
          raw_data: Json | null
          reconciled: boolean | null
          settlement_id: string | null
          source_channel: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          amount: number
          bank_account?: string | null
          created_at?: string | null
          description?: string | null
          external_reference?: string | null
          id?: string
          movement_date: string
          raw_data?: Json | null
          reconciled?: boolean | null
          settlement_id?: string | null
          source_channel: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          bank_account?: string | null
          created_at?: string | null
          description?: string | null
          external_reference?: string | null
          id?: string
          movement_date?: string
          raw_data?: Json | null
          reconciled?: boolean | null
          settlement_id?: string | null
          source_channel?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_movements_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_movements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bsale_accounts: {
        Row: {
          access_token: string
          access_token_encrypted: string | null
          app_client_id: string | null
          client_code: string | null
          client_name: string | null
          cpn_id: string | null
          created_at: string
          id: string
          oauth_state: string | null
          refresh_token: string | null
          status: string | null
          token_expires_at: string | null
          updated_at: string
          user_id: string
          webhook_url: string | null
        }
        Insert: {
          access_token: string
          access_token_encrypted?: string | null
          app_client_id?: string | null
          client_code?: string | null
          client_name?: string | null
          cpn_id?: string | null
          created_at?: string
          id?: string
          oauth_state?: string | null
          refresh_token?: string | null
          status?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
          webhook_url?: string | null
        }
        Update: {
          access_token?: string
          access_token_encrypted?: string | null
          app_client_id?: string | null
          client_code?: string | null
          client_name?: string | null
          cpn_id?: string | null
          created_at?: string
          id?: string
          oauth_state?: string | null
          refresh_token?: string | null
          status?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
          webhook_url?: string | null
        }
        Relationships: []
      }
      falabella_accounts: {
        Row: {
          access_token: string | null
          client_id: string
          client_secret: string
          created_at: string
          expires_at: string | null
          id: string
          redirect_uri: string
          refresh_token: string | null
          seller_id: string | null
          site_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          client_id: string
          client_secret: string
          created_at?: string
          expires_at?: string | null
          id?: string
          redirect_uri: string
          refresh_token?: string | null
          seller_id?: string | null
          site_id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          client_id?: string
          client_secret?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          redirect_uri?: string
          refresh_token?: string | null
          seller_id?: string | null
          site_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      meli_claims: {
        Row: {
          channel_account_id: string | null
          claim_id: string
          created_at: string
          date_created: string | null
          fulfilled: boolean | null
          id: string
          last_updated: string | null
          order_id: string | null
          raw_data: Json | null
          reason_id: string | null
          resource_id: string | null
          stage: string | null
          status: string | null
          type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          channel_account_id?: string | null
          claim_id: string
          created_at?: string
          date_created?: string | null
          fulfilled?: boolean | null
          id?: string
          last_updated?: string | null
          order_id?: string | null
          raw_data?: Json | null
          reason_id?: string | null
          resource_id?: string | null
          stage?: string | null
          status?: string | null
          type?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          channel_account_id?: string | null
          claim_id?: string
          created_at?: string
          date_created?: string | null
          fulfilled?: boolean | null
          id?: string
          last_updated?: string | null
          order_id?: string | null
          raw_data?: Json | null
          reason_id?: string | null
          resource_id?: string | null
          stage?: string | null
          status?: string | null
          type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meli_claims_channel_account_id_fkey"
            columns: ["channel_account_id"]
            isOneToOne: false
            referencedRelation: "meli_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meli_claims_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      meli_accounts: {
        Row: {
          access_token: string | null
          client_id: string
          client_secret: string
          created_at: string
          expires_at: string | null
          id: string
          redirect_uri: string
          refresh_token: string | null
          seller_id: string | null
          site_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          client_id: string
          client_secret: string
          created_at?: string
          expires_at?: string | null
          id?: string
          redirect_uri: string
          refresh_token?: string | null
          seller_id?: string | null
          site_id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          client_id?: string
          client_secret?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          redirect_uri?: string
          refresh_token?: string | null
          seller_id?: string | null
          site_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meli_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meli_payment_details: {
        Row: {
          created_at: string | null
          date_approved: string | null
          fee_details: Json | null
          financing_fee: number | null
          id: string
          marketplace_fee: number | null
          money_release_date: string | null
          net_received_amount: number
          order_id: string | null
          payment_id: string
          payment_method: string | null
          raw_data: Json | null
          shipping_fee: number | null
          status: string | null
          total_fees: number | null
          transaction_amount: number
        }
        Insert: {
          created_at?: string | null
          date_approved?: string | null
          fee_details?: Json | null
          financing_fee?: number | null
          id?: string
          marketplace_fee?: number | null
          money_release_date?: string | null
          net_received_amount: number
          order_id?: string | null
          payment_id: string
          payment_method?: string | null
          raw_data?: Json | null
          shipping_fee?: number | null
          status?: string | null
          total_fees?: number | null
          transaction_amount: number
        }
        Update: {
          created_at?: string | null
          date_approved?: string | null
          fee_details?: Json | null
          financing_fee?: number | null
          id?: string
          marketplace_fee?: number | null
          money_release_date?: string | null
          net_received_amount?: number
          order_id?: string | null
          payment_id?: string
          payment_method?: string | null
          raw_data?: Json | null
          shipping_fee?: number | null
          status?: string | null
          total_fees?: number | null
          transaction_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "meli_payment_details_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_closings: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string | null
          id: string
          observations: string | null
          pending_document_count: number | null
          pending_sales_count: number | null
          period: string
          status: string
          total_payments_amount: number | null
          total_payments_count: number | null
          total_sales_amount: number | null
          total_sales_count: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string | null
          id?: string
          observations?: string | null
          pending_document_count?: number | null
          pending_sales_count?: number | null
          period: string
          status?: string
          total_payments_amount?: number | null
          total_payments_count?: number | null
          total_sales_amount?: number | null
          total_sales_count?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string | null
          id?: string
          observations?: string | null
          pending_document_count?: number | null
          pending_sales_count?: number | null
          period?: string
          status?: string
          total_payments_amount?: number | null
          total_payments_count?: number | null
          total_sales_amount?: number | null
          total_sales_count?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      order_tax_documents: {
        Row: {
          allocated_amount: number | null
          created_at: string | null
          created_by: string
          id: string
          match_score: number | null
          match_source: string | null
          order_id: string
          resync_batch: string | null
          tax_document_id: string
        }
        Insert: {
          allocated_amount?: number | null
          created_at?: string | null
          created_by: string
          id?: string
          match_score?: number | null
          match_source?: string | null
          order_id: string
          resync_batch?: string | null
          tax_document_id: string
        }
        Update: {
          allocated_amount?: number | null
          created_at?: string | null
          created_by?: string
          id?: string
          match_score?: number | null
          match_source?: string | null
          order_id?: string
          resync_batch?: string | null
          tax_document_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_tax_documents_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_tax_documents_tax_document_id_fkey"
            columns: ["tax_document_id"]
            isOneToOne: false
            referencedRelation: "tax_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      order_tax_documents_reset_log: {
        Row: {
          allocated_amount: number | null
          id: string
          match_score: number | null
          match_source: string | null
          order_id: string
          original_created_at: string | null
          original_created_by: string | null
          original_id: string
          period_from: string
          period_to: string
          reset_at: string
          reset_batch_id: string
          reset_by: string
          tax_document_id: string
        }
        Insert: {
          allocated_amount?: number | null
          id?: string
          match_score?: number | null
          match_source?: string | null
          order_id: string
          original_created_at?: string | null
          original_created_by?: string | null
          original_id: string
          period_from: string
          period_to: string
          reset_at?: string
          reset_batch_id: string
          reset_by: string
          tax_document_id: string
        }
        Update: {
          allocated_amount?: number | null
          id?: string
          match_score?: number | null
          match_source?: string | null
          order_id?: string
          original_created_at?: string | null
          original_created_by?: string | null
          original_id?: string
          period_from?: string
          period_to?: string
          reset_at?: string
          reset_batch_id?: string
          reset_by?: string
          tax_document_id?: string
        }
        Relationships: []
      }
      order_tax_match_candidates: {
        Row: {
          breakdown: Json
          created_at: string | null
          id: string
          match_score: number
          order_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
          tax_document_id: string
        }
        Insert: {
          breakdown?: Json
          created_at?: string | null
          id?: string
          match_score: number
          order_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          tax_document_id: string
        }
        Update: {
          breakdown?: Json
          created_at?: string | null
          id?: string
          match_score?: number
          order_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
          tax_document_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_tax_match_candidates_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_tax_match_candidates_tax_document_id_fkey"
            columns: ["tax_document_id"]
            isOneToOne: false
            referencedRelation: "tax_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          accounting_category: string | null
          accounting_period: string | null
          amount: number
          bank_reference: string | null
          channel: Database["public"]["Enums"]["channel_type"] | null
          channel_account_id: string | null
          commission_amount: number | null
          commission_percentage: number | null
          cost_of_goods_sold: number | null
          created_at: string
          currency_id: string | null
          customer_email: string | null
          customer_name: string
          customer_tax_id: string | null
          customer_tax_id_dv: string | null
          date_delivered: string | null
          date_shipped: string | null
          discount_amount: number | null
          expected_payment_date: string | null
          external_sale_id: string | null
          financing_fee: number | null
          gross_amount: number | null
          gross_profit: number | null
          has_exact_data: boolean | null
          id: string
          installment_amount: number | null
          installments: number | null
          invoice_date: string | null
          invoice_number: string | null
          items: number
          marketplace: string | null
          meli_account_id: string | null
          money_release_date: string | null
          net_amount: number | null
          net_taxable_amount: number | null
          notes_for_accountant: string | null
          order_date: string
          order_id: string
          payment_approved_at: string | null
          payment_method: string | null
          payment_method_brand: string | null
          payment_method_type: string | null
          product_title: string | null
          raw_data: Json | null
          reconciliation_status: Database["public"]["Enums"]["reconciliation_status"]
          sale_status: string | null
          seller_sku: string | null
          settlement_amount: number | null
          settlement_date: string | null
          settlement_id: string | null
          shipping_cost: number | null
          shipping_id: string | null
          shipping_mode: string | null
          status: string
          tax_amount: number | null
          updated_at: string
          vat_amount: number | null
          vat_rate: number | null
        }
        Insert: {
          accounting_category?: string | null
          accounting_period?: string | null
          amount: number
          bank_reference?: string | null
          channel?: Database["public"]["Enums"]["channel_type"] | null
          channel_account_id?: string | null
          commission_amount?: number | null
          commission_percentage?: number | null
          cost_of_goods_sold?: number | null
          created_at?: string
          currency_id?: string | null
          customer_email?: string | null
          customer_name: string
          customer_tax_id?: string | null
          customer_tax_id_dv?: string | null
          date_delivered?: string | null
          date_shipped?: string | null
          discount_amount?: number | null
          expected_payment_date?: string | null
          external_sale_id?: string | null
          financing_fee?: number | null
          gross_amount?: number | null
          gross_profit?: number | null
          has_exact_data?: boolean | null
          id?: string
          installment_amount?: number | null
          installments?: number | null
          invoice_date?: string | null
          invoice_number?: string | null
          items?: number
          marketplace?: string | null
          meli_account_id?: string | null
          money_release_date?: string | null
          net_amount?: number | null
          net_taxable_amount?: number | null
          notes_for_accountant?: string | null
          order_date: string
          order_id: string
          payment_approved_at?: string | null
          payment_method?: string | null
          payment_method_brand?: string | null
          payment_method_type?: string | null
          product_title?: string | null
          raw_data?: Json | null
          reconciliation_status?: Database["public"]["Enums"]["reconciliation_status"]
          sale_status?: string | null
          seller_sku?: string | null
          settlement_amount?: number | null
          settlement_date?: string | null
          settlement_id?: string | null
          shipping_cost?: number | null
          shipping_id?: string | null
          shipping_mode?: string | null
          status: string
          tax_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
          vat_rate?: number | null
        }
        Update: {
          accounting_category?: string | null
          accounting_period?: string | null
          amount?: number
          bank_reference?: string | null
          channel?: Database["public"]["Enums"]["channel_type"] | null
          channel_account_id?: string | null
          commission_amount?: number | null
          commission_percentage?: number | null
          cost_of_goods_sold?: number | null
          created_at?: string
          currency_id?: string | null
          customer_email?: string | null
          customer_name?: string
          customer_tax_id?: string | null
          customer_tax_id_dv?: string | null
          date_delivered?: string | null
          date_shipped?: string | null
          discount_amount?: number | null
          expected_payment_date?: string | null
          external_sale_id?: string | null
          financing_fee?: number | null
          gross_amount?: number | null
          gross_profit?: number | null
          has_exact_data?: boolean | null
          id?: string
          installment_amount?: number | null
          installments?: number | null
          invoice_date?: string | null
          invoice_number?: string | null
          items?: number
          marketplace?: string | null
          meli_account_id?: string | null
          money_release_date?: string | null
          net_amount?: number | null
          net_taxable_amount?: number | null
          notes_for_accountant?: string | null
          order_date?: string
          order_id?: string
          payment_approved_at?: string | null
          payment_method?: string | null
          payment_method_brand?: string | null
          payment_method_type?: string | null
          product_title?: string | null
          raw_data?: Json | null
          reconciliation_status?: Database["public"]["Enums"]["reconciliation_status"]
          sale_status?: string | null
          seller_sku?: string | null
          settlement_amount?: number | null
          settlement_date?: string | null
          settlement_id?: string | null
          shipping_cost?: number | null
          shipping_id?: string | null
          shipping_mode?: string | null
          status?: string
          tax_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
          vat_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_meli_account_id_fkey"
            columns: ["meli_account_id"]
            isOneToOne: false
            referencedRelation: "meli_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_sales: {
        Row: {
          allocated_amount: number
          created_at: string | null
          id: string
          payment_id: string
          sale_id: string
        }
        Insert: {
          allocated_amount?: number
          created_at?: string | null
          id?: string
          payment_id: string
          sale_id: string
        }
        Update: {
          allocated_amount?: number
          created_at?: string | null
          id?: string
          payment_id?: string
          sale_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_sales_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_sales_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          bank: string | null
          created_at: string
          external_payment_id: string | null
          fees_amount: number | null
          gross_amount: number | null
          id: string
          net_amount: number | null
          payment_date: string
          payment_provider: string | null
          raw_data: Json | null
          reference: string | null
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          bank?: string | null
          created_at?: string
          external_payment_id?: string | null
          fees_amount?: number | null
          gross_amount?: number | null
          id?: string
          net_amount?: number | null
          payment_date: string
          payment_provider?: string | null
          raw_data?: Json | null
          reference?: string | null
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          bank?: string | null
          created_at?: string
          external_payment_id?: string | null
          fees_amount?: number | null
          gross_amount?: number | null
          id?: string
          net_amount?: number | null
          payment_date?: string
          payment_provider?: string | null
          raw_data?: Json | null
          reference?: string | null
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          company_address: string | null
          company_name: string | null
          company_phone: string | null
          company_tax_id: string | null
          company_website: string | null
          created_at: string
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          company_address?: string | null
          company_name?: string | null
          company_phone?: string | null
          company_tax_id?: string | null
          company_website?: string | null
          created_at?: string
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          company_address?: string | null
          company_name?: string | null
          company_phone?: string | null
          company_tax_id?: string | null
          company_website?: string | null
          created_at?: string
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      raw_extraction_jobs: {
        Row: {
          checkpoint: Json | null
          chunks_count: number
          created_at: string
          current_step: string | null
          error_message: string | null
          file_path: string | null
          file_size_bytes: number | null
          id: string
          period: string
          progress: number
          source: string
          status: string
          total: number
          updated_at: string
          user_id: string
        }
        Insert: {
          checkpoint?: Json | null
          chunks_count?: number
          created_at?: string
          current_step?: string | null
          error_message?: string | null
          file_path?: string | null
          file_size_bytes?: number | null
          id?: string
          period: string
          progress?: number
          source: string
          status?: string
          total?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          checkpoint?: Json | null
          chunks_count?: number
          created_at?: string
          current_step?: string | null
          error_message?: string | null
          file_path?: string | null
          file_size_bytes?: number | null
          id?: string
          period?: string
          progress?: number
          source?: string
          status?: string
          total?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reconciliations: {
        Row: {
          confidence_score: number | null
          created_at: string
          created_by: string
          id: string
          matching_method: string | null
          notes: string | null
          order_id: string
          payment_id: string
          reconciliation_date: string
          reconciliation_type: string
          status: string | null
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          created_by: string
          id?: string
          matching_method?: string | null
          notes?: string | null
          order_id: string
          payment_id: string
          reconciliation_date?: string
          reconciliation_type: string
          status?: string | null
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          created_by?: string
          id?: string
          matching_method?: string | null
          notes?: string | null
          order_id?: string
          payment_id?: string
          reconciliation_date?: string
          reconciliation_type?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliations_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_items: {
        Row: {
          channel: Database["public"]["Enums"]["channel_type"]
          created_at: string | null
          fees_amount: number
          gross_amount: number
          id: string
          item_type: Database["public"]["Enums"]["settlement_item_type"]
          meli_order_id: string | null
          net_amount: number
          order_id: string | null
          payment_id: string | null
          raw_data: Json | null
          recon_status: string | null
          released_at: string | null
          settlement_id: string | null
          shipping_cost: number
          taxes_withheld: number
          updated_at: string | null
        }
        Insert: {
          channel: Database["public"]["Enums"]["channel_type"]
          created_at?: string | null
          fees_amount?: number
          gross_amount?: number
          id?: string
          item_type?: Database["public"]["Enums"]["settlement_item_type"]
          meli_order_id?: string | null
          net_amount?: number
          order_id?: string | null
          payment_id?: string | null
          raw_data?: Json | null
          recon_status?: string | null
          released_at?: string | null
          settlement_id?: string | null
          shipping_cost?: number
          taxes_withheld?: number
          updated_at?: string | null
        }
        Update: {
          channel?: Database["public"]["Enums"]["channel_type"]
          created_at?: string | null
          fees_amount?: number
          gross_amount?: number
          id?: string
          item_type?: Database["public"]["Enums"]["settlement_item_type"]
          meli_order_id?: string | null
          net_amount?: number
          order_id?: string | null
          payment_id?: string | null
          raw_data?: Json | null
          recon_status?: string | null
          released_at?: string | null
          settlement_id?: string | null
          shipping_cost?: number
          taxes_withheld?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "settlement_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_items_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      settlements: {
        Row: {
          bank_movement_id: string | null
          channel: Database["public"]["Enums"]["channel_type"]
          channel_account_id: string
          created_at: string | null
          external_settlement_id: string | null
          fees_total: number
          gross_amount: number
          id: string
          net_amount: number
          order_count: number
          period_end: string
          period_start: string
          reconciled: boolean | null
          settlement_amount: number
          status: string | null
          tax_total: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          bank_movement_id?: string | null
          channel: Database["public"]["Enums"]["channel_type"]
          channel_account_id: string
          created_at?: string | null
          external_settlement_id?: string | null
          fees_total?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          order_count?: number
          period_end: string
          period_start: string
          reconciled?: boolean | null
          settlement_amount?: number
          status?: string | null
          tax_total?: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          bank_movement_id?: string | null
          channel?: Database["public"]["Enums"]["channel_type"]
          channel_account_id?: string
          created_at?: string | null
          external_settlement_id?: string | null
          fees_total?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          order_count?: number
          period_end?: string
          period_start?: string
          reconciled?: boolean | null
          settlement_amount?: number
          status?: string | null
          tax_total?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlements_bank_movement_id_fkey"
            columns: ["bank_movement_id"]
            isOneToOne: false
            referencedRelation: "bank_movements"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_accounts: {
        Row: {
          access_token: string
          api_key: string
          api_secret: string
          created_at: string
          id: string
          shop_domain: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          api_key: string
          api_secret: string
          created_at?: string
          id?: string
          shop_domain: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          api_key?: string
          api_secret?: string
          created_at?: string
          id?: string
          shop_domain?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tax_documents: {
        Row: {
          client_name: string | null
          client_tax_id: string | null
          client_tax_id_dv: string | null
          created_at: string | null
          detected_channel: string | null
          document_date: string
          document_number: string
          document_type: Database["public"]["Enums"]["document_type"]
          erp: string | null
          external_document_id: string | null
          external_id: string | null
          external_order_id: string | null
          external_system: string | null
          external_url: string | null
          id: string
          net_amount: number
          notes: string | null
          original_tax_document_id: string | null
          raw_data: Json | null
          resync_batch: string | null
          sales_channel: string | null
          status: Database["public"]["Enums"]["tax_document_status"] | null
          tax_amount: number
          total_amount: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          client_name?: string | null
          client_tax_id?: string | null
          client_tax_id_dv?: string | null
          created_at?: string | null
          detected_channel?: string | null
          document_date: string
          document_number: string
          document_type: Database["public"]["Enums"]["document_type"]
          erp?: string | null
          external_document_id?: string | null
          external_id?: string | null
          external_order_id?: string | null
          external_system?: string | null
          external_url?: string | null
          id?: string
          net_amount: number
          notes?: string | null
          original_tax_document_id?: string | null
          raw_data?: Json | null
          resync_batch?: string | null
          sales_channel?: string | null
          status?: Database["public"]["Enums"]["tax_document_status"] | null
          tax_amount?: number
          total_amount: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          client_name?: string | null
          client_tax_id?: string | null
          client_tax_id_dv?: string | null
          created_at?: string | null
          detected_channel?: string | null
          document_date?: string
          document_number?: string
          document_type?: Database["public"]["Enums"]["document_type"]
          erp?: string | null
          external_document_id?: string | null
          external_id?: string | null
          external_order_id?: string | null
          external_system?: string | null
          external_url?: string | null
          id?: string
          net_amount?: number
          notes?: string | null
          original_tax_document_id?: string | null
          raw_data?: Json | null
          resync_batch?: string | null
          sales_channel?: string | null
          status?: Database["public"]["Enums"]["tax_document_status"] | null
          tax_amount?: number
          total_amount?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_documents_original_tax_document_id_fkey"
            columns: ["original_tax_document_id"]
            isOneToOne: false
            referencedRelation: "tax_documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_ledger: {
        Row: {
          channel_account_id: string | null
          currency: string | null
          customer_name: string | null
          estado_contable: string | null
          fee_amount: number | null
          gross_amount: number | null
          incluye_en_cierre: boolean | null
          is_closable: boolean | null
          is_documented: boolean | null
          is_paid: boolean | null
          is_retained: boolean | null
          ledger_date: string | null
          money_release_date: string | null
          net_amount: number | null
          payment_id: string | null
          period: string | null
          product_title: string | null
          reference_id: string | null
          sale_id: string | null
          sales_count: number | null
          source: string | null
          tax_document_id: string | null
          type: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      calculate_accounting_period: {
        Args: { order_date: string }
        Returns: string
      }
      calculate_gross_profit: {
        Args: { cogs: number; net_amount: number }
        Returns: number
      }
      calculate_meli_commission: {
        Args: { amount: number; payment_method: string }
        Returns: {
          commission_amount: number
          commission_percentage: number
          net_amount: number
        }[]
      }
      calculate_vat_breakdown: {
        Args: { total_amount: number; vat_rate?: number }
        Returns: {
          net_amount: number
          vat_amount: number
        }[]
      }
      get_pending_sales: {
        Args: {
          p_date_from?: string
          p_date_to?: string
          p_limit?: number
          p_marketplace?: string
          p_min_amount?: number
          p_offset?: number
          p_period?: string
        }
        Returns: {
          customer_name: string
          external_sale_id: string
          gross_amount: number
          id: string
          installments: number
          marketplace: string
          money_release_date: string
          order_date: string
          payment_method: string
          payment_method_brand: string
          payment_method_type: string
          product_title: string
          shipping_mode: string
          total_count: number
        }[]
      }
      get_pending_sales_stats: {
        Args: {
          p_date_from?: string
          p_date_to?: string
          p_marketplace?: string
          p_min_amount?: number
          p_period?: string
        }
        Returns: {
          avg_days_retention: number
          total_amount: number
          total_count: number
        }[]
      }
      user_owns_order: { Args: { _order_id: string }; Returns: boolean }
    }
    Enums: {
      channel_type: "meli" | "falabella" | "amazon" | "shopify"
      document_type:
        | "boleta"
        | "factura"
        | "nota_credito"
        | "nota_debito"
        | "factura_exenta"
      reconciliation_status:
        | "pending"
        | "reconciled"
        | "partially_reconciled"
        | "refund_pending_nc"
      settlement_item_type:
        | "SALE"
        | "REFUND"
        | "FEE"
        | "SHIPPING"
        | "ADJUSTMENT"
        | "CHARGEBACK"
      tax_document_status: "issued" | "voided" | "pending"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      channel_type: ["meli", "falabella", "amazon", "shopify"],
      document_type: [
        "boleta",
        "factura",
        "nota_credito",
        "nota_debito",
        "factura_exenta",
      ],
      reconciliation_status: [
        "pending",
        "reconciled",
        "partially_reconciled",
        "refund_pending_nc",
      ],
      settlement_item_type: [
        "SALE",
        "REFUND",
        "FEE",
        "SHIPPING",
        "ADJUSTMENT",
        "CHARGEBACK",
      ],
      tax_document_status: ["issued", "voided", "pending"],
    },
  },
} as const
