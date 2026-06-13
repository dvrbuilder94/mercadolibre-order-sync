-- Permitir que cada usuario LEA sus propios archivos del bucket raw-extractions.
-- Tanto el archivo final (`{uid}/bsale-...json`) como los chunks sueltos
-- (`{uid}/.tmp/{job_id}/...`) tienen el uid como primer segmento de carpeta.
--
-- Sin esta policy, la descarga del raw desde el frontend (que baja/ensambla los
-- chunks en el browser) falla por RLS y cae a la Edge Function, que se queda sin
-- tiempo armando archivos grandes (Bsale ~68MB) → "Failed to fetch". Con esta
-- policy, la descarga es directa desde Storage y robusta para cualquier tamaño.

drop policy if exists "raw_extractions_read_own" on storage.objects;

create policy "raw_extractions_read_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'raw-extractions'
  and (storage.foldername(name))[1] = auth.uid()::text
);
