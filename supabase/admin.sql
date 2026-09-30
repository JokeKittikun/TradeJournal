-- ============================================================
-- Trade Journal — ผู้ใช้ / บทบาท / อนุมัติ / แชร์พอร์ต
-- วิธีใช้: รันหลัง schema.sql → Supabase → SQL Editor → New query → วางทั้งไฟล์ → Run (รันซ้ำได้)
-- บทบาท: super_admin (คนเดียว) · admin · user   สถานะ: pending (รออนุมัติ) · active · disabled
-- ============================================================

-- ⚠️ อีเมลของ Super Admin (ต้องตรงกับอีเมลที่ใช้สมัครในเว็บ)
create or replace function public.super_admin_email() returns text language sql immutable as $$
  select 'jokerlive.channel@gmail.com'::text
$$;

-- ---------- โปรไฟล์ผู้ใช้ ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'user'    check (role in ('super_admin','admin','user')),
  status       text not null default 'pending' check (status in ('pending','active','disabled')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  approved_at  timestamptz,
  approved_by  uuid references auth.users(id) on delete set null
);
create unique index if not exists profiles_email_uq on public.profiles (lower(email));

-- สมัครใหม่ → สร้างโปรไฟล์ (รออนุมัติ) · อีเมล Super Admin → เปิดใช้งานทันที
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role, status, approved_at)
  values (new.id, coalesce(new.email,''),
          case when lower(new.email) = lower(public.super_admin_email()) then 'super_admin' else 'user' end,
          case when lower(new.email) = lower(public.super_admin_email()) then 'active' else 'pending' end,
          case when lower(new.email) = lower(public.super_admin_email()) then now() end)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ผู้ใช้ที่สมัครไว้แล้ว → สร้างโปรไฟล์ (รออนุมัติทั้งหมด ยกเว้น Super Admin)
insert into public.profiles (id, email) select id, coalesce(email,'') from auth.users on conflict (id) do nothing;
update public.profiles set role = 'super_admin', status = 'active', approved_at = coalesce(approved_at, now())
 where lower(email) = lower(public.super_admin_email());

-- ---------- ตัวช่วยเช็กสิทธิ์ (security definer: อ่านได้โดยไม่ติด RLS ไม่วนซ้ำ) ----------
create or replace function public.my_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'active'
$$;
create or replace function public.is_active() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active')
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','super_admin'), false)
$$;
create or replace function public.is_super() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'super_admin', false)
$$;

-- ---------- แชร์พอร์ต ----------
create table if not exists public.portfolio_shares (
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,     -- ผู้ได้รับสิทธิ์
  permission   text not null default 'view' check (permission in ('view','edit')),
  granted_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (portfolio_id, user_id)
);
create index if not exists portfolio_shares_user_idx on public.portfolio_shares (user_id);

-- สิทธิ์ของผู้ใช้ปัจจุบันต่อพอร์ต: 'owner' · 'edit' · 'view' · null (ไม่มีสิทธิ์)
-- Super Admin ดูพอร์ตของทุกคนได้ (อ่านอย่างเดียว) · บัญชีที่ยังไม่อนุมัติ/ถูกระงับ ไม่มีสิทธิ์ใด ๆ
create or replace function public.port_access(pid uuid) returns text language sql stable security definer set search_path = public as $$
  select case
    when not public.is_active() then null
    when exists (select 1 from public.portfolios p where p.id = pid and p.user_id = auth.uid()) then 'owner'
    else coalesce((select s.permission from public.portfolio_shares s where s.portfolio_id = pid and s.user_id = auth.uid()),
                  case when public.is_super() then 'view' end)
  end
$$;

-- ---------- Row Level Security (แทนนโยบายเดิมใน schema.sql) ----------
alter table public.profiles         enable row level security;
alter table public.portfolio_shares enable row level security;

drop policy if exists "own portfolios" on public.portfolios;
drop policy if exists "portfolios read"   on public.portfolios;
drop policy if exists "portfolios insert" on public.portfolios;
drop policy if exists "portfolios update" on public.portfolios;
drop policy if exists "portfolios delete" on public.portfolios;
-- เจ้าของ: เช็กคอลัมน์ user_id ตรง ๆ (ต้องมี เพราะตอน insert … returning ฟังก์ชัน port_access ยังมองไม่เห็นแถวที่เพิ่งเพิ่ม)
create policy "portfolios read"   on public.portfolios for select to authenticated
  using ((user_id = auth.uid() and public.is_active()) or public.port_access(id) is not null);
create policy "portfolios insert" on public.portfolios for insert to authenticated with check (user_id = auth.uid() and public.is_active());
create policy "portfolios update" on public.portfolios for update to authenticated using (public.port_access(id) = 'owner') with check (user_id = auth.uid());
create policy "portfolios delete" on public.portfolios for delete to authenticated using (public.port_access(id) = 'owner');

drop policy if exists "own trades" on public.trades;
drop policy if exists "trades read"  on public.trades;
drop policy if exists "trades write" on public.trades;
create policy "trades read"  on public.trades for select to authenticated using (public.port_access(portfolio_id) is not null);
create policy "trades write" on public.trades for all to authenticated
  using (public.port_access(portfolio_id) in ('owner','edit'))
  with check (public.port_access(portfolio_id) in ('owner','edit'));

drop policy if exists "own drawings" on public.drawings;
drop policy if exists "drawings read"  on public.drawings;
drop policy if exists "drawings write" on public.drawings;
create policy "drawings read"  on public.drawings for select to authenticated using (public.port_access(portfolio_id) is not null);
create policy "drawings write" on public.drawings for all to authenticated
  using (public.port_access(portfolio_id) in ('owner','edit'))
  with check (public.port_access(portfolio_id) in ('owner','edit'));

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
-- ไม่มีนโยบาย insert/update/delete: แก้โปรไฟล์ได้ผ่านฟังก์ชันด้านล่างเท่านั้น

drop policy if exists "shares read" on public.portfolio_shares;
create policy "shares read" on public.portfolio_shares for select to authenticated
  using (user_id = auth.uid() or public.port_access(portfolio_id) = 'owner' or public.is_super());
-- เพิ่ม/ลบการแชร์ผ่านฟังก์ชันด้านล่างเท่านั้น

revoke all on public.profiles, public.portfolio_shares from anon;
grant select on public.profiles, public.portfolio_shares to authenticated;

-- ---------- ฟังก์ชันที่หน้าเว็บเรียก ----------
-- โปรไฟล์ของฉัน (+ บันทึกเวลาใช้งานล่าสุด) · ใช้ได้แม้ยังรออนุมัติ
create or replace function public.touch_me() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  update public.profiles set last_seen_at = now() where id = auth.uid() returning * into p;
  return p;
end $$;

-- รายชื่อผู้ใช้ทั้งหมด (Admin ขึ้นไป) · จำนวนพอร์ต/ไม้ ไม่รวมรายละเอียดการเทรด
create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, role text, status text, created_at timestamptz,
               last_seen_at timestamptz, approved_at timestamptz, ports bigint, trades bigint, last_trade date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ไม่มีสิทธิ์จัดการผู้ใช้'; end if;
  return query
    select p.id, p.email, p.display_name, p.role, p.status, p.created_at, p.last_seen_at, p.approved_at,
           (select count(*) from public.portfolios f where f.user_id = p.id),
           (select count(*) from public.trades t join public.portfolios f on f.id = t.portfolio_id where f.user_id = p.id),
           (select max(t.date) from public.trades t join public.portfolios f on f.id = t.portfolio_id where f.user_id = p.id)
      from public.profiles p
     order by (p.status = 'pending') desc, p.created_at desc;
end $$;

-- อนุมัติ / ระงับ / เปิดใช้งาน (Admin ขึ้นไป · Admin จัดการได้เฉพาะผู้ใช้ทั่วไป · แตะ Super Admin ไม่ได้)
create or replace function public.admin_set_status(target uuid, new_status text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.profiles;
begin
  if not public.is_admin() then raise exception 'ไม่มีสิทธิ์จัดการผู้ใช้'; end if;
  if new_status not in ('pending','active','disabled') then raise exception 'สถานะไม่ถูกต้อง'; end if;
  if target = auth.uid() then raise exception 'เปลี่ยนสถานะของตัวเองไม่ได้'; end if;
  select * into t from public.profiles where id = target;
  if not found then raise exception 'ไม่พบผู้ใช้'; end if;
  if t.role = 'super_admin' then raise exception 'เปลี่ยนสถานะของ Super Admin ไม่ได้'; end if;
  if t.role = 'admin' and not public.is_super() then raise exception 'เฉพาะ Super Admin จัดการ Admin ได้'; end if;
  update public.profiles
     set status = new_status,
         approved_at = case when new_status = 'active' then now() else approved_at end,
         approved_by = case when new_status = 'active' then auth.uid() else approved_by end
   where id = target;
end $$;

-- กำหนดบทบาท (Super Admin เท่านั้น · ตั้งได้แค่ admin / user)
create or replace function public.admin_set_role(target uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'เฉพาะ Super Admin กำหนดบทบาทได้'; end if;
  if new_role not in ('admin','user') then raise exception 'บทบาทไม่ถูกต้อง'; end if;
  if target = auth.uid() then raise exception 'เปลี่ยนบทบาทของตัวเองไม่ได้'; end if;
  update public.profiles set role = new_role where id = target and role <> 'super_admin';
  if not found then raise exception 'ไม่พบผู้ใช้ หรือเป็น Super Admin'; end if;
end $$;

-- แชร์พอร์ต (เจ้าของพอร์ตเท่านั้น · ผู้รับต้องเป็นบัญชีที่อนุมัติแล้ว)
create or replace function public.share_portfolio(pid uuid, target_email text, perm text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.profiles;
begin
  if public.port_access(pid) is distinct from 'owner' then raise exception 'แชร์ได้เฉพาะพอร์ตของตัวเอง'; end if;
  if perm not in ('view','edit') then raise exception 'สิทธิ์ไม่ถูกต้อง'; end if;
  select * into t from public.profiles where lower(email) = lower(btrim(target_email));
  if not found then raise exception 'ไม่พบผู้ใช้อีเมลนี้ — ให้เขาสมัครสมาชิกก่อน'; end if;
  if t.id = auth.uid() then raise exception 'แชร์ให้ตัวเองไม่ได้'; end if;
  if t.status <> 'active' then raise exception 'ผู้ใช้นี้ยังไม่ได้รับอนุมัติ หรือถูกระงับ'; end if;
  insert into public.portfolio_shares (portfolio_id, user_id, permission, granted_by)
  values (pid, t.id, perm, auth.uid())
  on conflict (portfolio_id, user_id) do update set permission = excluded.permission, granted_by = excluded.granted_by;
end $$;

create or replace function public.unshare_portfolio(pid uuid, target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.port_access(pid) is distinct from 'owner' then raise exception 'จัดการการแชร์ได้เฉพาะพอร์ตของตัวเอง'; end if;
  delete from public.portfolio_shares where portfolio_id = pid and user_id = target;
end $$;

-- รายชื่อคนที่ได้รับแชร์พอร์ตนี้ (เจ้าของพอร์ต / Super Admin)
create or replace function public.portfolio_share_list(pid uuid)
returns table (user_id uuid, email text, permission text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.port_access(pid) is distinct from 'owner' and not public.is_super() then raise exception 'ไม่มีสิทธิ์'; end if;
  return query select s.user_id, p.email, s.permission, s.created_at
                 from public.portfolio_shares s join public.profiles p on p.id = s.user_id
                where s.portfolio_id = pid order by s.created_at;
end $$;

-- พอร์ตที่คนอื่นแชร์ให้ฉัน (พร้อมอีเมลเจ้าของ)
create or replace function public.my_shared_ports()
returns table (portfolio_id uuid, owner_email text, permission text)
language sql stable security definer set search_path = public as $$
  select s.portfolio_id, p.email, s.permission
    from public.portfolio_shares s
    join public.portfolios f on f.id = s.portfolio_id
    join public.profiles p on p.id = f.user_id
   where s.user_id = auth.uid() and public.is_active()
$$;

revoke execute on function public.touch_me(), public.admin_list_users(), public.admin_set_status(uuid,text),
  public.admin_set_role(uuid,text), public.share_portfolio(uuid,text,text), public.unshare_portfolio(uuid,uuid),
  public.portfolio_share_list(uuid), public.my_shared_ports() from anon, public;
grant execute on function public.touch_me(), public.admin_list_users(), public.admin_set_status(uuid,text),
  public.admin_set_role(uuid,text), public.share_portfolio(uuid,text,text), public.unshare_portfolio(uuid,uuid),
  public.portfolio_share_list(uuid), public.my_shared_ports() to authenticated;
