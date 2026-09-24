-- Read-only copy of the inventory in the old Google Sheet.
-- An Apps Script job in that spreadsheet calls export_snapshot() every hour. It
-- has no user account: it presents a long random token, of which only a SHA-256
-- is stored here. Create a token in the SQL Editor with
--   select public.create_export_token();
-- and paste the result into the Apps Script project's Script Properties as
-- EXPORT_TOKEN. Revoke with: delete from public.export_tokens;

create table public.export_tokens (
  token_hash text primary key,
  label      text not null default '',
  created_at timestamptz not null default now()
);
alter table public.export_tokens enable row level security;  -- no policies: not reachable through the API
revoke all on public.export_tokens from anon, authenticated;

create function public.export_token_hash(p_token text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- Returns a new token once; only its hash is kept.
create function public.create_export_token(p_label text default 'Google Sheet copy') returns text
language plpgsql security definer set search_path = public as $$
declare
  token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into export_tokens (token_hash, label) values (public.export_token_hash(token), p_label);
  return token;
end $$;

-- Everything the sheet copy shows, as one JSON document.
create function public.export_snapshot(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_token is null
     or not exists (select 1 from export_tokens where token_hash = public.export_token_hash(p_token)) then
    raise exception 'Invalid export token' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'generated_at', now(),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from items i), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from categories c), '[]'::jsonb),
    'bom_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'parent_id', b.parent_id, 'child_id', b.child_id, 'quantity', b.quantity,
               'parent_name', p.name, 'child_name', c.name)
             order by p.name, c.name)
      from bom_lines b join items p on p.id = b.parent_id join items c on c.id = b.child_id), '[]'::jsonb),
    'checkout_log', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at, l.id) from checkout_log l), '[]'::jsonb)
  );
end $$;

revoke all on function public.export_token_hash(text), public.create_export_token(text), public.export_snapshot(text)
  from public, anon, authenticated;
grant execute on function public.export_snapshot(text) to anon;
