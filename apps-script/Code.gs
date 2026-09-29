/**
 * Trade Journal — Google Apps Script API (หน้าเว็บอยู่บน GitHub Pages)
 * 1 พอร์ต = 1 ชีต (หัวตารางแถว 1–3, ข้อมูลเริ่มแถว 4) · ชีต "Data" เดิม = พอร์ตแรก
 * เว็บเขียนเฉพาะช่องกรอก ส่วนช่องคำนวณจะถูกใส่เป็นสูตรของ Google Sheet เอง
 */

const SHEET_NAME = 'Data';
const FIRST_ROW = 4;
const API_VERSION = 13;  // เว็บใช้เช็กว่า Code.gs เป็นเวอร์ชันล่าสุด (7 = หลายพอร์ต + ทุนกำหนดเองรายไม้, 8 = boot เรียกครั้งเดียว, 9 = ลบพอร์ต, 10 = เติมหัวตารางอัตโนมัติ, 11 = กันแก้/ลบผิดแถว, 12 = เก็บเส้นที่วาดบนกราฟแยกตามพอร์ต, 13 = ลบพอร์ตเร็วขึ้น)
const DRAW_SHEET = '_Drawings';   // ชีตซ่อน: เก็บเส้น/กล่องที่วาดบนกราฟ แถวละ 1 พอร์ต (A = sheetId ของพอร์ต, B = JSON, C = เวลาที่บันทึก)
const NUM_COLS = 35; // A..AI (AF = หมายเหตุ, AG = Leverage ที่ใช้จริง, AH = Bias, AI = ราคาเฉลี่ยจริง)
// ถ้าสร้างสคริปต์แยกจากชีต (ไม่ได้เปิดจาก Extensions > Apps Script) ให้ใส่ ID ของชีตตรงนี้
const SPREADSHEET_ID = '';

// ⚠️ ใส่รหัสลับของคุณเอง (ยาวๆ เดายาก) แล้วใส่รหัสเดียวกันในหน้าเว็บ — อย่า commit รหัสจริงลง GitHub
const API_KEY = 'CHANGE-ME-to-a-long-random-secret';

/* ---------- API สำหรับหน้าเว็บบน GitHub Pages ---------- */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function handle_(key, action, args) {
  if (API_KEY.indexOf('CHANGE-ME') === 0) return { ok: false, error: 'ยังไม่ได้ตั้ง API_KEY ใน Code.gs' };
  if (key !== API_KEY) return { ok: false, error: 'รหัสลับ (API key) ไม่ถูกต้อง' };
  try {
    const fns = {
      getTrades: getTrades, addTrade: addTrade, updateTrade: updateTrade, deleteTrade: deleteTrade, setCapital: setCapital,
      boot: boot, listPorts: listPorts, addPort: addPort, renamePort: renamePort, deletePort: deletePort, saveDrawings: saveDrawings,
      proxyGet: proxyGet, proxyGetMany: proxyGetMany,
    };
    if (!fns[action]) return { ok: false, error: 'ไม่รู้จักคำสั่ง ' + action };
    return { ok: true, data: fns[action].apply(null, args || []) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
// อ่านข้อมูล: GET ?action=getTrades&key=...&args=[portId]
function doGet(e) {
  const p = (e && e.parameter) || {};
  let args = [];
  if (p.args) { try { args = JSON.parse(p.args); } catch (err) { return json_({ ok: false, error: 'args ไม่ถูกต้อง' }); } }
  // GET ใช้ได้เฉพาะคำสั่งอ่านข้อมูล
  const action = p.action || 'getTrades';
  if (['boot', 'getTrades', 'listPorts', 'proxyGet', 'proxyGetMany'].indexOf(action) < 0) return json_({ ok: false, error: 'คำสั่งนี้ต้องใช้ POST' });
  return json_(handle_(p.key, action, args));
}
// เขียนข้อมูล: POST body = {"key":"...","action":"addTrade","args":[...]}  (Content-Type: text/plain)
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'รูปแบบข้อมูลไม่ถูกต้อง' }); }
  return json_(handle_(body.key, body.action, body.args));
}

/* ---------- ชีต / พอร์ต ---------- */
// จำค่าไว้ใช้ซ้ำในการเรียกครั้งเดียวกัน (ลดการอ่านชีตซ้ำ ๆ = เร็วขึ้น)
let SS_ = null, PROPS_ = null, DEF_ = null, SHEETS_ = null, READY_ = {};
function ss_() { return SS_ || (SS_ = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet()); }
function props_() { return PROPS_ || (PROPS_ = PropertiesService.getScriptProperties()); }
function sheets_() { return SHEETS_ || (SHEETS_ = ss_().getSheets()); }

// ชีตพอร์ตแรก (ชีต Data เดิม) — จำด้วย sheetId จึงเปลี่ยนชื่อชีตได้
function defaultSheet_() {
  if (DEF_) return DEF_;
  const ss = ss_();
  const saved = props_().getProperty('DEFAULT_PORT');
  let sh = saved != null ? sheets_().find(x => x.getSheetId() === Number(saved)) : null;
  if (!sh) {
    // 1) แท็บชื่อ SHEET_NAME  2) แท็บที่ A3 = "Date" (โครงเดียวกับบันทึกเทรด)  3) แท็บแรก
    sh = ss.getSheetByName(SHEET_NAME);
    if (!sh) sh = ss.getSheets().find(x => String(x.getRange('A3').getValue()).trim().toLowerCase() === 'date');
    if (!sh) sh = ss.getSheets()[0];
    if (!sh) throw new Error('ไม่พบชีตสำหรับบันทึกเทรด');
    props_().setProperty('DEFAULT_PORT', String(sh.getSheetId()));
  }
  return (DEF_ = sh);
}

// รายการชีตพอร์ตตามลำดับ (เก็บเป็น sheetId ใน Script Properties)
function portSheets_() {
  const def = defaultSheet_();
  let ids = [];
  try { ids = JSON.parse(props_().getProperty('PORTS') || '[]'); } catch (e) { ids = []; }
  if (ids.indexOf(def.getSheetId()) < 0) ids.unshift(def.getSheetId());
  const sheets = sheets_();
  return ids.map(id => sheets.find(s => s.getSheetId() === id)).filter(Boolean);
}
function savePortIds_(sheets) { props_().setProperty('PORTS', JSON.stringify(sheets.map(s => s.getSheetId()))); }

// ชีตของพอร์ตที่เลือก (ไม่ส่งพอร์ต = พอร์ตแรก ใช้ได้กับหน้าเว็บเวอร์ชันเก่า)
function sheet_(port) {
  let sh;
  if (port === undefined || port === null || port === '') sh = defaultSheet_();
  else {
    sh = portSheets_().find(s => s.getSheetId() === Number(port));
    if (!sh) throw new Error('ไม่พบพอร์ตนี้ (อาจถูกลบชีตไปแล้ว)');
  }
  if (READY_[sh.getSheetId()]) return sh;
  if (sh.getMaxColumns() < NUM_COLS) sh.insertColumnsAfter(sh.getMaxColumns(), NUM_COLS - sh.getMaxColumns());
  ensureHeaders_(sh);
  READY_[sh.getSheetId()] = true;
  return sh;
}

/* ---------- หัวตาราง (แถว 3, คอลัมน์ A..AI) ---------- */
const HEADERS = [
  'Date', 'ไม้ที่', 'ทุน', 'M30 กรอบบน', 'M30 กรอบล่าง', 'ระยะวิ่ง M30', 'H1 กรอบบน', 'H1 กรอบล่าง', 'ระยะวิ่ง H1', 'Risk %',   // A..J
  'Lev M30 Long', 'Lev M30 Short', 'Lev H1 Long', 'Lev H1 Short',                                                           // K..N
  'Auto Position', 'ราคาเบรก', 'Auto TF', 'ราคารีเทส', 'ราคาเฉลี่ย', 'TP', 'SL',                                               // O..U
  'Manual Position', 'Manual TF', 'ราคาเปิด (Manual)', 'Manual TP', 'Manual SL',                                            // V..Z
  'Liq. Price', 'ระยะถึง Liq.', 'Balance', 'Diff %', 'Result',                                                              // AA..AE
  'หมายเหตุ', 'Leverage ที่ใช้จริง', 'Bias', 'ราคาเฉลี่ยจริง',                                                                 // AF..AI
];
// เติมหัวตารางช่องที่ว่าง (ไม่ทับหัวตารางเดิมที่มีอยู่แล้ว) · ถ้าแถว 3 ว่างทั้งแถว จัดรูปแบบหัวตารางให้ด้วย
function ensureHeaders_(sh) {
  const rng = sh.getRange(3, 1, 1, NUM_COLS);
  const hdr = rng.getValues()[0];
  const blank = v => v === '' || v === null;
  if (!hdr.some(blank)) return;
  const wasEmpty = hdr.every(blank);
  rng.setValues([hdr.map((v, i) => blank(v) ? HEADERS[i] : v)]);
  if (wasEmpty) {
    rng.setFontWeight('bold').setBackground('#1c232d').setFontColor('#e6edf3').setHorizontalAlignment('center').setWrap(true);
    if (sh.getFrozenRows() < 3) sh.setFrozenRows(3);
    if (!sh.getRange('A1').getValue()) sh.getRange('A1').setValue('Trade Journal · ' + sh.getName()).setFontWeight('bold').setFontSize(12);
  }
}

/** (ไม่บังคับ) รันครั้งเดียวจาก editor เพื่อเติมหัวตารางให้ทุกพอร์ต */
function repairHeaders() { portSheets_().forEach(sh => ensureHeaders_(sh)); }

function checkPortName_(name, exceptSheet) {
  name = String(name || '').trim();
  if (!name) throw new Error('ใส่ชื่อพอร์ต');
  if (name.length > 60) throw new Error('ชื่อพอร์ตยาวเกินไป (สูงสุด 60 ตัวอักษร)');
  if (/[\[\]\*\?\/\\:]/.test(name)) throw new Error('ชื่อพอร์ตห้ามมีตัวอักษร [ ] * ? / \\ :');
  const dup = sheets_().find(s => s.getName().toLowerCase() === name.toLowerCase() && (!exceptSheet || s.getSheetId() !== exceptSheet.getSheetId()));
  if (dup) throw new Error('มีชีตชื่อ "' + name + '" อยู่แล้ว');
  return name;
}

// สรุปของแต่ละพอร์ต สำหรับหน้าแรก
function portSummary_(sh) {
  const n = Math.max(sh.getLastRow(), FIRST_ROW) - FIRST_ROW + 1;
  const v = sh.getRange(FIRST_ROW, 1, n, colIdx_('AD') + 1).getValues();   // อ่านครั้งเดียว A..AD
  const capital = v[0][colIdx_('C')];
  let balance = capital, trades = 0, closed = 0, wins = 0, losses = 0;
  {
    for (let i = 0; i < n; i++) {
      if (v[i][0] === '' || v[i][0] === null) continue;
      trades++;
      const bal = v[i][colIdx_('AC')], diff = v[i][colIdx_('AD')];
      if (bal !== '' && bal !== null) balance = bal;
      if (diff !== '' && diff !== null) { closed++; if (diff > 0) wins++; else if (diff < 0) losses++; }
    }
  }
  return { id: sh.getSheetId(), name: sh.getName(), capital: capital, balance: balance, trades: trades, closed: closed, wins: wins, losses: losses };
}

function listPorts() {
  return { ports: portSheets_().map(portSummary_), version: API_VERSION };
}

/** เปิดหน้าเว็บ: รายชื่อพอร์ต + ข้อมูลไม้ของพอร์ตที่เลือก ในการเรียกครั้งเดียว */
function boot(port) {
  const out = listPorts();
  const has = port !== undefined && port !== null && port !== '' && out.ports.some(p => p.id === Number(port));
  out.data = has ? getTrades(port) : null;
  return out;
}

/** เพิ่มพอร์ตใหม่ = คัดลอกชีตพอร์ตแรก (หัวตาราง/รูปแบบ) แล้วล้างข้อมูลไม้ออก */
function addPort(name, capital) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    name = checkPortName_(name);
    capital = Number(capital);
    if (!(capital > 0)) throw new Error('ทุนเริ่มต้นต้องมากกว่า 0');
    const ss = ss_();
    const tpl = sheet_();
    const sh = tpl.copyTo(ss).setName(name);
    const last = sh.getLastRow();
    if (last >= FIRST_ROW) sh.getRange(FIRST_ROW, 1, last - FIRST_ROW + 1, sh.getMaxColumns()).clearContent();
    sh.getRange('C' + FIRST_ROW).setValue(capital);
    ensureHeaders_(sh);
    SHEETS_ = null;
    const ports = portSheets_(); ports.push(sh); savePortIds_(ports);
    SpreadsheetApp.flush();
    SHEETS_ = null;
    const out = listPorts(); out.added = sh.getSheetId(); out.data = getTrades(sh.getSheetId()); return out;
  } finally { lock.releaseLock(); }
}

/** เปลี่ยนชื่อพอร์ต (= เปลี่ยนชื่อชีต) */
function renamePort(port, name) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(port);
    sh.setName(checkPortName_(name, sh));
    SpreadsheetApp.flush();
    return listPorts();
  } finally { lock.releaseLock(); }
}

/** ลบพอร์ต (= ลบชีตของพอร์ตนั้นทั้งชีต) · ต้องเหลืออย่างน้อย 1 พอร์ต
 *  กู้คืนได้จาก File → Version history ของ Google Sheet */
function deletePort(port) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const ports = portSheets_();
    if (ports.length <= 1) throw new Error('ต้องมีอย่างน้อย 1 พอร์ต — ลบพอร์ตสุดท้ายไม่ได้');
    const sh = sheet_(port), id = sh.getSheetId();
    const rest = ports.filter(s => s.getSheetId() !== id);
    // ลบพอร์ตแรก → ให้พอร์ตถัดไปเป็นพอร์ตหลักแทน
    if (defaultSheet_().getSheetId() === id) { props_().setProperty('DEFAULT_PORT', String(rest[0].getSheetId())); DEF_ = rest[0]; }
    savePortIds_(rest);
    deleteDraw_(id);
    ss_().deleteSheet(sh);
    SHEETS_ = null;
    // ไม่อ่านสรุปทุกพอร์ตกลับไป (ช้า) — หน้าเว็บเอาพอร์ตนี้ออกจากรายการเอง
    return { ok: true, removed: id, version: API_VERSION };
  } finally { lock.releaseLock(); }
}

/* ---------- เส้นที่วาดบนกราฟ (แยกตามพอร์ต) ---------- */
function drawSheet_(create) {
  let sh = ss_().getSheetByName(DRAW_SHEET);
  if (!sh && create) {
    sh = ss_().insertSheet(DRAW_SHEET);
    sh.getRange('A1:C1').setValues([['portId', 'drawings (JSON)', 'updated']]).setFontWeight('bold');
    sh.hideSheet();
    SHEETS_ = null;
  }
  return sh;
}
function drawRow_(sh, portId) {
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(portId)) return i + 2;
  return 0;
}
function getDraw_(portId) {
  const sh = drawSheet_(false); if (!sh) return [];
  const r = drawRow_(sh, portId); if (!r) return [];
  try { const v = JSON.parse(sh.getRange(r, 2).getValue() || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
/** บันทึกเส้นที่วาดของพอร์ต (แทนที่ทั้งชุด) */
function saveDrawings(items, port) {
  if (!Array.isArray(items)) throw new Error('ข้อมูลเส้นไม่ถูกต้อง');
  const json = JSON.stringify(items);
  if (json.length > 45000) throw new Error('เส้นที่วาดเยอะเกินไป — ลบบางเส้นก่อน');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const id = sheet_(port).getSheetId();
    const sh = drawSheet_(true);
    const r = drawRow_(sh, id) || sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, 3).setValues([[id, json, new Date()]]);
    return { ok: true, n: items.length };
  } finally { lock.releaseLock(); }
}
function deleteDraw_(portId) {
  const sh = drawSheet_(false); if (!sh) return;
  const r = drawRow_(sh, portId); if (r) sh.deleteRow(r);
}

/* ---------- สูตรต่อแถว (ตรงกับไฟล์ Trade_Performance ที่อัปเกรดแล้ว) ---------- */
function rowFormulas_(r) {
  const rng = `IF(Q${r}="M30",F${r},I${r})`;
  const rngM = `IF(W${r}="M30",F${r},I${r})`;
  const edge = `IF(O${r}="Long",IF(Q${r}="M30",D${r},G${r}),IF(Q${r}="M30",E${r},H${r}))`;
  return {
    B: `=IF(A${r}="","",COUNTIF($A$${FIRST_ROW}:A${r},A${r}))`,
    C: r === FIRST_ROW ? null : `=IF(A${r}="","",IF(AC${r - 1}="",C${r - 1},AC${r - 1}))`,
    F: `=IF(OR(D${r}="",E${r}=""),"",D${r}-E${r})`,
    I: `=IF(OR(G${r}="",H${r}=""),"",G${r}-H${r})`,
    K: `=IF(OR(F${r}="",J${r}=""),"",MAX(1,ROUNDDOWN((J${r}/100)*D${r}/F${r},2)))`,
    L: `=IF(OR(F${r}="",J${r}=""),"",MAX(1,ROUNDDOWN((J${r}/100)*E${r}/F${r},2)))`,
    M: `=IF(OR(I${r}="",J${r}=""),"",MAX(1,ROUNDDOWN((J${r}/100)*G${r}/I${r},2)))`,
    N: `=IF(OR(I${r}="",J${r}=""),"",MAX(1,ROUNDDOWN((J${r}/100)*H${r}/I${r},2)))`,
    // P = ราคาเบรก, R = ราคารีเทส → กรอกเอง · S = ราคาเฉลี่ยจากไม้ที่เข้า (คำนวณ) · AI = ราคาเฉลี่ยจริง (กรอกเอง)
    S: `=IF(AND(P${r}="",R${r}=""),"",IF(P${r}="",R${r},IF(R${r}="",P${r},AVERAGE(P${r},R${r}))))`,
    // TP/SL วัดจากกรอบบน (Long) / กรอบล่าง (Short) ของ TF นั้น
    T: `=IF(OR(O${r}="",Q${r}=""),"",IF(O${r}="Long",${edge}+${rng},${edge}-${rng}))`,
    U: `=IF(OR(O${r}="",Q${r}=""),"",IF(O${r}="Long",${edge}-${rng},${edge}+${rng}))`,
    Y: `=IF(OR(V${r}="",W${r}="",X${r}=""),"",IF(V${r}="Long",X${r}+${rngM},X${r}-${rngM}))`,
    Z: `=IF(OR(V${r}="",W${r}="",X${r}=""),"",IF(V${r}="Long",X${r}-${rngM},X${r}+${rngM}))`,
    AB: `=IF(AA${r}="","",AA${r}-IF(AI${r}<>"",AI${r},IF(S${r}<>"",S${r},X${r})))`,
    AD: `=IF(OR(AC${r}="",C${r}=""),"",(AC${r}-C${r})/C${r})`,
    AE: `=IF(AD${r}="","",IF(AD${r}<0,"Loss",IF(AD${r}>0,"Win","BE")))`,
  };
}

const INPUTS = { // field -> column
  date: 'A', t30: 'D', b30: 'E', t1: 'G', b1: 'H', risk: 'J',
  aPos: 'O', brk: 'P', aTf: 'Q', ret: 'R', mPos: 'V', mTf: 'W', open: 'X',
  liq: 'AA', bal: 'AC', note: 'AF', lev: 'AG', bias: 'AH', avgReal: 'AI',
};

function colIdx_(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function buildRow_(r, d, existingCapital) {
  const row = new Array(NUM_COLS).fill('');
  const f = rowFormulas_(r);
  Object.keys(f).forEach(k => { if (f[k]) row[colIdx_(k)] = f[k]; });
  Object.keys(INPUTS).forEach(k => {
    let v = d[k];
    if (v === undefined || v === null) v = '';
    if (k === 'date' && v) {
      const p = String(v).split('-').map(Number);
      v = new Date(p[0], p[1] - 1, p[2]);
    }
    row[colIdx_(INPUTS[k])] = v;
  });
  if (r === FIRST_ROW) {
    const cap = d.capital !== '' && d.capital != null ? Number(d.capital) : existingCapital;
    if (cap === '' || cap == null || isNaN(cap)) throw new Error('ไม้แรกต้องกรอกทุนเริ่มต้น');
    row[colIdx_('C')] = cap;
  } else if (d.capital !== '' && d.capital != null && !isNaN(Number(d.capital))) {
    row[colIdx_('C')] = Number(d.capital);   // ทุนกำหนดเองรายไม้ (ว่าง = ใช้สูตรดึงจาก Balance ไม้ก่อนหน้า)
  }
  return row;
}

function fmt_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

/* ---------- API ที่หน้าเว็บเรียกใช้ (port = sheetId ของพอร์ต, ไม่ส่ง = พอร์ตแรก) ---------- */
function getTrades(port, skipDraw) {   // skipDraw: หลังบันทึก/แก้/ลบไม้ ไม่ต้องอ่านเส้นที่วาด (เร็วขึ้น)
  const sh = sheet_(port);
  const last = Math.max(sh.getLastRow(), FIRST_ROW);
  const vals = sh.getRange(FIRST_ROW, 1, last - FIRST_ROW + 1, NUM_COLS).getValues();
  const trades = [];
  vals.forEach((v, i) => {
    if (v[0] === '' || v[0] === null) return;
    const g = c => fmt_(v[colIdx_(c)]);
    trades.push({
      row: FIRST_ROW + i, date: g('A'), n: g('B'), cap: g('C'),
      t30: g('D'), b30: g('E'), r30: g('F'), t1: g('G'), b1: g('H'), r1: g('I'), risk: g('J'),
      lL30: g('K'), lS30: g('L'), lL1: g('M'), lS1: g('N'),
      aPos: g('O'), brk: g('P'), aTf: g('Q'), ret: g('R'), retest: g('R'), avg: g('S'), tp: g('T'), sl: g('U'),
      mPos: g('V'), mTf: g('W'), open: g('X'), mTp: g('Y'), mSl: g('Z'),
      liq: g('AA'), liqDist: g('AB'), bal: g('AC'), diff: g('AD'), result: g('AE'), note: g('AF'), lev: g('AG'), bias: g('AH'), avgReal: g('AI'),
    });
  });
  return { trades: trades, capital: vals[0][colIdx_('C')], version: API_VERSION, port: { id: sh.getSheetId(), name: sh.getName() }, draw: skipDraw ? undefined : getDraw_(sh.getSheetId()) };
}

function addTrade(d, port) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(port);
    const last = Math.max(sh.getLastRow(), FIRST_ROW);
    const colA = sh.getRange(FIRST_ROW, 1, last - FIRST_ROW + 1, 1).getValues();
    let r = FIRST_ROW + colA.length;
    for (let i = 0; i < colA.length; i++) if (colA[i][0] === '' || colA[i][0] === null) { r = FIRST_ROW + i; break; }
    // กันเคสมีแถวว่างคั่นกลาง: ใช้แถวว่างแรกหลังข้อมูลสุดท้าย
    for (let i = colA.length - 1; i >= 0; i--) if (colA[i][0] !== '' && colA[i][0] !== null) { r = FIRST_ROW + i + 1; break; }
    const cap = r === FIRST_ROW ? sh.getRange('C' + FIRST_ROW).getValue() : '';
    sh.getRange(r, 1, 1, NUM_COLS).setValues([buildRow_(r, d, cap)]);
    SpreadsheetApp.flush();
    return getTrades(port, true);
  } finally { lock.releaseLock(); }
}

// กันแก้/ลบผิดแถว: ถ้าวันที่ในแถวนั้นไม่ตรงกับที่หน้าเว็บเห็น (เช่น มีการลบไม้จากเครื่องอื่นจนแถวเลื่อน) → ไม่ทำ
function checkRow_(sh, r, expectDate) {
  if (!expectDate) return;
  const cur = fmt_(sh.getRange('A' + r).getValue());
  if (String(cur) !== String(expectDate)) throw new Error('ไม้ในแถว ' + r + ' เปลี่ยนไปแล้ว (อาจแก้จากเครื่องอื่นหรือในชีต) — กดรีเฟรชแล้วลองใหม่');
}

function updateTrade(r, d, port) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(port);
    r = Number(r);
    if (r < FIRST_ROW || !sh.getRange('A' + r).getValue()) throw new Error('ไม่พบไม้ที่ต้องการแก้ไข');
    checkRow_(sh, r, d && d._orig);
    const cap = sh.getRange('C' + FIRST_ROW).getValue();
    sh.getRange(r, 1, 1, NUM_COLS).setValues([buildRow_(r, d, cap)]);
    SpreadsheetApp.flush();
    return getTrades(port, true);
  } finally { lock.releaseLock(); }
}

function deleteTrade(r, port, expectDate) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(port);
    r = Number(r);
    if (r < FIRST_ROW || !sh.getRange('A' + r).getValue()) throw new Error('ไม่พบไม้ที่ต้องการลบ');
    checkRow_(sh, r, expectDate);
    const startCap = sh.getRange('C' + FIRST_ROW).getValue();
    sh.deleteRow(r);
    if (r === FIRST_ROW) sh.getRange('C' + FIRST_ROW).setValue(startCap); // ไม้แรกถูกลบ → คงทุนเริ่มต้นไว้
    SpreadsheetApp.flush();
    return getTrades(port, true);
  } finally { lock.releaseLock(); }
}

/**
 * รันฟังก์ชันนี้ 1 ครั้งจากหน้า Apps Script (เลือก authorize แล้วกด Run)
 * เพื่อให้สิทธิ์ "Connect to an external service" สำหรับดึงราคา MEXC
 */
function authorize() {
  const r = UrlFetchApp.fetch('https://contract.mexc.com/api/v1/contract/ping', { muteHttpExceptions: true });
  Logger.log('MEXC ตอบกลับ: ' + r.getResponseCode() + ' — ให้สิทธิ์เรียบร้อย');
}

/** ดึงราคาแทนเบราว์เซอร์ (กรณีเบราว์เซอร์ถูกบล็อก CORS) — อนุญาตเฉพาะ API ราคาของ MEXC */
function proxyGet(url) {
  url = String(url || '');
  if (url.indexOf('https://contract.mexc.com/api/v1/contract/kline/') !== 0) throw new Error('URL ไม่ได้รับอนุญาต');
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('MEXC HTTP ' + r.getResponseCode());
  return JSON.parse(r.getContentText());
}

/** ดึงหลาย URL พร้อมกัน (เร็วกว่าเรียกทีละครั้ง) */
function proxyGetMany(urls) {
  urls = (urls || []).map(String);
  if (!urls.length) return [];
  if (urls.some(u => u.indexOf('https://contract.mexc.com/api/v1/contract/kline/') !== 0)) throw new Error('URL ไม่ได้รับอนุญาต');
  return UrlFetchApp.fetchAll(urls.map(u => ({ url: u, muteHttpExceptions: true }))).map(r => {
    if (r.getResponseCode() !== 200) throw new Error('MEXC HTTP ' + r.getResponseCode());
    return JSON.parse(r.getContentText());
  });
}

/** ตั้งทุนเริ่มต้นของพอร์ต (ช่อง C4 = ทุนของไม้แรก) */
function setCapital(v, port) {
  v = Number(v);
  if (!(v > 0)) throw new Error('ทุนเริ่มต้นต้องมากกว่า 0');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    sheet_(port).getRange('C' + FIRST_ROW).setValue(v);
    SpreadsheetApp.flush();
    return getTrades(port, true);
  } finally { lock.releaseLock(); }
}

/** (ไม่บังคับ) รันครั้งเดียวจาก editor เพื่ออัปเดตสูตรของแถวเดิมทั้งหมดให้เป็นเวอร์ชันใหม่ (ทุกพอร์ต) */
function repairFormulas() {
  portSheets_().forEach(sh => {
    const last = sh.getLastRow();
    for (let r = FIRST_ROW; r <= last; r++) {
      if (!sh.getRange('A' + r).getValue()) continue;
      const f = rowFormulas_(r);
      // ทุน (C) ที่กรอกเองรายไม้เป็นตัวเลข → ไม่เขียนสูตรทับ
      Object.keys(f).forEach(k => { if (!f[k]) return; if (k === 'C' && !sh.getRange('C' + r).getFormula()) return; sh.getRange(k + r).setFormula(f[k]); });
      // ราคารีเทส (R) เป็นช่องกรอกเอง: ถ้ายังเป็นสูตรเดิม ให้เก็บเป็นค่าตัวเลขแทน
      const rc = sh.getRange('R' + r); if (rc.getFormula()) rc.setValue(rc.getValue());
    }
    // Leverage (K:N) แสดงทศนิยม 2 ตำแหน่ง
    if (last >= FIRST_ROW) sh.getRange(FIRST_ROW, 11, last - FIRST_ROW + 1, 4).setNumberFormat('0.00');
  });
}
