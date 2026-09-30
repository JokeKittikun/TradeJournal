-- ============================================================
-- Trade Journal — ส่งออเดอร์ไปตลาดด้วยบัญชีของผู้ใช้เอง (Binance / MEXC / Deriv)
-- รันใน Supabase → SQL Editor (รันซ้ำได้) · ต้องรัน schema.sql และ admin.sql ก่อน
--
-- ความปลอดภัย:
--   • API Secret / Token ถูกเข้ารหัสใน Edge Function (supabase/functions/trade) ก่อนบันทึก
--   • หน้าเว็บอ่านได้เฉพาะข้อมูลที่ไม่ลับ (ตลาด · Testnet/จริง · 4 ตัวท้ายของ Key) — อ่านคอลัมน์ secret ไม่ได้
--   • เพิ่ม/แก้ Key ได้ผ่าน Edge Function เท่านั้น (ตรวจกับตลาดก่อนบันทึก) · ลบได้เองจากหน้าเว็บ
-- ============================================================

-- บัญชีตลาดที่ผู้ใช้เชื่อมไว้ (1 ตลาด × 1 โหมด ต่อผู้ใช้)
create table if not exists public.exchange_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  exchange    text not null check (exchange in ('binance','mexc','deriv')),
  testnet     boolean not null default true,          -- true = Testnet / บัญชี Demo (เงินปลอม)
  key_hint    text,                                    -- 4 ตัวท้ายของ Key ไว้แสดง
  secret_enc  text not null,                           -- ข้อมูลลับ (เข้ารหัส AES-GCM ใน Edge Function)
  created_at  timestamptz not null default now(),
  unique (user_id, exchange, testnet)
);
alter table public.exchange_keys enable row level security;
drop policy if exists "keys read own"   on public.exchange_keys;
drop policy if exists "keys delete own" on public.exchange_keys;
create policy "keys read own"   on public.exchange_keys for select to authenticated using (user_id = auth.uid());
create policy "keys delete own" on public.exchange_keys for delete to authenticated using (user_id = auth.uid());
-- หน้าเว็บ: อ่านเฉพาะคอลัมน์ที่ไม่ลับ + ลบ · เพิ่ม/แก้ผ่าน Edge Function (service role) เท่านั้น
revoke all on public.exchange_keys from anon, authenticated;
grant select (id, user_id, exchange, testnet, key_hint, created_at) on public.exchange_keys to authenticated;
grant delete on public.exchange_keys to authenticated;

-- ประวัติคำสั่งที่ส่งออกไป (ไว้ตรวจสอบย้อนหลัง)
create table if not exists public.order_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete set null,
  exchange     text not null,
  testnet      boolean not null,
  symbol       text,
  side         text,
  order_type   text,
  qty          numeric,
  price        numeric,
  leverage     numeric,
  tp           numeric,
  sl           numeric,
  ok           boolean not null default false,
  message      text,
  response     jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists order_log_user_idx on public.order_log (user_id, created_at desc);
alter table public.order_log enable row level security;
drop policy if exists "orders read own" on public.order_log;
create policy "orders read own" on public.order_log for select to authenticated using (user_id = auth.uid());
revoke all on public.order_log from anon, authenticated;
grant select on public.order_log to authenticated;
