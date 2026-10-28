-- Optional persistence for a private, server-side PostgreSQL connection.
BEGIN;
CREATE SCHEMA IF NOT EXISTS yaygent;
CREATE TABLE IF NOT EXISTS yaygent.result_cache (
  cache_key text PRIMARY KEY, template text NOT NULL, template_hash text NOT NULL,
  code_version text NOT NULL, complete boolean NOT NULL, data jsonb NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS yaygent.page_cache (
  url_norm text PRIMARY KEY, url_final text NOT NULL, status integer NOT NULL,
  tier text NOT NULL, bytes bigint NOT NULL, markdown text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS yaygent.linkedin_companies (
  company_url text PRIMARY KEY, company_id text, name text, website text,
  website_domain text, raw jsonb, scraped_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.linkedin_profiles (
  linkedin_url text PRIMARY KEY, slug text, full_name text, first_name text,
  last_name text, headline text, location text, summary text, current_title text,
  current_company text, current_company_domain text, experience jsonb,
  education jsonb, connections integer, followers integer, raw jsonb,
  scraped_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS yaygent_profiles_domain_idx ON public.linkedin_profiles(current_company_domain);
CREATE INDEX IF NOT EXISTS yaygent_profiles_slug_idx ON public.linkedin_profiles(slug);
COMMIT;
