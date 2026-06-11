
CREATE POLICY "Users read own raw-extractions"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'raw-extractions' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users write own raw-extractions"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'raw-extractions' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users delete own raw-extractions"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'raw-extractions' AND auth.uid()::text = (storage.foldername(name))[1]);
