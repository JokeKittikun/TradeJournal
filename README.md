# Trade Journal (BTC)

เว็บบันทึกการเทรด BTC Futures: หน้าเว็บอยู่บน GitHub Pages ข้อมูลและบัญชีผู้ใช้เก็บใน Supabase และกรอบราคา M30/H1 (เริ่ม 20:30 น.) ดึงจาก Binance Futures

```
index.html                       ← หน้าเว็บ (GitHub Pages)
guide.html                       ← คู่มือการใช้งาน
favicon.* / apple-touch-icon.png / icon-512.png / site.webmanifest / og-image.png ← ไอคอนและรูปแชร์
supabase/schema.sql              ← ตาราง portfolios / trades / drawings
supabase/admin.sql               ← บัญชีผู้ใช้ สิทธิ์ (Super Admin / Admin / ผู้ใช้) การอนุมัติ และการแชร์พอร์ต
cloudflare/mexc-worker.js        ← ตัวกลางดึงราคา MEXC (MEXC ไม่ให้เบราว์เซอร์ดึงตรง)
```

## 1. ตั้งค่า Supabase

1. สร้างโปรเจกต์ที่ https://supabase.com
2. **SQL Editor → New query** → วางทั้งไฟล์ `supabase/schema.sql` → **Run**
3. ทำแบบเดียวกันกับ `supabase/admin.sql` (อีเมล Super Admin อยู่ในฟังก์ชัน `super_admin_email()`)
4. **Project Settings → API** → คัดลอก Project URL และ **publishable key** ใส่ใน `index.html` ที่ `SB_URL` / `SB_KEY`
5. **Authentication → URL Configuration** → ใส่ URL ของเว็บ (เช่น `https://<username>.github.io/<repo>/`) ใน Site URL และ Redirect URLs

> รันไฟล์ SQL ครั้งเดียวพอ · รันซ้ำได้โดยไม่ลบข้อมูล (ใช้เมื่อมีการแก้ไฟล์ SQL)

### อีเมลยืนยัน / ตั้งรหัสผ่านใหม่ (แบบมีโลโก้)

**Authentication → Emails → Templates** → เลือกเทมเพลต → วางโค้ดจากไฟล์ → **Save**

| เทมเพลต | ไฟล์ | Subject ที่แนะนำ |
|---|---|---|
| Confirm signup | `supabase/email-templates/confirm-signup.html` | ยืนยันอีเมลของคุณ · Trade Journal |
| Reset password | `supabase/email-templates/reset-password.html` | ตั้งรหัสผ่านใหม่ · Trade Journal |

## 2. ขึ้น GitHub Pages

1. อัปโหลดไฟล์ทั้งหมดขึ้น repo
2. **Settings → Pages → Source: Deploy from a branch → main / (root)**
3. เปิด `https://<username>.github.io/<repo>/`

## 3. กราฟ MEXC ผ่าน Cloudflare Worker (ฟรี)

1. สมัคร / เข้าสู่ระบบ https://dash.cloudflare.com (ฟรี ไม่ต้องใช้บัตร)
2. **Workers & Pages → Create → Create Worker** → ตั้งชื่อ เช่น `mexc-proxy` → **Deploy**
3. กด **Edit code** → ลบโค้ดเดิม → วางโค้ดจาก `cloudflare/mexc-worker.js` → **Deploy**
4. คัดลอก URL ของ Worker (เช่น `https://mexc-proxy.xxxx.workers.dev`) ใส่ใน `index.html` ที่ `const MEXC_WORKER`

## หมายเหตุ

- **ห้ามใส่ service_role key ในหน้าเว็บหรือ repo** · ใช้ได้เฉพาะ publishable key (ข้อมูลป้องกันด้วย Row Level Security)
- กรอบราคาดึงจาก `fapi.binance.com` โดยตรงจากเบราว์เซอร์ — ถ้าเปิด VPN ประเทศ US จะถูกบล็อก
- ตลาด US เปิด 20:30 น. (ช่วง Daylight Saving) และ 21:30 น. (ช่วงหน้าหนาว ~พ.ย.–มี.ค.) เลือกได้ในตาราง
