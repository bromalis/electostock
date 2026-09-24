-- A harmless query for the daily keep-alive job (.github/workflows/keepalive.yml).
-- Supabase pauses free projects after a week without activity; one call a day
-- prevents that. It reads and changes nothing.
create function public.ping() returns text
language sql stable as $$
  select 'ok'
$$;

revoke all on function public.ping() from public, authenticated;
grant execute on function public.ping() to anon;
