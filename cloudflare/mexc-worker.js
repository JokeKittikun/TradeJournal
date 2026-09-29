/**
 * Cloudflare Worker — ตัวกลางดึงประวัติราคา (แท่งเทียน) ของ MEXC ให้หน้าเว็บ Trade Journal
 * เหตุผล: MEXC ไม่อนุญาตให้เบราว์เซอร์เรียก API ตรง (CORS) · เดิมต้องดึงผ่าน Apps Script ซึ่งช้า (1–4 วินาที)
 *         Worker นี้ตอบกลับประมาณ 0.1–0.3 วินาที
 *
 * อนุญาตเฉพาะ:  GET /kline/<SYMBOL>_USDT?interval=Min15&start=<unix วินาที>&end=<unix วินาที>
 * → ส่งต่อไปที่ https://contract.mexc.com/api/v1/contract/kline/<SYMBOL>_USDT?...
 * (เรียก URL อื่นไม่ได้ จึงเอาไปใช้เป็น proxy ดึงเว็บอื่นไม่ได้)
 */
const INTERVALS = /^(Min1|Min5|Min15|Min30|Min60|Hour4|Hour8|Day1)$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'GET') return json({ success: false, message: 'method not allowed' }, 405);

    const u = new URL(req.url);
    const m = u.pathname.match(/^\/kline\/([A-Z0-9]{2,20}_USDT)$/);
    const iv = u.searchParams.get('interval') || '';
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    if (!m || !INTERVALS.test(iv) || !/^\d{9,11}$/.test(start) || !/^\d{9,11}$/.test(end)) {
      return json({ success: false, message: 'bad request — ใช้ได้เฉพาะ /kline/BTC_USDT?interval=..&start=..&end=..' }, 400);
    }

    const target = `https://contract.mexc.com/api/v1/contract/kline/${m[1]}?interval=${iv}&start=${start}&end=${end}`;
    // ช่วงที่จบไปแล้วเกิน 1 ชม. = แท่งปิดหมดแล้ว ไม่เปลี่ยนอีก → แคชที่ Cloudflare ได้นาน (เร็วขึ้นอีก)
    const closed = Number(end) * 1000 < Date.now() - 3600e3;
    try {
      const r = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (TradeJournal MEXC proxy)' },
        cf: { cacheTtl: closed ? 86400 : 0, cacheEverything: closed },
      });
      return new Response(r.body, {
        status: r.status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': closed ? 'public, max-age=3600' : 'no-store' },
      });
    } catch (e) {
      return json({ success: false, message: 'MEXC ไม่ตอบ: ' + String(e && e.message || e) }, 502);
    }
  },
};
