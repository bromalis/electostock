-- Fixes from a security review.
--
--   1. Whether someone has chosen a password is kept in profiles, where only the
--      database can set it. It used to be read from auth user_metadata, which
--      users can write themselves (see mark_password_set).
--   2. Numbers must be finite: Postgres counts NaN as larger than every number, so
--      checks like qty >= 0 let NaN and Infinity through.
--   3. Races: removing the last admins at the same moment, and BOM lines written
--      at the same moment (which could save a loop), are serialized.
--   4. profiles.email follows email changes in auth.users.
--   5. Security definer functions look up names in public (and auth) before
--      pg_temp, so a temporary table can't stand in for a real one.
--   6. move_stock: adjust_stock that also says what changed, so the page can undo
--      exactly the change that was made.
--   7. The sheet export includes the stock-move log.

-- ─── 1. Password chosen ──────────────────────────────────────────────────────

alter table public.profiles add column password_set boolean not null default false;

-- Accounts that already exist were all created through invites, so their
-- metadata can be trusted this once.
update public.profiles p set password_set = true
from auth.users u
where u.id = p.user_id and coalesce(u.raw_user_meta_data ->> 'password_set', '') = 'true';

-- Called by the page after the signed-in user sets a password or signs in with one.
create function public.mark_password_set() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.profiles set password_set = true where user_id = auth.uid()
$$;

-- ─── 2. Finite numbers only ──────────────────────────────────────────────────
-- x < 'Infinity' is false for NaN and Infinity; x > '-Infinity' also rules out -Infinity.

alter table public.items add constraint items_numbers_finite check (
  qty < 'Infinity' and min > '-Infinity' and min < 'Infinity'
  and unit_cost > '-Infinity' and unit_cost < 'Infinity');
alter table public.bom_lines add constraint bom_lines_quantity_finite check (
  quantity > '-Infinity' and quantity < 'Infinity');
alter table public.checkout_log add constraint checkout_log_numbers_finite check (
  qty_built < 'Infinity' and qty_deducted > '-Infinity' and qty_deducted < 'Infinity');
alter table public.stock_moves add constraint stock_moves_numbers_finite check (
  qty_requested < 'Infinity' and qty_change > '-Infinity' and qty_change < 'Infinity' and qty_after < 'Infinity');

-- ─── 3. Races ────────────────────────────────────────────────────────────────

-- Two admins demoting (or deleting) each other at once could each still count two
-- admins. Taking one lock first makes the second wait and count again.
create or replace function public.keep_one_admin() returns trigger
language plpgsql as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    perform pg_advisory_xact_lock(hashtext('public.keep_one_admin'));
    if (select count(*) from public.profiles where role = 'admin') <= 1 then
      raise exception 'There must be at least one admin' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- Writes to bom_lines run one transaction at a time, so the cycle check always sees
-- lines another transaction just committed, and two save_bom calls for the same
-- assembly can't interleave.
create function public.bom_lines_lock() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('public.bom_lines'));
  return null;
end $$;

create trigger bom_lines_lock
  before insert or update or delete on public.bom_lines
  for each statement execute function public.bom_lines_lock();

-- ─── 4. Email changes ────────────────────────────────────────────────────────

create function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.profiles set email = lower(new.email) where user_id = new.id;
  return new;
end $$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (new.email is distinct from old.email and new.email is not null)
  execute function public.handle_user_email_change();

-- ─── 5. search_path ──────────────────────────────────────────────────────────

alter function public.my_role()                                set search_path = public, pg_temp;
alter function public.handle_new_user()                        set search_path = public, pg_temp;
alter function public.checkout(bigint, numeric, text)          set search_path = public, pg_temp;
alter function public.admin_list_users()                       set search_path = public, pg_temp;
alter function public.admin_invite(text, text)                 set search_path = public, pg_temp;
alter function public.admin_cancel_invite(text)                set search_path = public, pg_temp;
alter function public.admin_set_role(uuid, text)               set search_path = public, pg_temp;
alter function public.admin_delete_user(uuid)                  set search_path = public, auth, pg_temp;
alter function public.create_export_token(text)                set search_path = public, pg_temp;

-- ─── 6. move_stock ───────────────────────────────────────────────────────────
-- Like adjust_stock, but returns {qty_before, qty_after, qty_change} as the
-- database saw them, so the page reports and undoes the real change even when its
-- own copy of the stock level was out of date.

create function public.move_stock(p_id bigint, p_action text, p_qty numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  before_qty numeric;
  it items;
  who text;
begin
  if not public.has_role('user') then
    raise exception 'Your role is not allowed to do that' using errcode = '42501';
  end if;
  if p_action not in ('add', 'remove', 'set') then
    raise exception 'Unknown adjustment: %', p_action using errcode = 'P0001';
  end if;
  if p_qty is null or p_qty < 0 or p_qty >= 'Infinity' then
    raise exception 'Quantity must be a number, 0 or more' using errcode = 'P0001';
  end if;
  select qty into before_qty from items where id = p_id for update;
  if not found then
    raise exception 'Item not found: %', p_id using errcode = 'P0002';
  end if;
  update items set qty = case p_action
      when 'add'    then qty + p_qty
      when 'remove' then greatest(0, qty - p_qty)
      else p_qty end
  where id = p_id
  returning * into it;
  select email into who from profiles where user_id = auth.uid();
  insert into stock_moves (item_id, item_name, supplier_part, location, action, qty_requested,
                           qty_change, qty_after, note, user_email)
  values (it.id, it.name, it.supplier_part, it.location, p_action, p_qty,
          it.qty - before_qty, it.qty, coalesce(btrim(p_note), ''), coalesce(who, ''));
  return jsonb_build_object('qty_before', before_qty, 'qty_after', it.qty, 'qty_change', it.qty - before_qty);
end $$;

-- The page that is live while this migration runs still calls adjust_stock.
create or replace function public.adjust_stock(p_id bigint, p_action text, p_qty numeric, p_note text)
returns numeric language sql security definer set search_path = public, pg_temp as $$
  select (public.move_stock(p_id, p_action, p_qty, p_note) ->> 'qty_after')::numeric
$$;

-- ─── 7. Export ───────────────────────────────────────────────────────────────

create or replace function public.export_snapshot(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
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
    'checkout_log', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at, l.id) from checkout_log l), '[]'::jsonb),
    'stock_moves', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) from stock_moves m), '[]'::jsonb)
  );
end $$;

-- ─── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.mark_password_set(), public.move_stock(bigint, text, numeric, text),
  public.bom_lines_lock(), public.handle_user_email_change() from public, anon;
revoke all on function public.bom_lines_lock(), public.handle_user_email_change() from authenticated;
grant execute on function public.mark_password_set(), public.move_stock(bigint, text, numeric, text) to authenticated;
