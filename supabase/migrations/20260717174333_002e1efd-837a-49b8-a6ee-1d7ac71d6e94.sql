
CREATE TABLE public.links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  alias TEXT,
  image_url TEXT,
  destination TEXT NOT NULL,
  short_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.links TO service_role;

ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies: table is only accessed via server functions
-- using the service role after shared-password gate check.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER links_set_updated_at
BEFORE UPDATE ON public.links
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX links_sort_order_idx ON public.links (sort_order, created_at DESC);
