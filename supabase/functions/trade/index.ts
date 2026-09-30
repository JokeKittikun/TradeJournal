// ============================================================
// Trade Journal — Edge Function "trade"
// ส่งออเดอร์ BTC ไปตลาดด้วยบัญชีของผู้ใช้เอง: Binance USDⓈ-M Futures / MEXC Futures / Deriv (Multipliers)
//
// ติดตั้ง (Supabase Dashboard):
//   1. รัน supabase/trading.sql
//   2. Edge Functions → Secrets → เพิ่ม TJ_ENC_KEY = ค่าสุ่ม 32 ไบต์แบบ base64 (สร้างเอง เช่น `openssl rand -base64 32`)
//      (ไม่บังคับ) DERIV_APP_ID = app_id ที่ลงทะเบียนกับ Deriv (ไม่ใส่ = 1089 ซึ่งเป็น app_id สำหรับทดสอบ)
//   3. Edge Functions → Deploy a new function → ชื่อ "trade" → วางไฟล์นี้ → ปิด "Verify JWT" (ฟังก์ชันตรวจผู้ใช้เอง)
//   4. เรียกจากภูมิภาค ap-southeast-1 (หน้าเว็บส่ง region ให้) — Binance บล็อก IP จากสหรัฐฯ
//
// ความปลอดภัย: API Secret / Token เข้ารหัส AES-GCM ด้วย TJ_ENC_KEY ก่อนบันทึก · ไม่ส่งกลับไปหน้าเว็บ
//   ผู้ใช้ควรสร้าง Key ที่ "เทรดได้อย่างเดียว" (ปิดสิทธิ์ถอนเงิน)
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
class UserError extends Error {}
const bad = (m: string): never => { throw new UserError(m); };

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const DERIV_APP_ID = Deno.env.get('DERIV_APP_ID') || '1089';
// Deriv: ปิดไว้ก่อน — Futures ของ Deriv Crypto Exchange ยังไม่มีใน API สาธารณะ และ API ฝั่ง Options เปลี่ยนเป็นระบบ PAT/OAuth ใหม่
//        (โค้ดด้านล่างเป็นแบบ WebSocket เดิม เก็บไว้เป็นต้นแบบ · เปิดใช้เมื่อยืนยันกับ API ใหม่แล้ว)
const EXCHANGES = ['binance', 'mexc'];

// ---------- เข้ารหัส ----------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let AES: CryptoKey | null = null;
async function aesKey() {
  if (AES) return AES;
  const raw = Deno.env.get('TJ_ENC_KEY'); if (!raw) bad('ผู้ดูแลยังไม่ได้ตั้งค่า TJ_ENC_KEY ใน Edge Function Secrets');
  const k = unb64(raw!.trim()); if (k.length !== 32) bad('TJ_ENC_KEY ต้องเป็นค่าสุ่ม 32 ไบต์ (base64)');
  AES = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return AES;
}
async function encrypt(o: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(JSON.stringify(o))));
  return b64(iv) + '.' + b64(ct);
}
async function decrypt(s: string) {
  const [iv, ct] = s.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}
const decOf = (step: number) => { const s = String(step); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').replace(/0+$/, '').length; };
const floorTo = (v: number, step: number) => +(Math.floor(v / step + 1e-9) * step).toFixed(decOf(step));
const roundTo = (v: number, step: number) => +(Math.round(v / step) * step).toFixed(decOf(step));

// ============================================================
// Binance USDⓈ-M Futures
// ============================================================
const BN = (t: boolean) => t ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
// Binance จำกัดตาม IP ของเซิร์ฟเวอร์: โดน 429 แล้วยังเรียกต่อ = โดนแบน (418) และแบนนานขึ้นเรื่อย ๆ (สูงสุด 3 วัน)
// → จำเวลาที่ห้ามเรียก แล้วไม่เรียก Binance เลยจนกว่าจะพ้น (ต่อ instance ของฟังก์ชัน) · ส่ง retryAt ให้หน้าเว็บหยุดดึงด้วย
const BN_BAN: Record<string, number> = {};
const bnBanErr = (until: number) => { const e: any = new UserError('Binance จำกัดการเรียกจากเซิร์ฟเวอร์ชั่วคราว — ใช้ได้อีกครั้งเวลา ' + new Date(until).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) + ' น.'); e.retryAt = until; return e; };
// signed = false: คำขอที่ใช้แค่ API Key (เช่น listenKey ของ User Data Stream)
async function bnReq(c: any, testnet: boolean, method: string, path: string, params: Record<string, unknown> = {}, signed = true) {
  const host = BN(testnet);
  if ((BN_BAN[host] || 0) > Date.now()) throw bnBanErr(BN_BAN[host]);
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); });
  if (signed) {
    q.set('recvWindow', '5000'); q.set('timestamp', String(Date.now()));
    q.set('signature', await hmacHex(c.secret, q.toString()));
  }
  const qs = q.toString();
  const r = await fetch(host + path + (qs ? '?' + qs : ''), { method, headers: { 'X-MBX-APIKEY': c.key } });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429 || r.status === 418 || j.code === -1003) {
    const m = /banned until (\d{12,})/i.exec(j.msg || ''), ra = +(r.headers.get('Retry-After') || 0);
    BN_BAN[host] = Math.max(BN_BAN[host] || 0, m ? +m[1] : Date.now() + (ra > 0 ? ra * 1000 : 60_000));
    throw bnBanErr(BN_BAN[host]);
  }
  if (r.status === 451 || r.status === 403) bad('Binance ปฏิเสธจากตำแหน่งเซิร์ฟเวอร์ (ภูมิภาคที่ถูกจำกัด) — ติดต่อผู้ดูแล');
  if (!r.ok || (typeof j.code === 'number' && j.code < 0)) { const e: any = new UserError('Binance: ' + (j.msg || 'HTTP ' + r.status) + (j.code ? ` (${j.code})` : '')); e.code = j.code; throw e; }
  return j;
}
const BN_INFO: Record<string, any> = {};
async function bnFilters(testnet: boolean, symbol: string) {
  const k = (testnet ? 't:' : 'l:') + symbol; if (BN_INFO[k]) return BN_INFO[k];
  const r = await fetch(BN(testnet) + '/fapi/v1/exchangeInfo'); const j: any = await r.json();
  const s = (j.symbols || []).find((x: any) => x.symbol === symbol); if (!s) bad('Binance ไม่มีสัญญา ' + symbol);
  const f = (t: string) => s.filters.find((x: any) => x.filterType === t) || {};
  return BN_INFO[k] = { tick: +f('PRICE_FILTER').tickSize, step: +f('LOT_SIZE').stepSize, minQty: +f('LOT_SIZE').minQty, minNotional: +(f('MIN_NOTIONAL').notional || 0) };
}
const binance = {
  async verify(c: any, testnet: boolean) { return this.balance(c, testnet); },
  async balance(c: any, testnet: boolean) {
    const a: any[] = await bnReq(c, testnet, 'GET', '/fapi/v2/balance');
    const u = a.find(x => x.asset === 'USDT') || {};
    return { currency: 'USDT', available: +(u.availableBalance || 0), balance: +(u.balance || 0) };
  },
  async place(c: any, testnet: boolean, o: any) {
    const sym = 'BTCUSDT', f = await bnFilters(testnet, sym), opp = o.side === 'BUY' ? 'SELL' : 'BUY';
    const qty = floorTo(o.qty, f.step);
    if (!(qty >= f.minQty)) bad(`จำนวนน้อยเกินไป (ขั้นต่ำ ${f.minQty} BTC)`);
    const px = o.type === 'LIMIT' ? roundTo(o.price, f.tick) : null;
    if (f.minNotional && qty * (px || o.refPrice || 0) < f.minNotional) bad(`มูลค่าสัญญาต่ำกว่าขั้นต่ำของ Binance (${f.minNotional} USDT) — เพิ่มมาร์จิ้นหรือ Leverage`);
    await bnReq(c, testnet, 'POST', '/fapi/v1/leverage', { symbol: sym, leverage: Math.max(1, Math.min(125, Math.round(o.leverage))) });
    const entry = await bnReq(c, testnet, 'POST', '/fapi/v1/order', {
      symbol: sym, side: o.side, type: o.type, quantity: qty, newOrderRespType: 'RESULT',
      ...(o.type === 'LIMIT' ? { price: px, timeInForce: 'GTC' } : {}),
    });
    // TP / SL แบบปิดทั้งสถานะ (ถ้า Binance ย้ายคำสั่งแบบมีเงื่อนไขไป Algo Order → ใช้ endpoint นั้นแทน)
    const cond = async (type: string, trigger: number) => {
      const p = { symbol: sym, side: opp, type, closePosition: 'true', workingType: 'MARK_PRICE' };
      try { const r = await bnReq(c, testnet, 'POST', '/fapi/v1/order', { ...p, stopPrice: roundTo(trigger, f.tick) }); return { ok: true, id: r.orderId }; }
      catch (e: any) {
        if (e.code === -4120 || /algo/i.test(e.message)) {
          try { const r = await bnReq(c, testnet, 'POST', '/fapi/v1/algoOrder', { ...p, algoType: 'CONDITIONAL', triggerPrice: roundTo(trigger, f.tick) }); return { ok: true, id: r.algoId || r.orderId }; }
          catch (e2: any) { return { ok: false, error: e2.message }; }
        }
        return { ok: false, error: e.message };
      }
    };
    const tp = o.tp ? await cond('TAKE_PROFIT_MARKET', o.tp) : null;
    const sl = o.sl ? await cond('STOP_MARKET', o.sl) : null;
    return { orderId: entry.orderId, status: entry.status, qty, price: +entry.avgPrice || px, tp, sl };
  },
  // สถานะที่เปิดอยู่ + คำสั่งที่รอ (Limit / TP / SL)
  async open(c: any, testnet: boolean) {
    const sym = 'BTCUSDT';
    const pos: any[] = await bnReq(c, testnet, 'GET', '/fapi/v2/positionRisk', { symbol: sym });
    const ords: any[] = await bnReq(c, testnet, 'GET', '/fapi/v1/openOrders', { symbol: sym });
    let algo: any[] = [];
    try { const a: any = await bnReq(c, testnet, 'GET', '/fapi/v1/openAlgoOrders', { symbol: sym }); algo = Array.isArray(a) ? a : (a.orders || []); } catch (e: any) { if (e.retryAt) throw e; /* ยังไม่มีระบบ Algo Order ในบัญชีนี้ */ }
    return {
      positions: pos.filter(p => +p.positionAmt !== 0).map(p => ({ side: +p.positionAmt > 0 ? 'BUY' : 'SELL', qty: Math.abs(+p.positionAmt), entry: +p.entryPrice, mark: +p.markPrice, pnl: +p.unRealizedProfit, leverage: +p.leverage, liq: +p.liquidationPrice || null, margin: +p.isolatedMargin || null })),
      orders: ords.map(o => ({ ...o, _algo: false })).concat(algo.map(o => ({ ...o, _algo: true }))).map(o => ({ id: o._algo ? o.algoId : o.orderId, algo: o._algo, side: o.side, type: o.type || o.orderType, price: +o.price || null, trigger: +(o.stopPrice || o.triggerPrice) || null, qty: +(o.origQty || o.quantity) || null, close: o.closePosition === true || o.closePosition === 'true' || o.reduceOnly === true, time: o.time || o.createTime })),
    };
  },
  async cancel(c: any, testnet: boolean, id: string, algo: boolean) {
    if (algo) return bnReq(c, testnet, 'DELETE', '/fapi/v1/algoOrder', { algoId: id });
    return bnReq(c, testnet, 'DELETE', '/fapi/v1/order', { symbol: 'BTCUSDT', orderId: id });
  },
  // User Data Stream: หน้าเว็บต่อ WebSocket ของ Binance เองด้วย listenKey (ได้เหตุการณ์คำสั่ง/สถานะทันที ไม่ต้องดึงถี่)
  // POST ครั้งแรก = สร้าง · POST ซ้ำขณะยังใช้ได้ = ได้ key เดิมและต่ออายุอีก 60 นาที (หน้าเว็บเรียกซ้ำทุก 30 นาที)
  async listenKey(c: any, testnet: boolean) {
    const r = await bnReq(c, testnet, 'POST', '/fapi/v1/listenKey', {}, false);
    return { listenKey: r.listenKey };
  },
};

// ============================================================
// MEXC Futures (ไม่มี Testnet · API สั่งเทรดอาจถูกจำกัดสำหรับบัญชีทั่วไป)
// ============================================================
const MX = 'https://contract.mexc.com';
async function mxReq(c: any, method: string, path: string, body?: unknown, query?: Record<string, unknown>) {
  // ลายเซ็น: GET = key + เวลา + query (เรียงชื่อ) · POST = key + เวลา + JSON body
  const qs = query ? Object.keys(query).sort().map(k => k + '=' + encodeURIComponent(String(query[k]))).join('&') : '';
  const t = String(Date.now()), s = body ? JSON.stringify(body) : qs;
  const sig = await hmacHex(c.secret, c.key + t + s);
  const r = await fetch(MX + path + (qs ? '?' + qs : ''), { method, headers: { ApiKey: c.key, 'Request-Time': t, Signature: sig, 'Content-Type': 'application/json' }, body: body ? s : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) bad('MEXC: ' + (j.message || j.msg || 'HTTP ' + r.status) + (j.code ? ` (${j.code})` : ''));
  return j.data;
}
const MX_CT = 0.0001;   // BTC_USDT: 1 สัญญา = 0.0001 BTC
const mexc = {
  async verify(c: any) { return this.balance(c); },
  async balance(c: any) {
    const d: any = await mxReq(c, 'GET', '/api/v1/private/account/asset/USDT');
    return { currency: 'USDT', available: +(d?.availableBalance || 0), balance: +(d?.equity || 0) };
  },
  async place(c: any, _t: boolean, o: any) {
    const vol = Math.floor(o.qty / MX_CT + 1e-9); if (vol < 1) bad('จำนวนน้อยเกินไป (ขั้นต่ำ 1 สัญญา = 0.0001 BTC)');
    const body: Record<string, unknown> = {
      symbol: 'BTC_USDT', vol, leverage: Math.max(1, Math.round(o.leverage)), openType: 1,   // 1 = Isolated
      side: o.side === 'BUY' ? 1 : 3, type: o.type === 'LIMIT' ? 1 : 5, price: o.type === 'LIMIT' ? roundTo(o.price, 0.1) : undefined,
      takeProfitPrice: o.tp ? roundTo(o.tp, 0.1) : undefined, stopLossPrice: o.sl ? roundTo(o.sl, 0.1) : undefined,
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    const d: any = await mxReq(c, 'POST', '/api/v1/private/order/submit', body);
    return { orderId: d?.orderId || d, qty: vol * MX_CT, price: o.type === 'LIMIT' ? body.price : null, tp: o.tp ? { ok: true } : null, sl: o.sl ? { ok: true } : null };
  },
  async open(c: any) {
    const pos: any[] = (await mxReq(c, 'GET', '/api/v1/private/position/open_positions', undefined, { symbol: 'BTC_USDT' })) || [];
    const od: any = await mxReq(c, 'GET', '/api/v1/private/order/list/open_orders/BTC_USDT', undefined, { page_num: 1, page_size: 50 });
    const tk: any = await (await fetch(MX + '/api/v1/contract/ticker?symbol=BTC_USDT')).json().catch(() => ({}));
    const mark = +(tk?.data?.fairPrice || tk?.data?.lastPrice || 0);
    // side ของ MEXC: 1 เปิด Long · 2 ปิด Short · 3 เปิด Short · 4 ปิด Long
    return {
      positions: pos.map((p: any) => { const L = +p.positionType === 1, q = +p.holdVol * MX_CT, e = +p.holdAvgPrice;
        return { side: L ? 'BUY' : 'SELL', qty: q, entry: e, mark, pnl: mark ? (L ? 1 : -1) * (mark - e) * q : null, leverage: +p.leverage, liq: +p.liquidatePrice || null, margin: +p.im || null }; }),
      orders: (Array.isArray(od) ? od : (od?.resultList || [])).map((o: any) => ({ id: String(o.orderId), algo: false, side: [1, 2].includes(+o.side) ? 'BUY' : 'SELL', type: +o.orderType === 5 ? 'MARKET' : 'LIMIT', price: +o.price || null, trigger: null, qty: +o.vol * MX_CT, close: [2, 4].includes(+o.side), time: o.createTime })),
    };
  },
  async cancel(c: any, _t: boolean, id: string) { return mxReq(c, 'POST', '/api/v1/private/order/cancel', [id]); },
};

// ============================================================
// Deriv (Multipliers · BTC = cryBTCUSD · TP/SL เป็นจำนวนเงิน · บัญชี Demo = ทดลอง)
// ============================================================
function derivSession(token: string) {
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`);
  let n = 0; const pend = new Map<number, any>();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new UserError('เชื่อมต่อ Deriv ไม่ได้')); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.req_id); if (!p) return; pend.delete(m.req_id); m.error ? p.rej(new UserError('Deriv: ' + m.error.message)) : p.res(m); };
  const send = async (o: Record<string, unknown>): Promise<any> => {
    await ready; const id = ++n;
    return new Promise((res, rej) => { pend.set(id, { res, rej }); ws.send(JSON.stringify({ ...o, req_id: id })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new UserError('Deriv ไม่ตอบ')); } }, 15000); });
  };
  return { send, close: () => { try { ws.close(); } catch (_) { /* */ } }, auth: () => send({ authorize: token }) };
}
const deriv = {
  async verify(c: any) { const s = derivSession(c.token); try { const a = (await s.auth()).authorize; return { currency: a.currency, available: +a.balance, balance: +a.balance, virtual: !!a.is_virtual, account: a.loginid }; } finally { s.close(); } },
  async balance(c: any) { return this.verify(c); },
  async place(c: any, _t: boolean, o: any) {
    if (o.type !== 'MARKET') bad('Deriv รองรับเฉพาะคำสั่ง Market');
    const s = derivSession(c.token);
    try {
      const a = (await s.auth()).authorize;
      const ct = o.side === 'BUY' ? 'MULTUP' : 'MULTDOWN';
      const cf = (await s.send({ contracts_for: 'cryBTCUSD', currency: a.currency })).contracts_for;
      const spec = (cf.available || []).find((x: any) => x.contract_type === ct);
      if (!spec) bad('บัญชี Deriv นี้เทรด BTC แบบ Multiplier ไม่ได้');
      const allowed: number[] = (spec.multiplier_range || []).map(Number).sort((x: number, y: number) => x - y);
      const mult = allowed.filter(m => m <= o.leverage).pop() || allowed[0];
      const stake = +(+o.margin).toFixed(2), ref = +o.refPrice;
      if (!(stake > 0)) bad('ใส่มาร์จิ้น (Stake) มากกว่า 0');
      // แปลง TP/SL จากราคา → จำนวนเงิน (กำไร/ขาดทุน ≈ Stake × Multiplier × ระยะราคา %)
      const money = (px: number) => +(stake * mult * Math.abs(px - ref) / ref).toFixed(2);
      const limit: Record<string, number> = {};
      if (o.tp) limit.take_profit = Math.max(0.1, money(o.tp));
      if (o.sl) limit.stop_loss = Math.min(stake, Math.max(0.1, money(o.sl)));
      const buy = (await s.send({ buy: 1, price: stake, parameters: { amount: stake, basis: 'stake', contract_type: ct, currency: a.currency, symbol: 'cryBTCUSD', multiplier: mult, ...(Object.keys(limit).length ? { limit_order: limit } : {}) } })).buy;
      return { orderId: buy.contract_id, price: buy.buy_price, multiplier: mult, stake, tpMoney: limit.take_profit, slMoney: limit.stop_loss, tp: o.tp ? { ok: true } : null, sl: o.sl ? { ok: true } : null };
    } finally { s.close(); }
  },
};
const ADAPTER: Record<string, any> = { binance, mexc, deriv };

// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    // ผู้ใช้: ต้องล็อกอิน และบัญชีได้รับอนุมัติแล้ว
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ ok: false, error: 'กรุณาเข้าสู่ระบบใหม่' }, 401);
    const { data: prof, error: pe } = await admin.from('profiles').select('status, can_trade').eq('id', user.id).maybeSingle();
    if (pe) return json({ ok: false, error: 'ผู้ดูแลยังไม่ได้อัปเดตฐานข้อมูล (สิทธิ์ส่งออเดอร์)' }, 500);
    if (!prof || prof.status !== 'active') return json({ ok: false, error: 'บัญชียังไม่ได้รับอนุมัติ' }, 403);
    if (!prof.can_trade) return json({ ok: false, error: 'บัญชีนี้ยังไม่ได้รับสิทธิ์ส่งออเดอร์ — ติดต่อ Super Admin' }, 403);   // Super Admin เป็นผู้เปิดสิทธิ์

    const b = await req.json().catch(() => ({}));
    const ex = String(b.exchange || ''); if (!EXCHANGES.includes(ex)) bad('เลือกตลาดไม่ถูกต้อง');
    const A = ADAPTER[ex];
    const loadCred = async (testnet: boolean) => {
      const { data } = await admin.from('exchange_keys').select('secret_enc').eq('user_id', user.id).eq('exchange', ex).eq('testnet', testnet).maybeSingle();
      if (!data) bad('ยังไม่ได้เชื่อมบัญชี ' + ex + (testnet ? ' (ทดลอง)' : ' (จริง)'));
      return decrypt(data!.secret_enc);
    };

    // ---------- เชื่อมบัญชี: ตรวจกับตลาดก่อน แล้วค่อยเข้ารหัสบันทึก ----------
    if (b.action === 'saveKey') {
      const cred = ex === 'deriv' ? { token: String(b.token || '').trim() } : { key: String(b.apiKey || '').trim(), secret: String(b.apiSecret || '').trim() };
      if (ex === 'deriv' ? !(cred as any).token : (!(cred as any).key || !(cred as any).secret)) bad('กรอกข้อมูลให้ครบ');
      let testnet = !!b.testnet;
      if (ex === 'mexc') testnet = false;                          // MEXC ไม่มี Testnet
      const info: any = await A.verify(cred, testnet);
      if (ex === 'deriv') testnet = !!info.virtual;                // Deriv: บัญชี Demo = ทดลอง (อ่านจากบัญชีจริง)
      const hint = (ex === 'deriv' ? (cred as any).token : (cred as any).key).slice(-4);
      const { error } = await admin.from('exchange_keys').upsert({ user_id: user.id, exchange: ex, testnet, key_hint: hint, secret_enc: await encrypt(cred) }, { onConflict: 'user_id,exchange,testnet' });
      if (error) throw error;
      return json({ ok: true, testnet, info });
    }

    // ---------- สถานะที่เปิดอยู่ + คำสั่งที่รอ ----------
    if (b.action === 'open') return json({ ok: true, ...(await A.open(await loadCred(!!b.testnet), !!b.testnet)) });

    // ---------- listenKey สำหรับ WebSocket (สร้าง / ต่ออายุ) ----------
    if (b.action === 'listenKey') {
      if (!A.listenKey) bad('ตลาดนี้ยังไม่รองรับการอัปเดตแบบ WebSocket');
      return json({ ok: true, ...(await A.listenKey(await loadCred(!!b.testnet), !!b.testnet)) });
    }

    // ---------- ยกเลิกคำสั่งที่รอ ----------
    if (b.action === 'cancel') {
      const testnet = !!b.testnet, id = String(b.orderId || ''); if (!id) bad('ไม่พบเลขคำสั่ง');
      if (!A.cancel) bad('ตลาดนี้ยังไม่รองรับการยกเลิกผ่านระบบ');
      const log = { user_id: user.id, portfolio_id: b.portfolioId || null, exchange: ex, testnet, symbol: 'BTC', side: b.side || null, order_type: 'CANCEL', price: +b.price || null };
      try { const r = await A.cancel(await loadCred(testnet), testnet, id, !!b.algo); await admin.from('order_log').insert({ ...log, ok: true, response: { orderId: id, status: 'CANCELED', kind: b.kind || null } }); return json({ ok: true, result: r }); }
      catch (e: any) { await admin.from('order_log').insert({ ...log, ok: false, message: e.message }); throw e; }
    }

    // ---------- ยอดเงิน ----------
    if (b.action === 'balance') return json({ ok: true, info: await A.balance(await loadCred(!!b.testnet), !!b.testnet) });

    // ---------- ส่งออเดอร์ ----------
    if (b.action === 'placeOrder') {
      const testnet = !!b.testnet, o = {
        side: b.side === 'SELL' ? 'SELL' : b.side === 'BUY' ? 'BUY' : bad('เลือก Long หรือ Short'),
        type: b.type === 'LIMIT' ? 'LIMIT' : 'MARKET', qty: +b.qty, price: +b.price || null, leverage: +b.leverage,
        tp: +b.tp || null, sl: +b.sl || null, margin: +b.margin, refPrice: +b.refPrice,
      };
      if (!(o.leverage >= 1 && o.leverage <= 125)) bad('Leverage ต้องอยู่ระหว่าง 1–125');
      if (ex !== 'deriv' && !(o.qty > 0)) bad('จำนวนต้องมากกว่า 0');
      if (o.type === 'LIMIT' && !(o.price! > 0)) bad('ใส่ราคา Limit');
      const ref = o.type === 'LIMIT' ? o.price! : o.refPrice;
      if (o.tp && ref && (o.side === 'BUY' ? o.tp <= ref : o.tp >= ref)) bad('TP อยู่ผิดฝั่งของราคาเข้า');
      if (o.sl && ref && (o.side === 'BUY' ? o.sl >= ref : o.sl <= ref)) bad('SL อยู่ผิดฝั่งของราคาเข้า');
      const cred = await loadCred(testnet);
      const log = { user_id: user.id, portfolio_id: b.portfolioId || null, exchange: ex, testnet, symbol: 'BTC', side: o.side, order_type: o.type, qty: o.qty || null, price: o.price, leverage: o.leverage, tp: o.tp, sl: o.sl };
      try {
        const res = await A.place(cred, testnet, o);
        await admin.from('order_log').insert({ ...log, ok: true, response: res });
        return json({ ok: true, result: res });
      } catch (e: any) {
        await admin.from('order_log').insert({ ...log, ok: false, message: e.message });
        throw e;
      }
    }
    bad('ไม่รู้จักคำสั่ง');
  } catch (e: any) {
    if (e?.retryAt) return json({ ok: false, error: e.message, retryAt: e.retryAt }, 429);   // หน้าเว็บหยุดดึงจนถึงเวลานี้
    return json({ ok: false, error: e instanceof UserError ? e.message : 'เกิดข้อผิดพลาด: ' + (e?.message || e) }, e instanceof UserError ? 400 : 500);
  }
  return json({ ok: false, error: 'unreachable' }, 500);
});
