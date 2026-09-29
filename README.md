# Trade Journal (BTC)

เว็บบันทึกการเทรด BTC Futures: หน้าเว็บอยู่บน GitHub Pages ข้อมูลเก็บใน Google Sheet ผ่าน Apps Script API และกรอบราคา M30/H1 (เริ่ม 20:30 น.) ดึงจาก Binance Futures

```
index.html                       ← หน้าเว็บ (GitHub Pages)
favicon.* / apple-touch-icon.png / icon-512.png / site.webmanifest ← ไอคอนเว็บ (อัปโหลดคู่กับ index.html)
apps-script/Code.gs              ← API ที่ผูกกับ Google Sheet
tradingview/Opening_Range_2030.pine ← indicator วาดกรอบบน TradingView
cloudflare/mexc-worker.js         ← (ไม่บังคับ) ตัวกลางดึงราคา MEXC ให้เร็วขึ้น
```

## 1. ตั้งค่า Google Sheet + Apps Script API

1. เปิด Google Sheet ที่มีชีตชื่อ **Data** (หัวตารางแถว 1–3, ข้อมูลเริ่มแถว 4)
2. **Extensions → Apps Script** → วางโค้ดจาก `apps-script/Code.gs` แทนของเดิม (ลบไฟล์ HTML ใน Apps Script ออกได้ถ้ามี)
3. แก้บรรทัด `const API_KEY = '...'` เป็นรหัสลับยาวๆ ของคุณเอง
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (จำเป็น เพื่อให้หน้าเว็บบน GitHub เรียกได้ — ข้อมูลถูกป้องกันด้วย API_KEY)
5. คัดลอก **Web app URL** (ลงท้ายด้วย `/exec`)

> แก้ Code.gs ครั้งต่อไป: Deploy → Manage deployments → Edit → Version: **New version** (URL เดิมใช้ต่อได้)

## 2. ขึ้น GitHub Pages

1. อัปโหลดไฟล์ทั้งหมดขึ้น repo
2. **Settings → Pages → Source: Deploy from a branch → main / (root)**
3. เปิด `https://<username>.github.io/<repo>/`

## 3. เชื่อมเว็บกับ Sheet

เปิดเว็บ → กด **⚙ ตั้งค่า** → ใส่ Web app URL และ API_KEY → **ทดสอบ & บันทึก**

URL และรหัสลับเก็บใน localStorage ของเบราว์เซอร์เครื่องนั้นเท่านั้น **ไม่อยู่ในโค้ดบน GitHub** — เปิดจากเครื่อง/มือถือใหม่ต้องกรอกครั้งเดียว

## 4. (ไม่บังคับ) ให้กราฟ MEXC เร็วขึ้นด้วย Cloudflare Worker (ฟรี)

MEXC ไม่ให้เบราว์เซอร์ดึงประวัติราคาตรง ๆ เดิมจึงต้องดึงผ่าน Apps Script (1–4 วินาที) · Worker ตอบประมาณ 0.1–0.3 วินาที

1. สมัคร / เข้าสู่ระบบ https://dash.cloudflare.com (ฟรี ไม่ต้องใช้บัตร)
2. **Workers & Pages → Create → Create Worker** → ตั้งชื่อ เช่น `mexc-proxy` → **Deploy**
3. กด **Edit code** → ลบโค้ดเดิม → วางโค้ดจาก `cloudflare/mexc-worker.js` → **Deploy**
4. คัดลอก URL ของ Worker (เช่น `https://mexc-proxy.xxxx.workers.dev`)
5. ใส่ใน `index.html` ที่บรรทัด `const MEXC_WORKER = '';` → อัปโหลดขึ้น GitHub

ถ้า Worker มีปัญหา หน้าเว็บจะกลับไปดึงผ่าน Apps Script ให้อัตโนมัติ

## หมายเหตุ

- **อย่า commit API_KEY ลง repo** (Code.gs ใน repo ควรเป็น `CHANGE-ME...` ตัวจริงใส่ใน Apps Script เท่านั้น)
- กรอบราคาดึงจาก `fapi.binance.com` โดยตรงจากเบราว์เซอร์ — ถ้าเปิด VPN ประเทศ US จะถูกบล็อก
- ตลาด US เปิด 20:30 น. (ช่วง Daylight Saving) และ 21:30 น. (ช่วงหน้าหนาว ~พ.ย.–มี.ค.) เลือกได้ในตาราง
