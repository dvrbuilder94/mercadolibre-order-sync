update meli_accounts
set redirect_uri = 'https://preview--mercadolibre-order-sync.lovable.app/meli-callback',
    updated_at = now()
where id = '4bf19ecf-e742-41f2-a6f0-76af5a67243c';