CREATE POLICY "Users can read own raw-extractions files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'raw-extractions'
  AND (storage.foldername(name))[1] = auth.uid()::text
);