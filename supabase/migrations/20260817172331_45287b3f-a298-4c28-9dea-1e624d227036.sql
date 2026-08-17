ALTER TABLE public.links ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
CREATE INDEX IF NOT EXISTS links_cleared_at_idx ON public.links (cleared_at);