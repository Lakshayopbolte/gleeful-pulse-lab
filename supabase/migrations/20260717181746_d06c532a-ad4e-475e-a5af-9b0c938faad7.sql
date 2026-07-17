ALTER TABLE public.links ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
CREATE INDEX IF NOT EXISTS links_deleted_at_idx ON public.links (deleted_at);