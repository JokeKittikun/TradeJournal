-- ============================================================
-- Trade Journal — Supabase schema
-- วิธีใช้: Supabase → SQL Editor → New query → วางทั้งไฟล์ → Run (รันซ้ำได้ ไม่ลบข้อมูล)
-- ทุกตารางเปิด Row Level Security: แต่ละบัญชีอ่าน/เขียนได้เฉพาะข้อมูลของตัวเอง
-- ============================================================

-- ---------- พอร์ต (1 บัญชี มีได้หลายพอร์ต) ----------
create table if not exists public.portfolios (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  start_capital numeric not null check (start_capital > 0),
  sort          int not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists portfolios_user_name_uq on public.portfolios (user_id, lower(name));
create index if not exists portfolios_user_idx on public.portfolios (user_id, sort, created_at);

-- ---------- ไม้ (ช่องที่กรอก · ช่องคำนวณ เช่น TP/SL/Diff หน้าเว็บคำนวณเอง) ----------
create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  seq          bigint generated always as identity,          -- ลำดับไม้ในพอร์ต (แทนเลขแถวในชีต)
  date         date not null,
  capital      numeric,        -- ทุนกำหนดเองรายไม้ (ว่าง = ดึงจาก Balance ไม้ก่อนหน้า)
  t30 numeric, b30 numeric, t1 numeric, b1 numeric,          -- กรอบ M30 / H1
  risk         numeric,
  a_pos text, a_tf text, brk numeric, ret numeric,             -- Auto: Position / TF / ราคาเบรก / ราคารีเทส
  m_pos text, m_tf text, open numeric,                         -- Manual: Position / TF / ราคาเปิด
  liq          numeric,
  bal          numeric,        -- Balance หลังปิดไม้ (ว่าง = ยังไม่ปิด)
  note         text,
  lev          numeric,        -- Leverage ที่ใช้จริง
  bias         text,
  avg_real     numeric,        -- ราคาเฉลี่ยจริง
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists trades_port_idx on public.trades (portfolio_id, seq);
create index if not exists trades_user_idx on public.trades (user_id);

-- ---------- เส้นที่วาดบนกราฟ (1 แถวต่อพอร์ต) ----------
create table if not exists public.drawings (
  portfolio_id uuid primary key references public.portfolios(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  items        jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

-- ---------- updated_at อัตโนมัติ ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trades_touch on public.trades;
create trigger trades_touch before update on public.trades for each row execute function public.touch_updated_at();
drop trigger if exists drawings_touch on public.drawings;
create trigger drawings_touch before update on public.drawings for each row execute function public.touch_updated_at();

-- ---------- Row Level Security ----------
alter table public.portfolios enable row level security;
alter table public.trades     enable row level security;
alter table public.drawings   enable row level security;

drop policy if exists "own portfolios" on public.portfolios;
create policy "own portfolios" on public.portfolios
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ไม้/เส้นที่วาด: ต้องเป็นของตัวเอง และอยู่ในพอร์ตของตัวเองเท่านั้น
drop policy if exists "own trades" on public.trades;
create policy "own trades" on public.trades
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and exists (select 1 from public.portfolios p where p.id = portfolio_id and p.user_id = auth.uid()));

drop policy if exists "own drawings" on public.drawings;
create policy "own drawings" on public.drawings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and exists (select 1 from public.portfolios p where p.id = portfolio_id and p.user_id = auth.uid()));

-- ผู้ที่ยังไม่ล็อกอิน (anon) เข้าถึงไม่ได้เลย
revoke all on public.portfolios, public.trades, public.drawings from anon;
grant select, insert, update, delete on public.portfolios, public.trades, public.drawings to authenticated;
