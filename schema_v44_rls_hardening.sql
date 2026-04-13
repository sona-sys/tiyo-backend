-- ============================================================
-- V44 Security Hardening — lock down public tables in Supabase
-- Safe to rerun.
-- ============================================================

-- These tables are only used through the backend server. They should not be
-- readable or writable through Supabase's public PostgREST API.

ALTER TABLE IF EXISTS public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.creator_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.creator_payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.creator_payout_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notifications FROM anon, authenticated;
REVOKE ALL ON TABLE public.blocks FROM anon, authenticated;
REVOKE ALL ON TABLE public.creator_payouts FROM anon, authenticated;
REVOKE ALL ON TABLE public.creator_payout_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.creator_payout_items FROM anon, authenticated;
