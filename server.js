// Smart Print Token System — Backend (Node.js + @libsql/client)
// Local:  node server.js            → file:data/app.db
// Cloud:  TURSO_URL + TURSO_AUTH_TOKEN env → Turso (Render/production)
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { q, q1, run, getSetting, setSetting, verifyPassword, hashPasswordNew, allocTokenNo, randomBytes, isCloud } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// public/ ka rasta har mahol mein khud dhoondo (local, VPS, Vercel bundle — jahan mile).
const PUBLIC_CANDIDATES = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '..', 'public'),
  path.join(process.cwd(), 'public'),
];
const PUBLIC_DIR = PUBLIC_CANDIDATES.find((d) => existsSync(path.join(d, 'book.html'))) || PUBLIC_CANDIDATES[0];

/* ============================== helpers ============================== */

const nowISO = () => new Date().toISOString();

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const ok = (res, obj) => send(res, 200, obj);
const bad = (res, msg, status = 400) => send(res, status, { ok: false, error: msg });

function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('Request bohat bari hai.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const text = await readBody(req);
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('Ghalat data bheja gaya.'); }
}

function normalizeMobile(m) {
  let d = String(m || '').replace(/\D/g, '');
  if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  if (d.length === 11 && d.startsWith('03')) return d;
  return null;
}
const isUniqueErr = (e) => String(e && e.message || '').includes('UNIQUE constraint failed');

/* ============================== pricing engine ============================== */

const toNum = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const FT2_PER_UNIT = { feet: 1, inches: 1 / 12, cm: 0.0328084 };

function computeArea(inputs, cfg) {
  const f = FT2_PER_UNIT[inputs[cfg.unit_field]] || 1;
  const w = toNum(inputs[cfg.width_field]) * f;
  const h = toNum(inputs[cfg.height_field]) * f;
  const qty = Math.max(1, Math.round(toNum(inputs[cfg.quantity_field]) || 1));
  const area = w * h * qty;
  return { area, billable: Math.max(area, toNum(cfg.min_billable_area) || 0), qty };
}

function ruleApplies(rule, inputs) {
  const c = rule.config || {};
  if (c.condition) return String(inputs[c.condition.field] ?? '') === String(c.condition.equals);
  return true;
}

// Backend is source of truth — browser ki bheji price par kabhi bharosa nahi
export async function calculatePrice(categoryId, inputs) {
  const rows = await q('SELECT * FROM pricing_rules WHERE category_id=? AND active=1 ORDER BY sort_order ASC', categoryId);
  const rules = rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') }));

  const manual = rules.find(r => r.type === 'manual');
  if (manual) {
    return { quote_required: true, reason_ur: manual.label_ur || 'Is service ke liye dukan se quote lena hoga.', lines: [], total: null };
  }

  const lines = [];
  let subtotal = 0;
  const fixed = rules.find(r => r.type === 'fixed');
  if (fixed) {
    const amt = toNum(fixed.config.amount);
    lines.push({ label: fixed.label_ur || 'Fixed price', detail: '', amount: amt });
    subtotal = amt;
  } else {
    for (const r of rules) {
      if (!ruleApplies(r, inputs)) continue;
      const c = r.config;
      if (r.type === 'base') {
        const amt = toNum(c.amount);
        lines.push({ label: r.label_ur, detail: '', amount: amt }); subtotal += amt;
      } else if (r.type === 'per_unit') {
        let qq = toNum(inputs[c.field]);
        for (const mf of (c.multiply_by || [])) qq *= toNum(inputs[mf]);
        const amt = toNum(c.amount) * qq;
        lines.push({ label: r.label_ur, detail: `${qq} × Rs.${c.amount}`, amount: amt }); subtotal += amt;
      } else if (r.type === 'per_area') {
        const { billable } = computeArea(inputs, c);
        const amt = toNum(c.amount) * billable;
        lines.push({ label: r.label_ur, detail: `${billable.toFixed(2)} sqft × Rs.${c.amount}`, amount: amt }); subtotal += amt;
      } else if (r.type === 'option_rate') {
        const rate = toNum((c.rates || {})[inputs[c.field]]);
        let qq = 1, detail = '';
        if (c.per === 'quantity') { qq = Math.max(0, Math.round(toNum(inputs[c.quantity_field]))); detail = `${qq} × Rs.${rate}`; }
        else if (c.per === 'units') { qq = 1; for (const uf of (c.unit_fields || [])) qq *= toNum(inputs[uf]); detail = `${qq} × Rs.${rate}`; }
        else if (c.per === 'area') { const a = computeArea(inputs, c.area_config || {}); qq = a.billable; detail = `${qq.toFixed(2)} sqft × Rs.${rate}`; }
        const amt = rate * qq;
        if (amt !== 0) lines.push({ label: r.label_ur, detail, amount: amt });
        subtotal += amt;
      } else if (r.type === 'option_charge') {
        const amt = toNum((c.charges || {})[inputs[c.field]]);
        if (amt !== 0) lines.push({ label: r.label_ur, detail: '', amount: amt });
        subtotal += amt;
      } else if (r.type === 'tier') {
        const qq = toNum(inputs[c.field]);
        const t = (c.tiers || []).find(t => qq >= t.min && (t.max == null || qq <= t.max)) || {};
        const rate = toNum(t.rate);
        const amt = rate * qq;
        lines.push({ label: r.label_ur, detail: `${qq} × Rs.${rate} (slab)`, amount: amt }); subtotal += amt;
      }
    }
  }
  for (const r of rules.filter(r => r.type === 'percent')) {
    if (!ruleApplies(r, inputs)) continue;
    const c = r.config;
    const amt = subtotal * toNum(c.percent) / 100;
    const signed = c.kind === 'discount' ? -amt : amt;
    lines.push({ label: r.label_ur, detail: `${c.percent}%`, amount: signed });
    subtotal += signed;
  }
  const minR = rules.find(r => r.type === 'minimum');
  if (minR && subtotal < toNum(minR.config.amount)) {
    const adj = toNum(minR.config.amount) - subtotal;
    lines.push({ label: minR.label_ur || 'Minimum order adjustment', detail: '', amount: adj });
    subtotal += adj;
  }
  const total = Math.round(subtotal);
  return { quote_required: false, lines: lines.map(l => ({ ...l, amount: Math.round(l.amount * 100) / 100 })), total };
}

/* ============================== validation ============================== */

async function getCategoryWithFields(id) {
  const cat = await q1('SELECT * FROM categories WHERE id=? AND active=1', id);
  if (!cat) return null;
  const fields = await q('SELECT * FROM fields WHERE category_id=? AND active=1 ORDER BY sort_order ASC', id);
  return { cat, fields };
}

function validateInputs(fields, inputs) {
  const errors = [];
  const clean = {};
  for (const f of fields) {
    const v = inputs[f.field_key];
    if (f.field_type === 'file') continue;
    if (f.required && (v === undefined || v === null || String(v).trim() === '')) {
      errors.push(`"${f.label_ur}" zaroori hai.`); continue;
    }
    if (v === undefined || v === null || v === '') { clean[f.field_key] = ''; continue; }
    if (f.field_type === 'number') {
      const n = parseFloat(v);
      const val = JSON.parse(f.validation || '{}');
      if (isNaN(n)) { errors.push(`"${f.label_ur}" mein sahi number likhein.`); continue; }
      if (val.min != null && n < val.min) { errors.push(`"${f.label_ur}" kam az kam ${val.min} hona chahiye.`); continue; }
      if (val.max != null && n > val.max) { errors.push(`"${f.label_ur}" zyada se zyada ${val.max} ho sakta hai.`); continue; }
      clean[f.field_key] = n;
    } else if (f.field_type === 'select' || f.field_type === 'radio') {
      const opts = JSON.parse(f.options || '[]').map(o => o.value);
      if (!opts.includes(String(v))) { errors.push(`"${f.label_ur}" mein durust option select karein.`); continue; }
      clean[f.field_key] = String(v);
    } else if (f.field_type === 'checkbox') {
      clean[f.field_key] = (v === 'yes' || v === 'true' || v === true) ? 'yes' : 'no';
    } else {
      clean[f.field_key] = String(v).slice(0, 5000);
    }
  }
  return { errors, clean };
}

/* ============================== orders ============================== */

const ACTIVE_STATUSES = ['confirmed', 'in_queue', 'in_progress'];
const STATUS_UR = {
  draft: 'Draft', quote_required: 'Quote ka intezaar', quote_sent: 'Quote bheja gaya',
  confirmed: 'Confirm ho gaya', in_queue: 'Qataar mein', in_progress: 'Kaam jaari',
  ready: 'Tayyar hai', completed: 'Mukammal', cancelled: 'Mansookh',
};

async function rowToPublic(row, full = false) {
  const cat = await q1('SELECT name_ur, icon FROM categories WHERE id=?', row.category_id) || {};
  const base = {
    token_no: row.token_no,
    secure_ref: row.secure_ref,
    customer_name: row.customer_name,
    service_name: cat.name_ur || '',
    service_icon: cat.icon || '',
    status: row.status,
    status_ur: STATUS_UR[row.status] || row.status,
    queue_position: row.queue_position,
    total_price: row.total_price,
    quoted_total: row.quoted_total,
    quote_note: row.quote_note,
    price_breakdown: JSON.parse(row.price_breakdown || '[]'),
    details: JSON.parse(row.details || '{}'),
    estimated_minutes: row.estimated_minutes,
    checkin_deadline: row.checkin_deadline,
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
  };
  if (full) {
    const fc = await q1('SELECT COUNT(*) AS c FROM order_files WHERE order_id=?', row.id);
    base.has_files = Number(fc.c);
  }
  return base;
}

async function createOrder({ customer, category_id, inputs, files, source, idemKey, otpVerified }) {
  const found = await getCategoryWithFields(category_id);
  if (!found) { const e = new Error('Service durust select karein.'); e.status = 400; throw e; }
  const { cat, fields } = found;
  const { errors, clean } = validateInputs(fields, inputs);
  if (errors.length) { const e = new Error(errors[0]); e.status = 400; e.details = errors; throw e; }

  // file size check (DB mein save hongi taake cloud par bhi persist rahein)
  let totalBytes = 0;
  const fileRows = [];
  if (files && files.length) {
    for (const f of files) {
      const b64 = String(f.data || '');
      totalBytes += Math.ceil(b64.length * 3 / 4);
      if (totalBytes > 10 * 1024 * 1024) { const e = new Error('Files kul mila kar 10MB se zyada hain.'); e.status = 400; throw e; }
      fileRows.push({ name: String(f.name || 'file').slice(0, 120), data_b64: b64 });
    }
    if (fileRows.some(fr => Math.ceil(fr.data_b64.length * 3 / 4) > 5 * 1024 * 1024)) {
      const e = new Error('Koi file 5MB se bari hai.'); e.status = 400; throw e;
    }
  }

  const price = await calculatePrice(category_id, clean);
  const secureRef = randomBytes(16).toString('hex');
  const ts = nowISO();

  // idempotency pre-check (race ho to UNIQUE constraint pakar lega)
  if (idemKey) {
    const dup = await q1('SELECT * FROM orders WHERE idempotency_key=?', idemKey);
    if (dup) return { order: await rowToPublic(dup, true), duplicate: true };
  }

  let tokenNo = null, queuePos = null, status = 'confirmed', confirmedAt = ts, total = price.total;
  if (price.quote_required) {
    status = 'quote_required'; confirmedAt = null; total = null;
  } else {
    tokenNo = await allocTokenNo(); // atomic — duplicates impossible
    const qc = await q1(`SELECT COUNT(*) AS c FROM orders WHERE shop_id=1 AND status IN (?,?,?)`, ...ACTIVE_STATUSES);
    queuePos = Number(qc.c) + 1;
  }
  const checkinHours = toNum(await getSetting('checkin_hours') || 48);
  const deadline = confirmedAt ? new Date(Date.now() + checkinHours * 3600 * 1000).toISOString() : null;

  let orderId;
  try {
    const r = await run(`INSERT INTO orders(token_no,secure_ref,idempotency_key,shop_id,category_id,customer_name,
      customer_mobile,customer_email,otp_verified,source,status,queue_position,details,price_breakdown,total_price,
      estimated_minutes,checkin_deadline,created_at,confirmed_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tokenNo, secureRef, idemKey || null, 1, category_id, customer.name, customer.mobile, customer.email || '',
      otpVerified ? 1 : 0, source || 'online', status, queuePos, JSON.stringify(clean),
      JSON.stringify(price.lines || []), total, cat.estimated_minutes, deadline, ts, confirmedAt, ts);
    orderId = r.lastId;
  } catch (e) {
    if (isUniqueErr(e) && idemKey) {
      const dup = await q1('SELECT * FROM orders WHERE idempotency_key=?', idemKey);
      if (dup) return { order: await rowToPublic(dup, true), duplicate: true };
    }
    throw e;
  }

  for (let i = 0; i < fileRows.length; i++) {
    await run('INSERT INTO order_files(order_id, idx, name, data_b64) VALUES(?,?,?,?)',
      orderId, i, fileRows[i].name, fileRows[i].data_b64);
  }

  const row = await q1('SELECT * FROM orders WHERE id=?', orderId);
  return { order: await rowToPublic(row, true), duplicate: false };
}

/* ============================== admin auth ============================== */

async function adminFromReq(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  const s = await q1('SELECT * FROM admin_sessions WHERE token=?', m[1]);
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return q1('SELECT id, username FROM admin_users WHERE id=?', s.user_id);
}

/* ============================== routes ============================== */

const routes = [];
const route = (method, pattern, handler, admin = false) => routes.push({ method, pattern, handler, admin });

/* ---- public ---- */

route('GET', /^\/api\/config$/, async (req, res) => {
  ok(res, {
    ok: true,
    shop: {
      name: await getSetting('shop_name'), whatsapp: await getSetting('shop_whatsapp'),
      address: await getSetting('shop_address'),
    },
    dev_otp: (await getSetting('dev_otp')) === '1',
    currency: 'PKR',
  });
});

route('GET', /^\/api\/services$/, async (req, res) => {
  const cats = await q('SELECT id,slug,name_ur,name_en,icon,estimated_minutes FROM categories WHERE active=1 ORDER BY sort_order ASC');
  const fields = await q('SELECT * FROM fields WHERE active=1 ORDER BY category_id, sort_order ASC');
  ok(res, {
    ok: true,
    categories: cats.map(c => ({
      ...c,
      fields: fields.filter(f => f.category_id === c.id).map(f => ({
        field_key: f.field_key, label_ur: f.label_ur, field_type: f.field_type,
        options: JSON.parse(f.options || '[]'), required: !!f.required,
        placeholder_ur: f.placeholder_ur, validation: JSON.parse(f.validation || '{}'),
      })),
    })),
  });
});

route('POST', /^\/api\/price\/quote$/, async (req, res) => {
  const body = await readJSON(req);
  const found = await getCategoryWithFields(Number(body.category_id));
  if (!found) return bad(res, 'Service durust select karein.');
  const { errors, clean } = validateInputs(found.fields, body.inputs || {});
  if (errors.length) return send(res, 400, { ok: false, error: errors[0], errors });
  const price = await calculatePrice(found.cat.id, clean);
  ok(res, { ok: true, ...price, estimated_minutes: found.cat.estimated_minutes, service_name: found.cat.name_ur });
});

route('POST', /^\/api\/otp\/send$/, async (req, res) => {
  const body = await readJSON(req);
  const mobile = normalizeMobile(body.mobile);
  if (!mobile) return bad(res, 'Sahi mobile number likhein (masalan 03001234567).');
  const recent = await q1("SELECT COUNT(*) AS c FROM otps WHERE mobile=? AND expires_at > datetime('now')", mobile);
  if (Number(recent.c) >= 5) return bad(res, 'Bohat zyada codes bhej diye. Thori der baad koshish karein.', 429);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await run('INSERT INTO otps(mobile,code,expires_at) VALUES(?,?,?)', mobile, code, exp);
  await run("DELETE FROM otps WHERE expires_at < datetime('now')");
  if ((await getSetting('dev_otp')) === '1') {
    return ok(res, {
      ok: true, dev_mode: true, dev_code: code,
      message: 'DEVELOPMENT MODE: asal SMS nahi bheja gaya. Neeche code istemal karein.',
    });
  }
  return bad(res, 'SMS provider configured nahi hai. Dukan se rabta karein.', 503);
});

route('POST', /^\/api\/otp\/verify$/, async (req, res) => {
  const body = await readJSON(req);
  const mobile = normalizeMobile(body.mobile);
  if (!mobile) return bad(res, 'Sahi mobile number likhein.');
  const otp = await q1('SELECT * FROM otps WHERE mobile=? ORDER BY id DESC LIMIT 1', mobile);
  if (!otp || new Date(otp.expires_at) < new Date()) return bad(res, 'Code ki muddat khatam ho gayi. Dobara bhejein.');
  if (Number(otp.attempts) >= 5) return bad(res, 'Bohat ghalat koshishein. Dobara code bhejein.');
  if (otp.code !== String(body.code || '').trim()) {
    await run('UPDATE otps SET attempts=attempts+1 WHERE id=?', otp.id);
    return bad(res, 'Ghalat code. Dobara likhein.');
  }
  const token = randomBytes(24).toString('hex');
  const exp = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await run('INSERT INTO verified_mobiles(token,mobile,expires_at) VALUES(?,?,?)', token, mobile, exp);
  await run('DELETE FROM otps WHERE mobile=?', mobile);
  ok(res, { ok: true, verified_token: token });
});

route('POST', /^\/api\/orders$/, async (req, res) => {
  let body;
  try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  try {
    const name = String(body.customer?.name || '').trim();
    if (name.length < 3) return bad(res, 'Apna poora naam likhein.');
    const mobile = normalizeMobile(body.customer?.mobile);
    if (!mobile) return bad(res, 'Sahi mobile number likhein.');
    const email = String(body.customer?.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Email durust likhein ya khaali chhorein.');
    const vt = String(body.verified_token || '');
    const vm = vt ? await q1('SELECT * FROM verified_mobiles WHERE token=?', vt) : null;
    if (!vm || vm.mobile !== mobile || new Date(vm.expires_at) < new Date()) {
      return bad(res, 'Mobile verify nahi hua. Pehle OTP se verify karein.', 403);
    }
    if (body.agree !== true) return bad(res, 'Price manzoor karne ke liye checkbox tick karein.');
    const result = await createOrder({
      customer: { name, mobile, email },
      category_id: Number(body.category_id),
      inputs: body.inputs || {},
      files: body.files || [],
      source: 'online',
      idemKey: String(body.idempotency_key || ''),
      otpVerified: true,
    });
    ok(res, { ok: true, ...result });
  } catch (e) {
    if (e.details) return send(res, e.status || 400, { ok: false, error: e.message, errors: e.details });
    return bad(res, e.message || 'Order nahi ban saka. Dobara koshish karein.', e.status || 500);
  }
});

route('GET', /^\/api\/order\/([a-f0-9]{32})$/, async (req, res, m) => {
  const row = await q1('SELECT * FROM orders WHERE secure_ref=?', m[1]);
  if (!row) return bad(res, 'Order nahi mila.', 404);
  ok(res, { ok: true, order: await rowToPublic(row, true) });
});

route('POST', /^\/api\/order\/([a-f0-9]{32})\/approve-quote$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const row = await q1('SELECT * FROM orders WHERE secure_ref=?', m[1]);
  if (!row) return bad(res, 'Order nahi mila.', 404);
  if (row.status !== 'quote_sent') return bad(res, 'Is order par koi quote approval ke liye nahi hai.');
  if (body.agree !== true) return bad(res, 'Quote manzoor karne ke liye checkbox tick karein.');
  const tokenNo = await allocTokenNo();
  const qc = await q1(`SELECT COUNT(*) AS c FROM orders WHERE shop_id=1 AND status IN (?,?,?)`, ...ACTIVE_STATUSES);
  const ts = nowISO();
  const checkinHours = toNum(await getSetting('checkin_hours') || 48);
  const r = await run(`UPDATE orders SET status='confirmed', token_no=?, total_price=quoted_total,
    price_breakdown=?, confirmed_at=?, queue_position=?,
    checkin_deadline=?, updated_at=? WHERE id=? AND status='quote_sent'`,
    tokenNo, JSON.stringify([{ label: 'Dukan ka quote', detail: row.quote_note || '', amount: row.quoted_total }]),
    ts, Number(qc.c) + 1, new Date(Date.now() + checkinHours * 3600 * 1000).toISOString(), ts, row.id);
  if (r.changes === 0) {
    const cur = await q1('SELECT * FROM orders WHERE id=?', row.id);
    return ok(res, { ok: true, order: await rowToPublic(cur, true) });
  }
  const updated = await q1('SELECT * FROM orders WHERE id=?', row.id);
  ok(res, { ok: true, order: await rowToPublic(updated, true) });
});

route('POST', /^\/api\/orders\/lookup$/, async (req, res) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const mobile = normalizeMobile(body.mobile);
  if (!mobile || !body.token_no) return bad(res, 'Token number aur mobile number dono likhein.');
  const row = await q1('SELECT secure_ref FROM orders WHERE token_no=? AND customer_mobile=?', String(body.token_no).trim(), mobile);
  if (!row) return bad(res, 'Koi order nahi mila. Token aur number check karein.', 404);
  ok(res, { ok: true, secure_ref: row.secure_ref });
});

/* ---- admin ---- */

route('POST', /^\/api\/admin\/login$/, async (req, res) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const u = await q1('SELECT * FROM admin_users WHERE username=?', String(body.username || ''));
  if (!u || !verifyPassword(String(body.password || ''), u.pass_hash)) {
    return bad(res, 'Username ya password ghalat hai.', 401);
  }
  const token = randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  await run('INSERT INTO admin_sessions(token,user_id,expires_at) VALUES(?,?,?)', token, u.id, exp);
  ok(res, { ok: true, token, username: u.username });
});

route('POST', /^\/api\/admin\/change-password$/, async (req, res) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const admin = await adminFromReq(req);
  const u = await q1('SELECT * FROM admin_users WHERE id=?', admin.id);
  if (!verifyPassword(String(body.old_password || ''), u.pass_hash)) return bad(res, 'Purana password ghalat hai.', 403);
  if (String(body.new_password || '').length < 6) return bad(res, 'Naya password kam az kam 6 harf ka ho.');
  await run('UPDATE admin_users SET pass_hash=? WHERE id=?', hashPasswordNew(String(body.new_password)), admin.id);
  await run('DELETE FROM admin_sessions WHERE user_id=?', admin.id);
  ok(res, { ok: true, message: 'Password badal gaya. Dobara login karein.' });
}, true);

route('GET', /^\/api\/admin\/orders$/, async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const status = url.searchParams.get('status') || '';
  const qq = (url.searchParams.get('q') || '').trim();
  let sql = `SELECT o.*, c.name_ur AS service_name, c.icon AS service_icon FROM orders o LEFT JOIN categories c ON c.id=o.category_id WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND o.status=?'; args.push(status); }
  if (qq) { sql += ' AND (o.token_no LIKE ? OR o.customer_mobile LIKE ? OR o.customer_name LIKE ?)'; args.push(`%${qq}%`, `%${qq}%`, `%${qq}%`); }
  sql += ' ORDER BY o.created_at DESC LIMIT 200';
  const rows = await q(sql, ...args);
  const orders = [];
  for (const r of rows) {
    const p = await rowToPublic(r);
    orders.push({ ...p, id: r.id, customer_mobile: r.customer_mobile, source: r.source, otp_verified: !!r.otp_verified, admin_note: r.admin_note });
  }
  ok(res, { ok: true, orders });
}, true);

route('GET', /^\/api\/admin\/order\/(\d+)$/, async (req, res, m) => {
  const row = await q1(`SELECT o.*, c.name_ur AS service_name FROM orders o LEFT JOIN categories c ON c.id=o.category_id WHERE o.id=?`, m[1]);
  if (!row) return bad(res, 'Order nahi mila.', 404);
  const fieldLabels = {};
  for (const f of await q('SELECT field_key,label_ur FROM fields WHERE category_id=?', row.category_id)) fieldLabels[f.field_key] = f.label_ur;
  const fileRows = await q('SELECT idx, name FROM order_files WHERE order_id=? ORDER BY idx ASC', row.id);
  const p = await rowToPublic(row, true);
  ok(res, {
    ok: true,
    order: {
      ...p, id: row.id, customer_mobile: row.customer_mobile, customer_email: row.customer_email,
      source: row.source, otp_verified: !!row.otp_verified, admin_note: row.admin_note,
      files: fileRows.map(f => ({ name: f.name })), details: JSON.parse(row.details || '{}'),
      field_labels: fieldLabels, updated_at: row.updated_at,
    },
  });
}, true);

route('GET', /^\/api\/admin\/order\/(\d+)\/file\/(\d+)$/, async (req, res, m) => {
  const f = await q1('SELECT name, data_b64 FROM order_files WHERE order_id=? AND idx=?', m[1], Number(m[2]));
  if (!f) return bad(res, 'File nahi mili.', 404);
  const data = Buffer.from(f.data_b64, 'base64');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Content-Length': data.length });
  res.end(data);
}, true);

route('PATCH', /^\/api\/admin\/order\/(\d+)$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const row = await q1('SELECT * FROM orders WHERE id=?', m[1]);
  if (!row) return bad(res, 'Order nahi mila.', 404);
  const sets = [], args = [];
  const ts = nowISO();
  if (body.status && STATUS_UR[body.status]) {
    sets.push('status=?'); args.push(body.status);
    if (['ready', 'completed', 'cancelled'].includes(body.status)) sets.push('queue_position=NULL');
  }
  if (body.quoted_total != null) {
    const qq = toNum(body.quoted_total);
    if (qq <= 0) return bad(res, 'Quote ki raqam durust likhein.');
    sets.push('quoted_total=?'); args.push(qq);
    sets.push('quote_note=?'); args.push(String(body.quote_note || '').slice(0, 1000));
    if (row.status === 'quote_required') sets.push("status='quote_sent'");
  }
  if (body.admin_note != null) { sets.push('admin_note=?'); args.push(String(body.admin_note).slice(0, 2000)); }
  if (body.estimated_minutes != null) { sets.push('estimated_minutes=?'); args.push(Math.max(0, Math.round(toNum(body.estimated_minutes)))); }
  if (!sets.length) return bad(res, 'Koi tabdeeli nahi bheji.');
  sets.push('updated_at=?'); args.push(ts); args.push(m[1]);
  await run(`UPDATE orders SET ${sets.join(', ')} WHERE id=?`, ...args);
  ok(res, { ok: true });
}, true);

route('POST', /^\/api\/admin\/orders$/, async (req, res) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  try {
    const name = String(body.customer?.name || '').trim();
    if (name.length < 2) return bad(res, 'Customer ka naam likhein.');
    const mobile = normalizeMobile(body.customer?.mobile);
    if (!mobile) return bad(res, 'Sahi mobile number likhein.');
    const result = await createOrder({
      customer: { name, mobile, email: String(body.customer?.email || '').trim() },
      category_id: Number(body.category_id),
      inputs: body.inputs || {},
      files: [],
      source: 'staff',
      idemKey: String(body.idempotency_key || ''),
      otpVerified: false,
    });
    ok(res, { ok: true, ...result });
  } catch (e) {
    if (e.details) return send(res, e.status || 400, { ok: false, error: e.message, errors: e.details });
    return bad(res, e.message || 'Order nahi ban saka.', e.status || 500);
  }
}, true);

route('GET', /^\/api\/admin\/categories$/, async (req, res) => {
  ok(res, { ok: true, categories: await q('SELECT * FROM categories ORDER BY sort_order ASC') });
}, true);

route('POST', /^\/api\/admin\/categories$/, async (req, res) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  if (!body.name_ur || !body.slug) return bad(res, 'Naam aur slug zaroori hain.');
  try {
    const r = await run('INSERT INTO categories(slug,name_ur,name_en,icon,sort_order,active,estimated_minutes) VALUES(?,?,?,?,?,?,?)',
      String(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, '-'), body.name_ur, body.name_en || body.name_ur,
      body.icon || '🛠️', toNum(body.sort_order) || 99, body.active === false ? 0 : 1, Math.max(5, Math.round(toNum(body.estimated_minutes) || 60)));
    ok(res, { ok: true, id: r.lastId });
  } catch (e) {
    if (isUniqueErr(e)) return bad(res, 'Slug pehle se mojood hai.');
    throw e;
  }
}, true);

route('PUT', /^\/api\/admin\/categories\/(\d+)$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const sets = [], args = [];
  for (const k of ['name_ur', 'name_en', 'icon']) if (body[k] != null) { sets.push(`${k}=?`); args.push(String(body[k]).slice(0, 200)); }
  for (const k of ['sort_order', 'estimated_minutes']) if (body[k] != null) { sets.push(`${k}=?`); args.push(Math.round(toNum(body[k]))); }
  if (body.active != null) { sets.push('active=?'); args.push(body.active ? 1 : 0); }
  if (!sets.length) return bad(res, 'Koi tabdeeli nahi.');
  args.push(m[1]);
  await run(`UPDATE categories SET ${sets.join(', ')} WHERE id=?`, ...args);
  ok(res, { ok: true });
}, true);

route('DELETE', /^\/api\/admin\/categories\/(\d+)$/, async (req, res, m) => {
  const n = await q1('SELECT COUNT(*) AS c FROM orders WHERE category_id=?', m[1]);
  if (Number(n.c) > 0) {
    await run('UPDATE categories SET active=0 WHERE id=?', m[1]);
    return ok(res, { ok: true, message: 'Orders mojood thay, is liye category deactivate kar di (delete nahi).' });
  }
  await run('DELETE FROM categories WHERE id=?', m[1]);
  ok(res, { ok: true });
}, true);

route('GET', /^\/api\/admin\/categories\/(\d+)\/fields$/, async (req, res, m) => {
  ok(res, { ok: true, fields: await q('SELECT * FROM fields WHERE category_id=? ORDER BY sort_order ASC', m[1]) });
}, true);

route('POST', /^\/api\/admin\/categories\/(\d+)\/fields$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  if (!body.field_key || !body.label_ur) return bad(res, 'Field key aur label zaroori hain.');
  const key = String(body.field_key).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  try {
    const r = await run(`INSERT INTO fields(category_id,field_key,label_ur,field_type,options,required,placeholder_ur,validation,sort_order,active)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, m[1], key, body.label_ur, body.field_type || 'text',
      JSON.stringify(body.options || []), body.required ? 1 : 0, body.placeholder_ur || '',
      JSON.stringify(body.validation || {}), toNum(body.sort_order) || 99, body.active === false ? 0 : 1);
    ok(res, { ok: true, id: r.lastId });
  } catch (e) {
    if (isUniqueErr(e)) return bad(res, 'Ye field key pehle se mojood hai.');
    throw e;
  }
}, true);

route('PUT', /^\/api\/admin\/fields\/(\d+)$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const sets = [], args = [];
  for (const k of ['label_ur', 'field_type', 'placeholder_ur']) if (body[k] != null) { sets.push(`${k}=?`); args.push(String(body[k]).slice(0, 500)); }
  if (body.options != null) { sets.push('options=?'); args.push(JSON.stringify(body.options)); }
  if (body.validation != null) { sets.push('validation=?'); args.push(JSON.stringify(body.validation)); }
  if (body.required != null) { sets.push('required=?'); args.push(body.required ? 1 : 0); }
  if (body.active != null) { sets.push('active=?'); args.push(body.active ? 1 : 0); }
  if (body.sort_order != null) { sets.push('sort_order=?'); args.push(Math.round(toNum(body.sort_order))); }
  if (!sets.length) return bad(res, 'Koi tabdeeli nahi.');
  args.push(m[1]);
  await run(`UPDATE fields SET ${sets.join(', ')} WHERE id=?`, ...args);
  ok(res, { ok: true });
}, true);

route('DELETE', /^\/api\/admin\/fields\/(\d+)$/, async (req, res, m) => {
  await run('DELETE FROM fields WHERE id=?', m[1]);
  ok(res, { ok: true });
}, true);

route('GET', /^\/api\/admin\/categories\/(\d+)\/rules$/, async (req, res, m) => {
  const rows = await q('SELECT * FROM pricing_rules WHERE category_id=? ORDER BY sort_order ASC', m[1]);
  ok(res, { ok: true, rules: rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })) });
}, true);

route('POST', /^\/api\/admin\/categories\/(\d+)\/rules$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const types = ['base', 'per_unit', 'per_area', 'option_rate', 'option_charge', 'tier', 'percent', 'minimum', 'fixed', 'manual'];
  if (!types.includes(body.type)) return bad(res, 'Rule type durust nahi.');
  if (!body.label_ur) return bad(res, 'Label zaroori hai.');
  try { JSON.stringify(body.config || {}); } catch { return bad(res, 'Config ghalat hai.'); }
  const r = await run('INSERT INTO pricing_rules(category_id,type,label_ur,config,active,sort_order) VALUES(?,?,?,?,?,?)',
    m[1], body.type, body.label_ur, JSON.stringify(body.config || {}), body.active === false ? 0 : 1, toNum(body.sort_order) || 99);
  ok(res, { ok: true, id: r.lastId });
}, true);

route('PUT', /^\/api\/admin\/rules\/(\d+)$/, async (req, res, m) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const sets = [], args = [];
  if (body.label_ur != null) { sets.push('label_ur=?'); args.push(String(body.label_ur).slice(0, 200)); }
  if (body.type != null) { sets.push('type=?'); args.push(String(body.type)); }
  if (body.config != null) { sets.push('config=?'); args.push(JSON.stringify(body.config)); }
  if (body.active != null) { sets.push('active=?'); args.push(body.active ? 1 : 0); }
  if (body.sort_order != null) { sets.push('sort_order=?'); args.push(Math.round(toNum(body.sort_order))); }
  if (!sets.length) return bad(res, 'Koi tabdeeli nahi.');
  args.push(m[1]);
  await run(`UPDATE pricing_rules SET ${sets.join(', ')} WHERE id=?`, ...args);
  ok(res, { ok: true });
}, true);

route('DELETE', /^\/api\/admin\/rules\/(\d+)$/, async (req, res, m) => {
  await run('DELETE FROM pricing_rules WHERE id=?', m[1]);
  ok(res, { ok: true });
}, true);

route('GET', /^\/api\/admin\/settings$/, async (req, res) => {
  const rows = await q('SELECT key,value FROM settings');
  const o = {}; for (const r of rows) o[r.key] = r.value;
  delete o.seeded;
  ok(res, { ok: true, settings: o });
}, true);

route('PUT', /^\/api\/admin\/settings$/, async (req, res) => {
  let body; try { body = await readJSON(req); } catch (e) { return bad(res, e.message); }
  const allowed = ['shop_name', 'shop_prefix', 'shop_whatsapp', 'shop_address', 'avg_minutes', 'checkin_hours', 'dev_otp', 'sample_prices'];
  for (const k of allowed) if (body[k] != null) await setSetting(k, String(body[k]).slice(0, 500));
  ok(res, { ok: true });
}, true);

/* ============================== static files ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* Embedded public pages — taake Vercel par folder/filesystem ki zaroorat na pade. */
const EMBEDDED_PUBLIC = {"/index.html":"PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InVyIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+U21hcnQgUHJpbnQgU2hvcCDigJQgT25saW5lIE9yZGVyPC90aXRsZT4KPHN0eWxlPgoqe2JveC1zaXppbmc6Ym9yZGVyLWJveDttYXJnaW46MDtwYWRkaW5nOjB9CmJvZHl7Zm9udC1mYW1pbHk6c3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sIlNlZ29lIFVJIixSb2JvdG8sc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiNmNGY2ZmI7Y29sb3I6IzFhMWEyZTttaW4taGVpZ2h0OjEwMHZoO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7cGFkZGluZzoyNHB4fQouY2FyZHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyLXJhZGl1czoyMHB4O2JveC1zaGFkb3c6MCAxMHB4IDQwcHggcmdiYSgwLDAsMCwuMDgpO21heC13aWR0aDo0NDBweDt3aWR0aDoxMDAlO3BhZGRpbmc6MzZweCAyOHB4O3RleHQtYWxpZ246Y2VudGVyfQoubG9nb3tmb250LXNpemU6NTJweDttYXJnaW4tYm90dG9tOjhweH0KaDF7Zm9udC1zaXplOjI2cHg7bWFyZ2luLWJvdHRvbTo2cHh9Ci5zdWJ7Y29sb3I6IzY2Njtmb250LXNpemU6MTVweDttYXJnaW4tYm90dG9tOjI0cHg7bGluZS1oZWlnaHQ6MS42fQouYnRue2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTtwYWRkaW5nOjE2cHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtc2l6ZToxN3B4O2ZvbnQtd2VpZ2h0OjcwMDtib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjttYXJnaW4tYm90dG9tOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9Ci5idG4tcHJpbWFyeXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzRmNDZlNSwjN2MzYWVkKTtjb2xvcjojZmZmfQouYnRuLWdob3N0e2JhY2tncm91bmQ6I2VlZjBmNztjb2xvcjojMzMzfQouYWRkcntmb250LXNpemU6MTNweDtjb2xvcjojODg4O21hcmdpbi10b3A6OHB4fQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJjYXJkIj4KICA8ZGl2IGNsYXNzPSJsb2dvIj7wn5ao77iPPC9kaXY+CiAgPGgxIGlkPSJzaG9wTmFtZSI+U21hcnQgUHJpbnQgU2hvcDwvaDE+CiAgPHAgY2xhc3M9InN1YiI+UHJpbnRpbmcsIGNvbXBvc2luZywgdmlzaXRpbmcgY2FyZHMsIHBhbmFmbGV4IGF1ciB0YW1hbSBkb2N1bWVudCBzZXJ2aWNlcyDigJQgYWIgb25saW5lIG9yZGVyIGthcmVpbiBhdXIgdG9rZW4gaGFzaWwga2FyZWluLjwvcD4KICA8YSBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBocmVmPSIvYm9vayI+8J+TnSBPbmxpbmUgT3JkZXIgS2FyZWluPC9hPgogIDxhIGNsYXNzPSJidG4gYnRuLWdob3N0IiBocmVmPSIvc3RhdHVzIj7wn5SNIE9yZGVyIFN0YXR1cyBEZWtoZWluPC9hPgogIDxwIGNsYXNzPSJhZGRyIiBpZD0ic2hvcEFkZHIiPjwvcD4KPC9kaXY+CjxzY3JpcHQ+CmZldGNoKCcvYXBpL2NvbmZpZycpLnRoZW4ocj0+ci5qc29uKCkpLnRoZW4oYz0+ewogIGlmKGMuc2hvcCl7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzaG9wTmFtZScpLnRleHRDb250ZW50PWMuc2hvcC5uYW1lfHwnU21hcnQgUHJpbnQgU2hvcCc7CiAgICBpZihjLnNob3AuYWRkcmVzcykgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nob3BBZGRyJykudGV4dENvbnRlbnQ9Yy5zaG9wLmFkZHJlc3M7IH0KfSk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K","/book.html":"PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InVyIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+T25saW5lIE9yZGVyIOKAlCBTbWFydCBQcmludCBTaG9wPC90aXRsZT4KPHN0eWxlPgoqe2JveC1zaXppbmc6Ym9yZGVyLWJveDttYXJnaW46MDtwYWRkaW5nOjB9CmJvZHl7Zm9udC1mYW1pbHk6c3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sIlNlZ29lIFVJIixSb2JvdG8sc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiNmNGY2ZmI7Y29sb3I6IzFhMWEyZTttaW4taGVpZ2h0OjEwMHZofQpoZWFkZXJ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM0ZjQ2ZTUsIzdjM2FlZCk7Y29sb3I6I2ZmZjtwYWRkaW5nOjE4cHggMTZweDt0ZXh0LWFsaWduOmNlbnRlcjtwb3NpdGlvbjpzdGlja3k7dG9wOjA7ei1pbmRleDoxMH0KaGVhZGVyIGgxe2ZvbnQtc2l6ZToyMHB4fQpoZWFkZXIgcHtmb250LXNpemU6MTNweDtvcGFjaXR5Oi45O21hcmdpbi10b3A6MnB4fQouc3RlcHN7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjZweDtwYWRkaW5nOjEycHg7YmFja2dyb3VuZDojZmZmO2JvcmRlci1ib3R0b206MXB4IHNvbGlkICNlZWU7cG9zaXRpb246c3RpY2t5O3RvcDo2NHB4O3otaW5kZXg6OX0KLnN0ZXAtZG90e3dpZHRoOjM0cHg7aGVpZ2h0OjhweDtib3JkZXItcmFkaXVzOjRweDtiYWNrZ3JvdW5kOiNlMGUwZTB9Ci5zdGVwLWRvdC5vbntiYWNrZ3JvdW5kOiM3YzNhZWR9Cm1haW57bWF4LXdpZHRoOjU2MHB4O21hcmdpbjowIGF1dG87cGFkZGluZzoxOHB4IDE0cHggOTBweH0KLmNhcmR7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTZweDtib3gtc2hhZG93OjAgNHB4IDE4cHggcmdiYSgwLDAsMCwuMDYpO3BhZGRpbmc6MjBweDttYXJnaW4tYm90dG9tOjE0cHh9Cmgye2ZvbnQtc2l6ZToxOXB4O21hcmdpbi1ib3R0b206NHB4fQouaGludHtmb250LXNpemU6MTMuNXB4O2NvbG9yOiM2NjY7bWFyZ2luLWJvdHRvbToxNHB4O2xpbmUtaGVpZ2h0OjEuNn0KbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXdlaWdodDo2MDA7Zm9udC1zaXplOjE0LjVweDttYXJnaW46MTRweCAwIDZweH0KLnJlcXtjb2xvcjojZDMzfQppbnB1dFt0eXBlPXRleHRdLGlucHV0W3R5cGU9dGVsXSxpbnB1dFt0eXBlPWVtYWlsXSxpbnB1dFt0eXBlPW51bWJlcl0sc2VsZWN0LHRleHRhcmVhe3dpZHRoOjEwMCU7cGFkZGluZzoxM3B4IDEycHg7Ym9yZGVyOjJweCBzb2xpZCAjZTNlNmYwO2JvcmRlci1yYWRpdXM6MTJweDtmb250LXNpemU6MTZweDtiYWNrZ3JvdW5kOiNmYWZiZmZ9CmlucHV0OmZvY3VzLHNlbGVjdDpmb2N1cyx0ZXh0YXJlYTpmb2N1c3tvdXRsaW5lOm5vbmU7Ym9yZGVyLWNvbG9yOiM3YzNhZWQ7YmFja2dyb3VuZDojZmZmfQp0ZXh0YXJlYXttaW4taGVpZ2h0OjkwcHg7cmVzaXplOnZlcnRpY2FsfQoucmFkaW8tcm93e2Rpc3BsYXk6ZmxleDtnYXA6MTBweDtmbGV4LXdyYXA6d3JhcH0KLnJhZGlvLXBpbGx7ZmxleDoxO21pbi13aWR0aDoxMjBweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjEzcHg7Ym9yZGVyOjJweCBzb2xpZCAjZTNlNmYwO2JvcmRlci1yYWRpdXM6MTJweDtjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTVweDtiYWNrZ3JvdW5kOiNmYWZiZmZ9Ci5yYWRpby1waWxsLnNlbHtib3JkZXItY29sb3I6IzdjM2FlZDtiYWNrZ3JvdW5kOiNmM2VmZmY7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiM1YjIxYjZ9Ci5idG57ZGlzcGxheTpibG9jazt3aWR0aDoxMDAlO3BhZGRpbmc6MTZweDtib3JkZXItcmFkaXVzOjE0cHg7Zm9udC1zaXplOjE3cHg7Zm9udC13ZWlnaHQ6NzAwO2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO21hcmdpbi10b3A6MTZweH0KLmJ0bi1wcmltYXJ5e2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjNGY0NmU1LCM3YzNhZWQpO2NvbG9yOiNmZmZ9Ci5idG4tcHJpbWFyeTpkaXNhYmxlZHtvcGFjaXR5Oi41NTtjdXJzb3I6bm90LWFsbG93ZWR9Ci5idG4tZ2hvc3R7YmFja2dyb3VuZDojZWVmMGY3O2NvbG9yOiMzMzM7bWFyZ2luLXRvcDoxMHB4fQouYnRuLWdyZWVue2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMDU5NjY5LCMxMGI5ODEpO2NvbG9yOiNmZmZ9Ci5lcnJ7YmFja2dyb3VuZDojZmRlOGU4O2NvbG9yOiNiOTFjMWM7Ym9yZGVyOjFweCBzb2xpZCAjZjVjMmMyO3BhZGRpbmc6MTJweDtib3JkZXItcmFkaXVzOjEycHg7Zm9udC1zaXplOjE0LjVweDttYXJnaW4tYm90dG9tOjEycHg7bGluZS1oZWlnaHQ6MS41fQoub2ttc2d7YmFja2dyb3VuZDojZTZmOWYwO2NvbG9yOiMwNDc4NTc7Ym9yZGVyOjFweCBzb2xpZCAjYjdlOGNkO3BhZGRpbmc6MTJweDtib3JkZXItcmFkaXVzOjEycHg7Zm9udC1zaXplOjE0LjVweDttYXJnaW4tYm90dG9tOjEycHg7bGluZS1oZWlnaHQ6MS41fQouZGV2Ym94e2JhY2tncm91bmQ6I2ZmZjdkNjtib3JkZXI6MnB4IGRhc2hlZCAjZDRhMDE3O3BhZGRpbmc6MTRweDtib3JkZXItcmFkaXVzOjEycHg7bWFyZ2luOjEycHggMDtmb250LXNpemU6MTQuNXB4O2xpbmUtaGVpZ2h0OjEuNn0KLmRldmJveCBie2ZvbnQtc2l6ZToyMnB4O2xldHRlci1zcGFjaW5nOjRweH0KLnN2Yy1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtnYXA6MTBweH0KLnN2Y3tib3JkZXI6MnB4IHNvbGlkICNlM2U2ZjA7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MThweCAxMHB4O3RleHQtYWxpZ246Y2VudGVyO2N1cnNvcjpwb2ludGVyO2JhY2tncm91bmQ6I2ZhZmJmZn0KLnN2Yy5zZWx7Ym9yZGVyLWNvbG9yOiM3YzNhZWQ7YmFja2dyb3VuZDojZjNlZmZmfQouc3ZjIC5pY3tmb250LXNpemU6MzRweH0KLnN2YyAubm17Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxNHB4O21hcmdpbi10b3A6NnB4fQoucWxpbmV7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTBweCAycHg7Ym9yZGVyLWJvdHRvbToxcHggZGFzaGVkICNlNWU1ZTU7Zm9udC1zaXplOjE1cHh9Ci5xbGluZSAuZHtjb2xvcjojNzc3O2ZvbnQtc2l6ZToxM3B4fQoucXRvdGFse2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjE0cHggMnB4O2ZvbnQtc2l6ZToxOXB4O2ZvbnQtd2VpZ2h0OjgwMH0KLmFwcHJvdmV7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7YmFja2dyb3VuZDojZjNlZmZmO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjE0cHg7bWFyZ2luLXRvcDoxMnB4O2ZvbnQtc2l6ZToxNC41cHg7bGluZS1oZWlnaHQ6MS42fQouYXBwcm92ZSBpbnB1dHt3aWR0aDoyMnB4O2hlaWdodDoyMnB4O21hcmdpbi10b3A6MnB4O2FjY2VudC1jb2xvcjojN2MzYWVkO2ZsZXgtc2hyaW5rOjB9Ci50b2tlbi1iaWd7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM0ZjQ2ZTUsIzdjM2FlZCk7Y29sb3I6I2ZmZjtib3JkZXItcmFkaXVzOjIwcHg7cGFkZGluZzoyOHB4IDIwcHg7dGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLWJvdHRvbToxNHB4fQoudG9rZW4tYmlnIC50e2ZvbnQtc2l6ZToxM3B4O29wYWNpdHk6Ljg1fQoudG9rZW4tYmlnIC5ue2ZvbnQtc2l6ZTo0MHB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzoycHg7bWFyZ2luOjhweCAwfQoua3Z7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6OXB4IDJweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCAjZjBmMGYwO2ZvbnQtc2l6ZToxNC41cHh9Ci5rdiBie3RleHQtYWxpZ246cmlnaHR9Ci5zdGF0dXMtcGlsbHtkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjZweCAxNHB4O2JvcmRlci1yYWRpdXM6MjBweDtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE0cHg7YmFja2dyb3VuZDojZTBlN2ZmO2NvbG9yOiMzNzMwYTN9Ci5maWxlbGlzdHtmb250LXNpemU6MTNweDtjb2xvcjojNTU1O21hcmdpbi10b3A6NnB4fQouaGlkZGVue2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9Ci5zcGlue2Rpc3BsYXk6aW5saW5lLWJsb2NrO3dpZHRoOjE4cHg7aGVpZ2h0OjE4cHg7Ym9yZGVyOjNweCBzb2xpZCAjZmZmO2JvcmRlci10b3AtY29sb3I6dHJhbnNwYXJlbnQ7Ym9yZGVyLXJhZGl1czo1MCU7YW5pbWF0aW9uOnNwIDAuOHMgbGluZWFyIGluZmluaXRlO3ZlcnRpY2FsLWFsaWduOi0zcHg7bWFyZ2luLXJpZ2h0OjhweH0KQGtleWZyYW1lcyBzcHt0b3t0cmFuc2Zvcm06cm90YXRlKDM2MGRlZyl9fQpAbWVkaWEgcHJpbnR7CiAgYm9keXtiYWNrZ3JvdW5kOiNmZmZ9IGhlYWRlciwuc3RlcHMsLm5vcHJpbnR7ZGlzcGxheTpub25lIWltcG9ydGFudH0KICBtYWlue3BhZGRpbmc6MH0gLmNhcmR7Ym94LXNoYWRvdzpub25lfQogICNwcmludFRva2Vue2Rpc3BsYXk6YmxvY2shaW1wb3J0YW50fQp9CiNwcmludFRva2Vue2Rpc3BsYXk6bm9uZX0KLnB0b2tlbntib3JkZXI6M3B4IHNvbGlkICM0ZjQ2ZTU7Ym9yZGVyLXJhZGl1czoxOHB4O3BhZGRpbmc6MjhweDttYXgtd2lkdGg6NDgwcHg7bWFyZ2luOjAgYXV0bzt0ZXh0LWFsaWduOmNlbnRlcn0KLnB0b2tlbiBoMXtmb250LXNpemU6MjJweH0ucHRva2VuIC50bntmb250LXNpemU6NDRweDtmb250LXdlaWdodDo4MDA7bGV0dGVyLXNwYWNpbmc6MnB4O21hcmdpbjoxMHB4IDB9Ci5wdGFibGV7d2lkdGg6MTAwJTtmb250LXNpemU6MTRweDttYXJnaW4tdG9wOjEycHg7dGV4dC1hbGlnbjpsZWZ0fQoucHRhYmxlIHRke3BhZGRpbmc6NnB4IDRweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCAjZWVlfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8aGVhZGVyPgogIDxoMSBpZD0ic2hvcE5hbWUiPvCflqjvuI8gU21hcnQgUHJpbnQgU2hvcDwvaDE+CiAgPHA+T25saW5lIG9yZGVyIGthcmVpbiDigJQgdG9rZW4gdHVyYW50IGhhc2lsIGthcmVpbjwvcD4KPC9oZWFkZXI+CjxkaXYgY2xhc3M9InN0ZXBzIiBpZD0ic3RlcEJhciI+CiAgPGRpdiBjbGFzcz0ic3RlcC1kb3Qgb24iPjwvZGl2PjxkaXYgY2xhc3M9InN0ZXAtZG90Ij48L2Rpdj48ZGl2IGNsYXNzPSJzdGVwLWRvdCI+PC9kaXY+PGRpdiBjbGFzcz0ic3RlcC1kb3QiPjwvZGl2PjxkaXYgY2xhc3M9InN0ZXAtZG90Ij48L2Rpdj4KPC9kaXY+CjxtYWluIGlkPSJhcHAiPjwvbWFpbj4KCjxkaXYgaWQ9InByaW50VG9rZW4iPgogIDxkaXYgY2xhc3M9InB0b2tlbiIgaWQ9InByaW50Qm9keSI+PC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KY29uc3QgJD1zPT5kb2N1bWVudC5xdWVyeVNlbGVjdG9yKHMpOwpjb25zdCBzdGF0ZT17c3RlcDowLHNob3A6e30sY2F0czpbXSxjYXQ6bnVsbCxpbnB1dHM6e30sZmlsZXM6e30sbmFtZTonJyxtb2JpbGU6JycsZW1haWw6JycsdmVyaWZpZWRUb2tlbjonJyxxdW90ZTpudWxsLG9yZGVyOm51bGwsaWRlbUtleTonJyxzdGFmZjpsb2NhdGlvbi5zZWFyY2guaW5jbHVkZXMoJ3NvdXJjZT1zdGFmZicpfTsKY29uc3QgZXNjPXM9PlN0cmluZyhzPz8nJykucmVwbGFjZSgvWyY8PiInXS9nLGM9Pih7JyYnOicmYW1wOycsJzwnOicmbHQ7JywnPic6JyZndDsnLCciJzonJnF1b3Q7JywiJyI6JyYjMzk7J31bY10pKTsKCmZ1bmN0aW9uIHNldFN0ZXAobil7c3RhdGUuc3RlcD1uO2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zdGVwLWRvdCcpLmZvckVhY2goKGQsaSk9PmQuY2xhc3NMaXN0LnRvZ2dsZSgnb24nLGk8PW4pKTt3aW5kb3cuc2Nyb2xsVG8oMCwwKTt9CmZ1bmN0aW9uIGVyckJveChtc2dzKXtyZXR1cm4gYDxkaXYgY2xhc3M9ImVyciI+JHsoQXJyYXkuaXNBcnJheShtc2dzKT9tc2dzOlttc2dzXSkubWFwKGVzYykuam9pbignPGJyPicpfTwvZGl2PmA7fQoKYXN5bmMgZnVuY3Rpb24gaW5pdCgpewogIGNvbnN0IGM9YXdhaXQgKGF3YWl0IGZldGNoKCcvYXBpL2NvbmZpZycpKS5qc29uKCk7CiAgaWYoYy5vayl7c3RhdGUuc2hvcD1jLnNob3A7JCgnI3Nob3BOYW1lJykudGV4dENvbnRlbnQ9J/CflqjvuI8gJysoYy5zaG9wLm5hbWV8fCdTbWFydCBQcmludCBTaG9wJyk7fQogIGNvbnN0IHM9YXdhaXQgKGF3YWl0IGZldGNoKCcvYXBpL3NlcnZpY2VzJykpLmpzb24oKTsKICBpZihzLm9rKXN0YXRlLmNhdHM9cy5jYXRlZ29yaWVzOwogIHJlbmRlcldlbGNvbWUoKTsKfQoKLyogLS0tLS0tLS0tLSBTVEVQIDA6IHdlbGNvbWUgLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiByZW5kZXJXZWxjb21lKCl7CiAgc2V0U3RlcCgwKTsKICAkKCcjYXBwJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXIiPgogICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjU2cHgiPvCflqjvuI88L2Rpdj4KICAgIDxoMj5LaHVzaCBBYW1kZWVkITwvaDI+CiAgICA8cCBjbGFzcz0iaGludCI+JHtlc2Moc3RhdGUuc2hvcC5uYW1lfHwnU21hcnQgUHJpbnQgU2hvcCcpfSBtZWluIG9ubGluZSBvcmRlciBrYXJlaW4uPGJyPgogICAgQXBuYSBrYWFtIHNlbGVjdCBrYXJlaW4sIHByaWNlIGRla2hlaW4sIG1hbnpvb3Iga2FyZWluIOKAlCBhdXIgPGI+dG9rZW48L2I+IGhhc2lsIGthcmVpbi48YnI+PGJyPgogICAgS29pIGFwcCBpbnN0YWxsIGthcm5lIGtpIHphcm9vcmF0IG5haGkuPC9wPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBvbmNsaWNrPSJyZW5kZXJEZXRhaWxzKCkiPk9yZGVyIFNodXJ1IEthcmVpbiDihpI8L2J1dHRvbj4KICA8L2Rpdj5gOwp9CgovKiAtLS0tLS0tLS0tIFNURVAgMTogY3VzdG9tZXIgZGV0YWlscyArIE9UUCAtLS0tLS0tLS0tICovCmZ1bmN0aW9uIHJlbmRlckRldGFpbHMoKXsKICBzZXRTdGVwKDEpOwogICQoJyNhcHAnKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGgyPkFwbmkgRGV0YWlscyBEYXJqIEthcmVpbjwvaDI+CiAgICA8cCBjbGFzcz0iaGludCI+T3JkZXIgY29uZmlybSBrYXJuZSBrZSBsaXllIG1vYmlsZSBudW1iZXIgdmVyaWZ5IGthcm5hIHphcm9vcmkgaGFpLjwvcD4KICAgIDxkaXYgaWQ9ImRFcnIiPjwvZGl2PgogICAgPGxhYmVsPkFwbmEgbmFhbSA8c3BhbiBjbGFzcz0icmVxIj4qPC9zcGFuPjwvbGFiZWw+CiAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImZOYW1lIiBwbGFjZWhvbGRlcj0iTWFzYWxhbjogQWxpIFJhemEiIHZhbHVlPSIke2VzYyhzdGF0ZS5uYW1lKX0iPgogICAgPGxhYmVsPk1vYmlsZSBudW1iZXIgPHNwYW4gY2xhc3M9InJlcSI+Kjwvc3Bhbj48L2xhYmVsPgogICAgPGlucHV0IHR5cGU9InRlbCIgaWQ9ImZNb2JpbGUiIHBsYWNlaG9sZGVyPSIwMzAwMTIzNDU2NyIgaW5wdXRtb2RlPSJudW1lcmljIiB2YWx1ZT0iJHtlc2Moc3RhdGUubW9iaWxlKX0iPgogICAgPGxhYmVsPkVtYWlsIChvcHRpb25hbCk8L2xhYmVsPgogICAgPGlucHV0IHR5cGU9ImVtYWlsIiBpZD0iZkVtYWlsIiBwbGFjZWhvbGRlcj0iYWFwQGVtYWlsLmNvbSIgdmFsdWU9IiR7ZXNjKHN0YXRlLmVtYWlsKX0iPgogICAgPGRpdiBpZD0ib3RwWm9uZSIgY2xhc3M9ImhpZGRlbiI+CiAgICAgIDxsYWJlbD5PVFAgQ29kZSA8c3BhbiBjbGFzcz0icmVxIj4qPC9zcGFuPjwvbGFiZWw+CiAgICAgIDxpbnB1dCB0eXBlPSJ0ZWwiIGlkPSJmT3RwIiBwbGFjZWhvbGRlcj0iNiBoYXJmIGthIGNvZGUiIGlucHV0bW9kZT0ibnVtZXJpYyIgbWF4bGVuZ3RoPSI2Ij4KICAgICAgPGRpdiBpZD0iZGV2Qm94Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBpZD0iYnRuT3RwIiBvbmNsaWNrPSJzZW5kT3RwKCkiPk9UUCBCaGVqZWluPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdyZWVuIGhpZGRlbiIgaWQ9ImJ0blZlcmlmeSIgb25jbGljaz0idmVyaWZ5T3RwKCkiPlZlcmlmeSBLYXJlaW48L2J1dHRvbj4KICA8L2Rpdj5gOwogIGlmKHN0YXRlLnN0YWZmKXsKICAgICQoJyNvdHBab25lJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7CiAgICAkKCcjYnRuT3RwJykub3V0ZXJIVE1MPWA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiIG9uY2xpY2s9InN0YWZmTmV4dCgpIj5BYWdlIEJhcmhlaW4g4oaSPC9idXR0b24+YDsKICB9Cn0KZnVuY3Rpb24gc3RhZmZOZXh0KCl7CiAgY29uc3Qgbj0kKCcjZk5hbWUnKS52YWx1ZS50cmltKCksbT0kKCcjZk1vYmlsZScpLnZhbHVlLnRyaW0oKTsKICBpZihuLmxlbmd0aDwyKXskKCcjZEVycicpLmlubmVySFRNTD1lcnJCb3goJ0N1c3RvbWVyIGthIG5hYW0gbGlraGVpbi4nKTtyZXR1cm47fQogIGlmKCEvXjA/M1xkezl9JC8udGVzdChtLnJlcGxhY2UoL1xEL2csJycpKSl7JCgnI2RFcnInKS5pbm5lckhUTUw9ZXJyQm94KCdTYWhpIG1vYmlsZSBudW1iZXIgbGlraGVpbi4nKTtyZXR1cm47fQogIHN0YXRlLm5hbWU9bjtzdGF0ZS5tb2JpbGU9bTtzdGF0ZS5lbWFpbD0kKCcjZkVtYWlsJykudmFsdWUudHJpbSgpOwogIHJlbmRlclNlcnZpY2VzKCk7Cn0KYXN5bmMgZnVuY3Rpb24gc2VuZE90cCgpewogIGNvbnN0IG49JCgnI2ZOYW1lJykudmFsdWUudHJpbSgpLG09JCgnI2ZNb2JpbGUnKS52YWx1ZS50cmltKCksZT0kKCcjZkVtYWlsJykudmFsdWUudHJpbSgpOwogIGlmKG4ubGVuZ3RoPDMpeyQoJyNkRXJyJykuaW5uZXJIVE1MPWVyckJveCgnQXBuYSBwb29yYSBuYWFtIGxpa2hlaW4uJyk7cmV0dXJuO30KICBpZihlJiYhL15bXlxzQF0rQFteXHNAXStcLlteXHNAXSskLy50ZXN0KGUpKXskKCcjZEVycicpLmlubmVySFRNTD1lcnJCb3goJ0VtYWlsIGR1cnVzdCBsaWtoZWluIHlhIGtoYWFsaSBjaGhvcmVpbi4nKTtyZXR1cm47fQogIGNvbnN0IGJ0bj0kKCcjYnRuT3RwJyk7YnRuLmRpc2FibGVkPXRydWU7YnRuLmlubmVySFRNTD0nPHNwYW4gY2xhc3M9InNwaW4iPjwvc3Bhbj5CaGVqIHJhaGUgaGFpbi4uLic7CiAgdHJ5ewogICAgY29uc3Qgcj1hd2FpdCAoYXdhaXQgZmV0Y2goJy9hcGkvb3RwL3NlbmQnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sYm9keTpKU09OLnN0cmluZ2lmeSh7bW9iaWxlOm19KX0pKS5qc29uKCk7CiAgICBpZighci5vayl7JCgnI2RFcnInKS5pbm5lckhUTUw9ZXJyQm94KHIuZXJyb3IpO2J0bi5kaXNhYmxlZD1mYWxzZTtidG4udGV4dENvbnRlbnQ9J09UUCBCaGVqZWluJztyZXR1cm47fQogICAgc3RhdGUubmFtZT1uO3N0YXRlLm1vYmlsZT1tO3N0YXRlLmVtYWlsPWU7CiAgICAkKCcjZEVycicpLmlubmVySFRNTD0nJzsKICAgICQoJyNvdHBab25lJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7CiAgICBidG4uY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7JCgnI2J0blZlcmlmeScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogICAgaWYoci5kZXZfbW9kZSl7CiAgICAgICQoJyNkZXZCb3gnKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImRldmJveCI+4pqg77iPIDxiPkRldmVsb3BtZW50IG1vZGU8L2I+IGhhaSDigJQgYXNhbCBTTVMgPHU+bmFoaTwvdT4gYmhlamEgZ2F5YS48YnI+QWFwa2EgY29kZTogPGI+JHtlc2Moci5kZXZfY29kZSl9PC9iPjxicj48YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiIG9uY2xpY2s9ImRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNmT3RwJykudmFsdWU9JyR7ZXNjKHIuZGV2X2NvZGUpfSciPkNvZGUgYmhhciBkZWluPC9idXR0b24+PC9kaXY+YDsKICAgIH0gZWxzZSB7CiAgICAgICQoJyNkZXZCb3gnKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9Im9rbXNnIj7inIUgT1RQIGFhcGtlIG1vYmlsZSBwYXIgYmhlaiBkaXlhIGdheWEgaGFpLjwvZGl2PmA7CiAgICB9CiAgfWNhdGNoeyAkKCcjZEVycicpLmlubmVySFRNTD1lcnJCb3goJ05ldHdvcmsgbWVpbiBtYXNsYS4gRG9iYXJhIGtvc2hpc2gga2FyZWluLicpOyBidG4uZGlzYWJsZWQ9ZmFsc2U7IGJ0bi50ZXh0Q29udGVudD0nT1RQIEJoZWplaW4nOyB9Cn0KYXN5bmMgZnVuY3Rpb24gdmVyaWZ5T3RwKCl7CiAgY29uc3QgY29kZT0kKCcjZk90cCcpLnZhbHVlLnRyaW0oKTsKICBpZihjb2RlLmxlbmd0aCE9PTYpeyQoJyNkRXJyJykuaW5uZXJIVE1MPWVyckJveCgnNiBoYXJmIGthIGNvZGUgbGlraGVpbi4nKTtyZXR1cm47fQogIGNvbnN0IGJ0bj0kKCcjYnRuVmVyaWZ5Jyk7YnRuLmRpc2FibGVkPXRydWU7YnRuLmlubmVySFRNTD0nPHNwYW4gY2xhc3M9InNwaW4iPjwvc3Bhbj5DaGVjayBobyByYWhhIGhhaS4uLic7CiAgY29uc3Qgcj1hd2FpdCAoYXdhaXQgZmV0Y2goJy9hcGkvb3RwL3ZlcmlmeScse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSxib2R5OkpTT04uc3RyaW5naWZ5KHttb2JpbGU6c3RhdGUubW9iaWxlLGNvZGV9KX0pKS5qc29uKCk7CiAgaWYoIXIub2speyQoJyNkRXJyJykuaW5uZXJIVE1MPWVyckJveChyLmVycm9yKTtidG4uZGlzYWJsZWQ9ZmFsc2U7YnRuLnRleHRDb250ZW50PSdWZXJpZnkgS2FyZWluJztyZXR1cm47fQogIHN0YXRlLnZlcmlmaWVkVG9rZW49ci52ZXJpZmllZF90b2tlbjsKICByZW5kZXJTZXJ2aWNlcygpOwp9CgovKiAtLS0tLS0tLS0tIFNURVAgMjogc2VydmljZSBzZWxlY3QgLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiByZW5kZXJTZXJ2aWNlcygpewogIHNldFN0ZXAoMik7CiAgJCgnI2FwcCcpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8aDI+QXBuYSBLYWFtIFNlbGVjdCBLYXJlaW48L2gyPgogICAgPHAgY2xhc3M9ImhpbnQiPkthdW5zaSBzZXJ2aWNlIGNoYWhpeWU/IEVrIHNlbGVjdCBrYXJlaW4uPC9wPgogICAgPGRpdiBjbGFzcz0ic3ZjLWdyaWQiPgogICAgICAke3N0YXRlLmNhdHMubWFwKGM9PmA8ZGl2IGNsYXNzPSJzdmMiIG9uY2xpY2s9InNlbGVjdFNlcnZpY2UoJHtjLmlkfSx0aGlzKSI+PGRpdiBjbGFzcz0iaWMiPiR7ZXNjKGMuaWNvbnx8J/Cfm6DvuI8nKX08L2Rpdj48ZGl2IGNsYXNzPSJubSI+JHtlc2MoYy5uYW1lX3VyKX08L2Rpdj48L2Rpdj5gKS5qb2luKCcnKX0KICAgIDwvZGl2PgogIDwvZGl2PmA7Cn0KZnVuY3Rpb24gc2VsZWN0U2VydmljZShpZCxlbCl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnN2YycpLmZvckVhY2goeD0+eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKSk7CiAgZWwuY2xhc3NMaXN0LmFkZCgnc2VsJyk7CiAgc3RhdGUuY2F0PXN0YXRlLmNhdHMuZmluZChjPT5jLmlkPT09aWQpOwogIHN0YXRlLmlucHV0cz17fTtzdGF0ZS5maWxlcz17fTsKICBzZXRUaW1lb3V0KHJlbmRlckZvcm0sMjUwKTsKfQoKLyogLS0tLS0tLS0tLSBTVEVQIDM6IGR5bmFtaWMgZm9ybSAtLS0tLS0tLS0tICovCmZ1bmN0aW9uIGZpZWxkSFRNTChmKXsKICBjb25zdCByZXE9Zi5yZXF1aXJlZD8nPHNwYW4gY2xhc3M9InJlcSI+Kjwvc3Bhbj4nOicnOwogIGNvbnN0IHY9c3RhdGUuaW5wdXRzW2YuZmllbGRfa2V5XT8/Jyc7CiAgbGV0IGlubmVyPScnOwogIGlmKGYuZmllbGRfdHlwZT09PSd0ZXh0YXJlYScpIGlubmVyPWA8dGV4dGFyZWEgaWQ9ImluXyR7Zi5maWVsZF9rZXl9IiBwbGFjZWhvbGRlcj0iJHtlc2MoZi5wbGFjZWhvbGRlcl91cil9Ij4ke2VzYyh2KX08L3RleHRhcmVhPmA7CiAgZWxzZSBpZihmLmZpZWxkX3R5cGU9PT0nbnVtYmVyJykgaW5uZXI9YDxpbnB1dCB0eXBlPSJudW1iZXIiIGlkPSJpbl8ke2YuZmllbGRfa2V5fSIgdmFsdWU9IiR7ZXNjKHYpfSIgaW5wdXRtb2RlPSJkZWNpbWFsIiBtaW49IiR7Zi52YWxpZGF0aW9uLm1pbj8/Jyd9IiBtYXg9IiR7Zi52YWxpZGF0aW9uLm1heD8/Jyd9Ij5gOwogIGVsc2UgaWYoZi5maWVsZF90eXBlPT09J2ZpbGUnKSBpbm5lcj1gPGlucHV0IHR5cGU9ImZpbGUiIGlkPSJpbl8ke2YuZmllbGRfa2V5fSIgb25jaGFuZ2U9ImZpbGVQaWNrZWQoJyR7Zi5maWVsZF9rZXl9Jyx0aGlzKSI+PGRpdiBjbGFzcz0iZmlsZWxpc3QiIGlkPSJmbF8ke2YuZmllbGRfa2V5fSI+JHtzdGF0ZS5maWxlc1tmLmZpZWxkX2tleV0/KCfinIUgJytlc2Moc3RhdGUuZmlsZXNbZi5maWVsZF9rZXldLm5hbWUpKTonJ308L2Rpdj5gOwogIGVsc2UgaWYoZi5maWVsZF90eXBlPT09J3NlbGVjdCcpIGlubmVyPWA8c2VsZWN0IGlkPSJpbl8ke2YuZmllbGRfa2V5fSI+PG9wdGlvbiB2YWx1ZT0iIj4tLSBTZWxlY3Qga2FyZWluIC0tPC9vcHRpb24+JHtmLm9wdGlvbnMubWFwKG89PmA8b3B0aW9uIHZhbHVlPSIke2VzYyhvLnZhbHVlKX0iICR7dj09PW8udmFsdWU/J3NlbGVjdGVkJzonJ30+JHtlc2Moby5sYWJlbF91cil9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+YDsKICBlbHNlIGlmKGYuZmllbGRfdHlwZT09PSdyYWRpbycpIGlubmVyPWA8ZGl2IGNsYXNzPSJyYWRpby1yb3ciPiR7Zi5vcHRpb25zLm1hcChvPT5gPGRpdiBjbGFzcz0icmFkaW8tcGlsbCAke3Y9PT1vLnZhbHVlPydzZWwnOicnfSIgZGF0YS1rPSIke2YuZmllbGRfa2V5fSIgZGF0YS12PSIke2VzYyhvLnZhbHVlKX0iIG9uY2xpY2s9InBpY2tSYWRpbyh0aGlzKSI+JHtlc2Moby5sYWJlbF91cil9PC9kaXY+YCkuam9pbignJyl9PC9kaXY+PGlucHV0IHR5cGU9ImhpZGRlbiIgaWQ9ImluXyR7Zi5maWVsZF9rZXl9IiB2YWx1ZT0iJHtlc2Modil9Ij5gOwogIGVsc2UgaW5uZXI9YDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iaW5fJHtmLmZpZWxkX2tleX0iIHZhbHVlPSIke2VzYyh2KX0iIHBsYWNlaG9sZGVyPSIke2VzYyhmLnBsYWNlaG9sZGVyX3VyKX0iPmA7CiAgcmV0dXJuIGA8bGFiZWw+JHtlc2MoZi5sYWJlbF91cil9ICR7cmVxfTwvbGFiZWw+JHtpbm5lcn1gOwp9CmZ1bmN0aW9uIHBpY2tSYWRpbyhlbCl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChgLnJhZGlvLXBpbGxbZGF0YS1rPSIke2VsLmRhdGFzZXQua30iXWApLmZvckVhY2goeD0+eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKSk7CiAgZWwuY2xhc3NMaXN0LmFkZCgnc2VsJyk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgI2luXyR7Q1NTLmVzY2FwZShlbC5kYXRhc2V0LmspfWApLnZhbHVlPWVsLmRhdGFzZXQudjsKfQpmdW5jdGlvbiBmaWxlUGlja2VkKGtleSxpbnB1dCl7CiAgY29uc3QgZj1pbnB1dC5maWxlc1swXTtpZighZilyZXR1cm47CiAgaWYoZi5zaXplPjUqMTAyNCoxMDI0KXthbGVydCgnRmlsZSA1TUIgc2UgYmFyaSBoYWkuJyk7aW5wdXQudmFsdWU9Jyc7cmV0dXJuO30KICBjb25zdCByZD1uZXcgRmlsZVJlYWRlcigpOwogIHJkLm9ubG9hZD0oKT0+e3N0YXRlLmZpbGVzW2tleV09e25hbWU6Zi5uYW1lLGRhdGE6U3RyaW5nKHJkLnJlc3VsdCkuc3BsaXQoJywnKVsxXX07ZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgI2ZsXyR7Q1NTLmVzY2FwZShrZXkpfWApLnRleHRDb250ZW50PSfinIUgJytmLm5hbWU7fTsKICByZC5yZWFkQXNEYXRhVVJMKGYpOwp9CmZ1bmN0aW9uIHJlbmRlckZvcm0oKXsKICBzZXRTdGVwKDMpOwogIGNvbnN0IGM9c3RhdGUuY2F0OwogICQoJyNhcHAnKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGgyPiR7ZXNjKGMuaWNvbil9ICR7ZXNjKGMubmFtZV91cil9PC9oMj4KICAgIDxwIGNsYXNzPSJoaW50Ij5BcG5lIGthYW0ga2kgdGFmc2VlbCBsaWtoZWluLiA8c3BhbiBjbGFzcz0icmVxIj4qPC9zcGFuPiB3YWxlIGtoYWFuZSB6YXJvb3JpIGhhaW4uPC9wPgogICAgPGRpdiBpZD0iZkVyciI+PC9kaXY+CiAgICAke2MuZmllbGRzLm1hcChmaWVsZEhUTUwpLmpvaW4oJycpfQogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBpZD0iYnRuUXVvdGUiIG9uY2xpY2s9ImdldFF1b3RlKCkiPlByaWNlIE1hbG9vbSBLYXJlaW4g4oaSPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBvbmNsaWNrPSJyZW5kZXJTZXJ2aWNlcygpIj7ihpAgV2FwYXM8L2J1dHRvbj4KICA8L2Rpdj5gOwp9CmZ1bmN0aW9uIGNvbGxlY3RJbnB1dHMoKXsKICBjb25zdCBvPXt9OwogIGZvcihjb25zdCBmIG9mIHN0YXRlLmNhdC5maWVsZHMpewogICAgaWYoZi5maWVsZF90eXBlPT09J2ZpbGUnKWNvbnRpbnVlOwogICAgY29uc3QgZWw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgI2luXyR7Q1NTLmVzY2FwZShmLmZpZWxkX2tleSl9YCk7CiAgICBvW2YuZmllbGRfa2V5XT1lbD9lbC52YWx1ZTonJzsKICB9CiAgcmV0dXJuIG87Cn0KCi8qIC0tLS0tLS0tLS0gU1RFUCA0OiBwcmljZSArIGFwcHJvdmFsIC0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gZ2V0UXVvdGUoKXsKICBzdGF0ZS5pbnB1dHM9Y29sbGVjdElucHV0cygpOwogIGNvbnN0IGJ0bj0kKCcjYnRuUXVvdGUnKTtidG4uZGlzYWJsZWQ9dHJ1ZTtidG4uaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0ic3BpbiI+PC9zcGFuPlByaWNlIG5pa2FhbCByYWhlIGhhaW4uLi4nOwogIHRyeXsKICAgIGNvbnN0IHI9YXdhaXQgKGF3YWl0IGZldGNoKCcvYXBpL3ByaWNlL3F1b3RlJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOnsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9LGJvZHk6SlNPTi5zdHJpbmdpZnkoe2NhdGVnb3J5X2lkOnN0YXRlLmNhdC5pZCxpbnB1dHM6c3RhdGUuaW5wdXRzfSl9KSkuanNvbigpOwogICAgaWYoIXIub2speyQoJyNmRXJyJykuaW5uZXJIVE1MPWVyckJveChyLmVycm9yc3x8ci5lcnJvcik7YnRuLmRpc2FibGVkPWZhbHNlO2J0bi50ZXh0Q29udGVudD0nUHJpY2UgTWFsb29tIEthcmVpbiDihpInO3JldHVybjt9CiAgICBzdGF0ZS5xdW90ZT1yO3N0YXRlLmlkZW1LZXk9Y3J5cHRvLnJhbmRvbVVVSUQoKTsKICAgIHJlbmRlclF1b3RlKCk7CiAgfWNhdGNoeyAkKCcjZkVycicpLmlubmVySFRNTD1lcnJCb3goJ05ldHdvcmsgbWVpbiBtYXNsYS4gRG9iYXJhIGtvc2hpc2gga2FyZWluLicpO2J0bi5kaXNhYmxlZD1mYWxzZTtidG4udGV4dENvbnRlbnQ9J1ByaWNlIE1hbG9vbSBLYXJlaW4g4oaSJzsgfQp9CmZ1bmN0aW9uIHJlbmRlclF1b3RlKCl7CiAgc2V0U3RlcCg0KTsKICBjb25zdCBxPXN0YXRlLnF1b3RlOwogIGlmKHEucXVvdGVfcmVxdWlyZWQpewogICAgJCgnI2FwcCcpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyIj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjUycHgiPvCfkqw8L2Rpdj4KICAgICAgPGgyPlF1b3RlIERhcmthYXIgSGFpPC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiPiR7ZXNjKHEucmVhc29uX3VyKX08YnI+PGJyPkFhcGthIG9yZGVyIHNhdmUgaG8gamF5ZWdhLCBkdWthbiBxdW90ZSBiaGVqZWdpLCBwaGlyIGFhcCBtYW56b29yIGthcmtlIHRva2VuIGxlIHNha3RlIGhhaW4uPC9wPgogICAgICA8ZGl2IGNsYXNzPSJhcHByb3ZlIiBzdHlsZT0idGV4dC1hbGlnbjpsZWZ0Ij48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJhZ3JlZUJveCI+PGxhYmVsIGZvcj0iYWdyZWVCb3giIHN0eWxlPSJtYXJnaW46MDtmb250LXdlaWdodDo0MDAiPk1haW5lIGFwbmUga2FhbSBraSBkZXRhaWxzIGNoZWNrIGthciBsaSBoYWluLjwvbGFiZWw+PC9kaXY+CiAgICAgIDxkaXYgaWQ9InFFcnIiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiIGlkPSJidG5Db25maXJtIiBvbmNsaWNrPSJjb25maXJtT3JkZXIoKSI+T3JkZXIgQ29uZmlybSBLYXJlaW48L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgb25jbGljaz0icmVuZGVyRm9ybSgpIj7ihpAgVGFmc2VlbCBiYWRsZWluPC9idXR0b24+CiAgICA8L2Rpdj5gOwogICAgcmV0dXJuOwogIH0KICAkKCcjYXBwJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxoMj5BYXBrZSBLYWFtIEtpIFRhZnNlZWw8L2gyPgogICAgPHAgY2xhc3M9ImhpbnQiPjxiPiR7ZXNjKHN0YXRlLmNhdC5uYW1lX3VyKX08L2I+IOKAlCBuZWVjaGUgdGFtYW0gY2hhcmdlcyBkZWtoIGxlaW4uPC9wPgogICAgJHtxLmxpbmVzLm1hcChsPT5gPGRpdiBjbGFzcz0icWxpbmUiPjxzcGFuPiR7ZXNjKGwubGFiZWwpfSR7bC5kZXRhaWw/YDxkaXYgY2xhc3M9ImQiPiR7ZXNjKGwuZGV0YWlsKX08L2Rpdj5gOicnfTwvc3Bhbj48Yj5Scy4gJHtOdW1iZXIobC5hbW91bnQpLnRvTG9jYWxlU3RyaW5nKCl9PC9iPjwvZGl2PmApLmpvaW4oJycpfQogICAgPGRpdiBjbGFzcz0icXRvdGFsIj48c3Bhbj5BYXBraSBUb3RhbCBQcmljZTwvc3Bhbj48c3Bhbj5Scy4gJHtOdW1iZXIocS50b3RhbCkudG9Mb2NhbGVTdHJpbmcoKX08L3NwYW4+PC9kaXY+CiAgICAke3EuZXN0aW1hdGVkX21pbnV0ZXM/YDxwIGNsYXNzPSJoaW50Ij7ij7HvuI8gQW5kYXphbiB0YXl5YXJpIGthIHdhcXQ6ICR7ZXRhVXIocS5lc3RpbWF0ZWRfbWludXRlcyl9PC9wPmA6Jyd9CiAgICA8ZGl2IGNsYXNzPSJhcHByb3ZlIj48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJhZ3JlZUJveCI+PGxhYmVsIGZvcj0iYWdyZWVCb3giIHN0eWxlPSJtYXJnaW46MDtmb250LXdlaWdodDo0MDAiPk1haW5lIGFwbmUga2FhbSBraSBkZXRhaWxzIGNoZWNrIGthciBsaSBoYWluIGF1ciB0b3RhbCBwcmljZSBtYW56b29yIGhhaS48L2xhYmVsPjwvZGl2PgogICAgPGRpdiBpZD0icUVyciI+PC9kaXY+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiIGlkPSJidG5Db25maXJtIiBvbmNsaWNrPSJjb25maXJtT3JkZXIoKSI+T3JkZXIgQ29uZmlybSBLYXJlaW4gQXVyIFRva2VuIEdlbmVyYXRlIEthcmVpbjwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgb25jbGljaz0icmVuZGVyRm9ybSgpIj7ihpAgVGFmc2VlbCBiYWRsZWluPC9idXR0b24+CiAgPC9kaXY+YDsKfQpmdW5jdGlvbiBldGFVcihtaW4pe2lmKG1pbjw2MClyZXR1cm4gYCR7bWlufSBtaW51dGVgO2NvbnN0IGg9TWF0aC5mbG9vcihtaW4vNjApLG09bWluJTYwO3JldHVybiBtP2Ake2h9IGdoYW50YSAke219IG1pbnV0ZWA6YCR7aH0gZ2hhbnRhYDt9Cgphc3luYyBmdW5jdGlvbiBjb25maXJtT3JkZXIoKXsKICBpZighJCgnI2FncmVlQm94JykuY2hlY2tlZCl7JCgnI3FFcnInKS5pbm5lckhUTUw9ZXJyQm94KCdQcmljZSBtYW56b29yIGthcm5lIGtlIGxpeWUgY2hlY2tib3ggdGljayBrYXJlaW4uJyk7cmV0dXJuO30KICBjb25zdCBidG49JCgnI2J0bkNvbmZpcm0nKTtidG4uZGlzYWJsZWQ9dHJ1ZTtidG4uaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0ic3BpbiI+PC9zcGFuPk9yZGVyIGNvbmZpcm0gaG8gcmFoYSBoYWkuLi4nOwogIGNvbnN0IHBheWxvYWQ9e2lkZW1wb3RlbmN5X2tleTpzdGF0ZS5pZGVtS2V5LGN1c3RvbWVyOntuYW1lOnN0YXRlLm5hbWUsbW9iaWxlOnN0YXRlLm1vYmlsZSxlbWFpbDpzdGF0ZS5lbWFpbH0sCiAgICBjYXRlZ29yeV9pZDpzdGF0ZS5jYXQuaWQsaW5wdXRzOnN0YXRlLmlucHV0cyxhZ3JlZTp0cnVlLAogICAgZmlsZXM6T2JqZWN0LmVudHJpZXMoc3RhdGUuZmlsZXMpLm1hcCgoW2ssdl0pPT4oe25hbWU6di5uYW1lLGRhdGE6di5kYXRhfSkpfTsKICBpZihzdGF0ZS5zdGFmZil7CiAgICAvLyBzdGFmZjogYWRtaW4gdG9rZW4gc2UgYmhlamVpbgogICAgY29uc3QgdD1sb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc3BfYWRtaW4nKTsKICAgIGlmKCF0KXskKCcjcUVycicpLmlubmVySFRNTD1lcnJCb3goJ1N0YWZmIG9yZGVyIGtlIGxpeWUgYWRtaW4gbG9naW4gemFyb29yaSBoYWkuIC9hZG1pbiBwYXIgbG9naW4ga2FyZWluLicpO2J0bi5kaXNhYmxlZD1mYWxzZTtidG4udGV4dENvbnRlbnQ9J09yZGVyIENvbmZpcm0gS2FyZWluJztyZXR1cm47fQogICAgdHJ5ewogICAgICBjb25zdCByPWF3YWl0IChhd2FpdCBmZXRjaCgnL2FwaS9hZG1pbi9vcmRlcnMnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJywnQXV0aG9yaXphdGlvbic6J0JlYXJlciAnK3R9LGJvZHk6SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9KSkuanNvbigpOwogICAgICBpZighci5vayl0aHJvdyBuZXcgRXJyb3Ioci5lcnJvcik7CiAgICAgIHN0YXRlLm9yZGVyPXIub3JkZXI7c2F2ZU15T3JkZXIoci5vcmRlcik7cmVuZGVyVG9rZW4oKTsKICAgIH1jYXRjaChlKXskKCcjcUVycicpLmlubmVySFRNTD1lcnJCb3goZS5tZXNzYWdlKTtidG4uZGlzYWJsZWQ9ZmFsc2U7YnRuLnRleHRDb250ZW50PSdPcmRlciBDb25maXJtIEthcmVpbic7fQogICAgcmV0dXJuOwogIH0KICBwYXlsb2FkLnZlcmlmaWVkX3Rva2VuPXN0YXRlLnZlcmlmaWVkVG9rZW47CiAgdHJ5ewogICAgY29uc3Qgcj1hd2FpdCAoYXdhaXQgZmV0Y2goJy9hcGkvb3JkZXJzJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOnsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9LGJvZHk6SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9KSkuanNvbigpOwogICAgaWYoIXIub2spdGhyb3cgbmV3IEVycm9yKHIuZXJyb3JzP3IuZXJyb3JzLmpvaW4oJyAnKTpyLmVycm9yKTsKICAgIHN0YXRlLm9yZGVyPXIub3JkZXI7c2F2ZU15T3JkZXIoci5vcmRlcik7cmVuZGVyVG9rZW4oKTsKICB9Y2F0Y2goZSl7JCgnI3FFcnInKS5pbm5lckhUTUw9ZXJyQm94KGUubWVzc2FnZXx8J09yZGVyIG5haGkgYmFuIHNha2EuIERvYmFyYSBrb3NoaXNoIGthcmVpbi4nKTtidG4uZGlzYWJsZWQ9ZmFsc2U7YnRuLnRleHRDb250ZW50PSdPcmRlciBDb25maXJtIEthcmVpbiBBdXIgVG9rZW4gR2VuZXJhdGUgS2FyZWluJzt9Cn0KZnVuY3Rpb24gc2F2ZU15T3JkZXIobyl7CiAgdHJ5e2NvbnN0IGw9SlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc3Bfb3JkZXJzJyl8fCdbXScpOwogICAgbC51bnNoaWZ0KHtyZWY6by5zZWN1cmVfcmVmLHRva2VuOm8udG9rZW5fbm98fCdRdW90ZSBwZW5kaW5nJyxzZXJ2aWNlOm8uc2VydmljZV9uYW1lLGF0Om5ldyBEYXRlKCkudG9JU09TdHJpbmcoKX0pOwogICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NwX29yZGVycycsSlNPTi5zdHJpbmdpZnkobC5zbGljZSgwLDIwKSkpO31jYXRjaHt9Cn0KCi8qIC0tLS0tLS0tLS0gU1RFUCA1OiB0b2tlbiAtLS0tLS0tLS0tICovCmZ1bmN0aW9uIGZtdERUKGlzbyl7CiAgaWYoIWlzbylyZXR1cm4gJ+KAlCc7CiAgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1QSycse3RpbWVab25lOidBc2lhL0thcmFjaGknLGRheTonMi1kaWdpdCcsbW9udGg6J3Nob3J0Jyx5ZWFyOidudW1lcmljJyxob3VyOicyLWRpZ2l0JyxtaW51dGU6JzItZGlnaXQnLGhvdXIxMjp0cnVlfSkuZm9ybWF0KG5ldyBEYXRlKGlzbykpOwp9CmZ1bmN0aW9uIHJlbmRlclRva2VuKCl7CiAgc2V0U3RlcCg0KTsKICBjb25zdCBvPXN0YXRlLm9yZGVyOwogIGNvbnN0IHN0YXR1c1VybD1gJHtsb2NhdGlvbi5vcmlnaW59L3N0YXR1cz9yZWY9JHtvLnNlY3VyZV9yZWZ9YDsKICBpZihvLnN0YXR1cz09PSdxdW90ZV9yZXF1aXJlZCcpewogICAgJCgnI2FwcCcpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyIj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjUycHgiPvCfkqw8L2Rpdj4KICAgICAgPGgyPkFhcGtpIEJhYXJpIEthIEludGV6YWFyIEhhaTwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50Ij5BYXBrYSBvcmRlciBkdWthbiBrbyBtaWwgZ2F5YSBoYWkuIEphbGQgaGkgcXVvdGUgYmhlamEgamF5ZWdhLjxicj4KICAgICAgTmVlY2hlIGxpbmsgc2Ugc3RhdHVzIGRla2h0ZSByYWhlaW4g4oCUIHF1b3RlIGFhbmUgcGFyIG1hbnpvb3Iga2Fya2UgdG9rZW4gbGUgbGVpbi48L3A+CiAgICAgIDxkaXYgY2xhc3M9Im9rbXNnIiBzdHlsZT0id29yZC1icmVhazpicmVhay1hbGwiPvCflJcgPGEgaHJlZj0iJHtzdGF0dXNVcmx9Ij4ke3N0YXR1c1VybH08L2E+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QiIG9uY2xpY2s9ImxvY2F0aW9uLmhyZWY9JyR7c3RhdHVzVXJsfSciPk9yZGVyIFN0YXR1cyBEZWtoZWluPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QiIG9uY2xpY2s9ImxvY2F0aW9uLnJlbG9hZCgpIj5OYXlhIE9yZGVyIEthcmVpbjwvYnV0dG9uPgogICAgPC9kaXY+YDsKICAgIHJldHVybjsKICB9CiAgJCgnI2FwcCcpLmlubmVySFRNTD1gCiAgPGRpdiBjbGFzcz0idG9rZW4tYmlnIj4KICAgIDxkaXYgY2xhc3M9InQiPkFhcGthIFRva2VuPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJuIj4ke2VzYyhvLnRva2VuX25vKX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKG8uc2VydmljZV9uYW1lKX0g4oCiICR7Zm10RFQoby5jb25maXJtZWRfYXQpfTwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuPk5hYW08L3NwYW4+PGI+JHtlc2Moby5jdXN0b21lcl9uYW1lKX08L2I+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4+U2VydmljZTwvc3Bhbj48Yj4ke2VzYyhvLnNlcnZpY2VfaWNvbil9ICR7ZXNjKG8uc2VydmljZV9uYW1lKX08L2I+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4+VG90YWwgUHJpY2U8L3NwYW4+PGI+UnMuICR7TnVtYmVyKG8udG90YWxfcHJpY2UpLnRvTG9jYWxlU3RyaW5nKCl9PC9iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuPlFhdGFhciAocXVldWUpIG51bWJlcjwvc3Bhbj48Yj4ke28ucXVldWVfcG9zaXRpb24/PyfigJQnfTwvYj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Imt2Ij48c3Bhbj5TdGF0dXM8L3NwYW4+PGI+PHNwYW4gY2xhc3M9InN0YXR1cy1waWxsIj4ke2VzYyhvLnN0YXR1c191cil9PC9zcGFuPjwvYj48L2Rpdj4KICAgICR7by5lc3RpbWF0ZWRfbWludXRlcz9gPGRpdiBjbGFzcz0ia3YiPjxzcGFuPkFuZGF6YW4gd2FxdDwvc3Bhbj48Yj4ke2V0YVVyKG8uZXN0aW1hdGVkX21pbnV0ZXMpfTwvYj48L2Rpdj5gOicnfQogICAgJHtvLmNoZWNraW5fZGVhZGxpbmU/YDxkaXYgY2xhc3M9Imt2Ij48c3Bhbj5XYXNvb2xpIGtpIGFha2hyaSB0YXJlZWtoPC9zcGFuPjxiPiR7Zm10RFQoby5jaGVja2luX2RlYWRsaW5lKX08L2I+PC9kaXY+YDonJ30KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJjYXJkIG5vcHJpbnQiPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBvbmNsaWNrPSJkb3dubG9hZFRva2VuKCkiPuKsh++4jyBUb2tlbiBEb3dubG9hZCBLYXJlaW48L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ3JlZW4iIG9uY2xpY2s9InNoYXJlV0EoKSI+8J+TsiBXaGF0c0FwcCBQYXIgU2hhcmUgS2FyZWluPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBvbmNsaWNrPSJsb2NhdGlvbi5ocmVmPScke3N0YXR1c1VybH0nIj7wn5SNIE9yZGVyIFN0YXR1cyBEZWtoZWluPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBvbmNsaWNrPSJsb2NhdGlvbi5yZWxvYWQoKSI+77yLIE5heWEgT3JkZXI8L2J1dHRvbj4KICA8L2Rpdj5gOwogIC8vIHByaW50IHZlcnNpb24KICAkKCcjcHJpbnRCb2R5JykuaW5uZXJIVE1MPWAKICAgIDxoMT4ke2VzYyhzdGF0ZS5zaG9wLm5hbWV8fCdTbWFydCBQcmludCBTaG9wJyl9PC9oMT4KICAgIDxwPlRva2VuPC9wPjxkaXYgY2xhc3M9InRuIj4ke2VzYyhvLnRva2VuX25vKX08L2Rpdj4KICAgIDx0YWJsZSBjbGFzcz0icHRhYmxlIj4KICAgICAgPHRyPjx0ZD5OYWFtPC90ZD48dGQ+PGI+JHtlc2Moby5jdXN0b21lcl9uYW1lKX08L2I+PC90ZD48L3RyPgogICAgICA8dHI+PHRkPlNlcnZpY2U8L3RkPjx0ZD4ke2VzYyhvLnNlcnZpY2VfbmFtZSl9PC90ZD48L3RyPgogICAgICA8dHI+PHRkPlRhcmVla2g8L3RkPjx0ZD4ke2ZtdERUKG8uY29uZmlybWVkX2F0KX08L3RkPjwvdHI+CiAgICAgIDx0cj48dGQ+VG90YWwgUHJpY2U8L3RkPjx0ZD48Yj5Scy4gJHtOdW1iZXIoby50b3RhbF9wcmljZSkudG9Mb2NhbGVTdHJpbmcoKX08L2I+PC90ZD48L3RyPgogICAgICA8dHI+PHRkPlFhdGFhciBudW1iZXI8L3RkPjx0ZD4ke28ucXVldWVfcG9zaXRpb24/PyfigJQnfTwvdGQ+PC90cj4KICAgICAgPHRyPjx0ZD5TdGF0dXMgbGluazwvdGQ+PHRkIHN0eWxlPSJ3b3JkLWJyZWFrOmJyZWFrLWFsbCI+JHtzdGF0dXNVcmx9PC90ZD48L3RyPgogICAgPC90YWJsZT4KICAgIDxwIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHg7Zm9udC1zaXplOjEycHgiPkR1a2FuIHBhciBhYXRlIHdhcXQgeWUgdG9rZW4gZGlraGF5ZWluLiBTaHVrcml5YSE8L3A+YDsKICB3aW5kb3cuX3N0YXR1c1VybD1zdGF0dXNVcmw7Cn0KZnVuY3Rpb24gZG93bmxvYWRUb2tlbigpe3dpbmRvdy5wcmludCgpO30KZnVuY3Rpb24gc2hhcmVXQSgpewogIGNvbnN0IG89c3RhdGUub3JkZXI7CiAgY29uc3QgbXNnPWDwn5ao77iPICR7c3RhdGUuc2hvcC5uYW1lfHwnU21hcnQgUHJpbnQgU2hvcCd9XG5NZXJhIHRva2VuOiAke28udG9rZW5fbm99XG5TZXJ2aWNlOiAke28uc2VydmljZV9uYW1lfVxuUHJpY2U6IFJzLiAke051bWJlcihvLnRvdGFsX3ByaWNlKS50b0xvY2FsZVN0cmluZygpfVxuUWF0YWFyOiAke28ucXVldWVfcG9zaXRpb24/PyfigJQnfVxuU3RhdHVzOiAke3dpbmRvdy5fc3RhdHVzVXJsfWA7CiAgd2luZG93Lm9wZW4oJ2h0dHBzOi8vd2EubWUvP3RleHQ9JytlbmNvZGVVUklDb21wb25lbnQobXNnKSwnX2JsYW5rJyk7Cn0KaW5pdCgpOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==","/status.html":"PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InVyIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+T3JkZXIgU3RhdHVzIOKAlCBTbWFydCBQcmludCBTaG9wPC90aXRsZT4KPHN0eWxlPgoqe2JveC1zaXppbmc6Ym9yZGVyLWJveDttYXJnaW46MDtwYWRkaW5nOjB9CmJvZHl7Zm9udC1mYW1pbHk6c3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sIlNlZ29lIFVJIixSb2JvdG8sc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiNmNGY2ZmI7Y29sb3I6IzFhMWEyZTttaW4taGVpZ2h0OjEwMHZofQpoZWFkZXJ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM0ZjQ2ZTUsIzdjM2FlZCk7Y29sb3I6I2ZmZjtwYWRkaW5nOjE4cHg7dGV4dC1hbGlnbjpjZW50ZXJ9CmhlYWRlciBoMXtmb250LXNpemU6MjBweH0KbWFpbnttYXgtd2lkdGg6NTIwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjE4cHggMTRweH0KLmNhcmR7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTZweDtib3gtc2hhZG93OjAgNHB4IDE4cHggcmdiYSgwLDAsMCwuMDYpO3BhZGRpbmc6MjBweDttYXJnaW4tYm90dG9tOjE0cHh9Cmgye2ZvbnQtc2l6ZToxOXB4O21hcmdpbi1ib3R0b206NnB4fQouaGludHtmb250LXNpemU6MTMuNXB4O2NvbG9yOiM2NjY7bWFyZ2luLWJvdHRvbToxMnB4O2xpbmUtaGVpZ2h0OjEuNn0KbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXdlaWdodDo2MDA7Zm9udC1zaXplOjE0LjVweDttYXJnaW46MTJweCAwIDZweH0KaW5wdXR7d2lkdGg6MTAwJTtwYWRkaW5nOjEzcHggMTJweDtib3JkZXI6MnB4IHNvbGlkICNlM2U2ZjA7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNnB4fQouYnRue2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTtwYWRkaW5nOjE1cHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtc2l6ZToxNi41cHg7Zm9udC13ZWlnaHQ6NzAwO2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO21hcmdpbi10b3A6MTRweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzRmNDZlNSwjN2MzYWVkKTtjb2xvcjojZmZmfQouYnRuLWdob3N0e2JhY2tncm91bmQ6I2VlZjBmNztjb2xvcjojMzMzfQouZXJye2JhY2tncm91bmQ6I2ZkZThlODtjb2xvcjojYjkxYzFjO3BhZGRpbmc6MTJweDtib3JkZXItcmFkaXVzOjEycHg7Zm9udC1zaXplOjE0LjVweDttYXJnaW4tYm90dG9tOjEycHh9Ci5rdntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47cGFkZGluZzo5cHggMnB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkICNmMGYwZjA7Zm9udC1zaXplOjE0LjVweH0KLmt2IGJ7dGV4dC1hbGlnbjpyaWdodH0KLnRva2VuLWJpZ3tiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzRmNDZlNSwjN2MzYWVkKTtjb2xvcjojZmZmO2JvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjI0cHggMjBweDt0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tYm90dG9tOjE0cHh9Ci50b2tlbi1iaWcgLm57Zm9udC1zaXplOjM4cHg7Zm9udC13ZWlnaHQ6ODAwO2xldHRlci1zcGFjaW5nOjJweH0KLnBpbGx7ZGlzcGxheTppbmxpbmUtYmxvY2s7cGFkZGluZzo2cHggMTRweDtib3JkZXItcmFkaXVzOjIwcHg7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxNHB4O2JhY2tncm91bmQ6I2UwZTdmZjtjb2xvcjojMzczMGEzfQoucWxpbmV7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTBweCAycHg7Ym9yZGVyLWJvdHRvbToxcHggZGFzaGVkICNlNWU1ZTU7Zm9udC1zaXplOjE1cHh9Ci5xdG90YWx7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTRweCAycHg7Zm9udC1zaXplOjE5cHg7Zm9udC13ZWlnaHQ6ODAwfQouYXBwcm92ZXtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtiYWNrZ3JvdW5kOiNmM2VmZmY7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTRweDttYXJnaW4tdG9wOjEycHg7Zm9udC1zaXplOjE0LjVweH0KLmFwcHJvdmUgaW5wdXR7d2lkdGg6MjJweDtoZWlnaHQ6MjJweDthY2NlbnQtY29sb3I6IzdjM2FlZH0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGhlYWRlcj48aDE+8J+UjSBPcmRlciBTdGF0dXM8L2gxPjwvaGVhZGVyPgo8bWFpbiBpZD0iYXBwIj48ZGl2IGNsYXNzPSJjYXJkIj48cCBjbGFzcz0iaGludCI+TG9hZCBobyByYWhhIGhhaS4uLjwvcD48L2Rpdj48L21haW4+CjxzY3JpcHQ+CmNvbnN0ICQ9cz0+ZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzKTsKY29uc3QgZXNjPXM9PlN0cmluZyhzPz8nJykucmVwbGFjZSgvWyY8PiInXS9nLGM9Pih7JyYnOicmYW1wOycsJzwnOicmbHQ7JywnPic6JyZndDsnLCciJzonJnF1b3Q7JywiJyI6JyYjMzk7J31bY10pKTsKY29uc3QgcmVmPW5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uc2VhcmNoKS5nZXQoJ3JlZicpOwpjb25zdCBmbXREVD1pc289Pmlzbz9uZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tUEsnLHt0aW1lWm9uZTonQXNpYS9LYXJhY2hpJyxkYXk6JzItZGlnaXQnLG1vbnRoOidzaG9ydCcseWVhcjonbnVtZXJpYycsaG91cjonMi1kaWdpdCcsbWludXRlOicyLWRpZ2l0Jyxob3VyMTI6dHJ1ZX0pLmZvcm1hdChuZXcgRGF0ZShpc28pKTon4oCUJzsKCmlmKHJlZikgbG9hZE9yZGVyKHJlZik7IGVsc2UgcmVuZGVyTG9va3VwKCk7CgpmdW5jdGlvbiByZW5kZXJMb29rdXAoZXJyPScnKXsKICAkKCcjYXBwJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgIDxoMj5BcG5hIE9yZGVyIFRhbGFzaCBLYXJlaW48L2gyPgogICAgPHAgY2xhc3M9ImhpbnQiPlRva2VuIG51bWJlciBhdXIgd29oaSBtb2JpbGUgbnVtYmVyIGxpa2hlaW4gam8gb3JkZXIga2Ugd2FxdCBkaXlhIHRoYS48L3A+CiAgICAke2Vycj9gPGRpdiBjbGFzcz0iZXJyIj4ke2VzYyhlcnIpfTwvZGl2PmA6Jyd9CiAgICA8bGFiZWw+VG9rZW4gbnVtYmVyPC9sYWJlbD48aW5wdXQgaWQ9InRObyIgcGxhY2Vob2xkZXI9IlNQLTIwMjYxMDE4LTAwMSI+CiAgICA8bGFiZWw+TW9iaWxlIG51bWJlcjwvbGFiZWw+PGlucHV0IGlkPSJ0TW9iIiBwbGFjZWhvbGRlcj0iMDMwMDEyMzQ1NjciIGlucHV0bW9kZT0ibnVtZXJpYyI+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4iIG9uY2xpY2s9ImRvTG9va3VwKCkiPlN0YXR1cyBEZWtoZWluPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBvbmNsaWNrPSJsb2NhdGlvbi5ocmVmPScvYm9vayciPuKGkCBOYXlhIE9yZGVyPC9idXR0b24+CiAgPC9kaXY+YDsKfQphc3luYyBmdW5jdGlvbiBkb0xvb2t1cCgpewogIGNvbnN0IHI9YXdhaXQgKGF3YWl0IGZldGNoKCcvYXBpL29yZGVycy9sb29rdXAnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sCiAgICBib2R5OkpTT04uc3RyaW5naWZ5KHt0b2tlbl9ubzokKCcjdE5vJykudmFsdWUsbW9iaWxlOiQoJyN0TW9iJykudmFsdWV9KX0pKS5qc29uKCk7CiAgaWYoIXIub2spe3JlbmRlckxvb2t1cChyLmVycm9yKTtyZXR1cm47fQogIGxvY2F0aW9uLmhyZWY9Jy9zdGF0dXM/cmVmPScrci5zZWN1cmVfcmVmOwp9CmFzeW5jIGZ1bmN0aW9uIGxvYWRPcmRlcihyKXsKICBjb25zdCByZXM9YXdhaXQgZmV0Y2goJy9hcGkvb3JkZXIvJytlbmNvZGVVUklDb21wb25lbnQocikpOwogIGlmKCFyZXMub2speyQoJyNhcHAnKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVyciI+T3JkZXIgbmFoaSBtaWxhLiBMaW5rIGNoZWNrIGthcmVpbi48L2Rpdj48YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBvbmNsaWNrPSJsb2NhdGlvbi5ocmVmPScvc3RhdHVzJyI+V2FwYXM8L2J1dHRvbj48L2Rpdj5gO3JldHVybjt9CiAgY29uc3Qge29yZGVyOm99PWF3YWl0IHJlcy5qc29uKCk7CiAgcmVuZGVyT3JkZXIobyk7CiAgLy8gbGl2ZSByZWZyZXNoIGhhciA0NSBzZWNvbmQKICBzZXRUaW1lb3V0KCgpPT5sb2FkT3JkZXIociksNDUwMDApOwp9CmZ1bmN0aW9uIHJlbmRlck9yZGVyKG8pewogIGxldCBtaWQ9Jyc7CiAgaWYoby5zdGF0dXM9PT0ncXVvdGVfcmVxdWlyZWQnKXsKICAgIG1pZD1gPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyIj48ZGl2IHN0eWxlPSJmb250LXNpemU6NDRweCI+8J+SrDwvZGl2PgogICAgICA8aDI+QWFwa2kgQmFhcmkgS2EgSW50ZXphYXIgSGFpPC9oMj48cCBjbGFzcz0iaGludCI+RHVrYW4gamFsZCBhYXBrbyBxdW90ZSBiaGVqZWdpLiBZZSBwYWdlIGtodWxhIHJha2hlaW4geWEgbGluayBzYXZlIGthciBsZWluLjwvcD48L2Rpdj5gOwogIH0gZWxzZSBpZihvLnN0YXR1cz09PSdxdW90ZV9zZW50Jyl7CiAgICBtaWQ9YDxkaXYgY2xhc3M9ImNhcmQiPjxoMj7wn5KwIER1a2FuIEthIFF1b3RlPC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiPiR7ZXNjKG8ucXVvdGVfbm90ZXx8J05lZWNoZSBxdW90ZSBkaXlhIGdheWEgaGFpLicpfTwvcD4KICAgICAgPGRpdiBjbGFzcz0icXRvdGFsIj48c3Bhbj5RdW90ZSBQcmljZTwvc3Bhbj48c3Bhbj5Scy4gJHtOdW1iZXIoby5xdW90ZWRfdG90YWwpLnRvTG9jYWxlU3RyaW5nKCl9PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhcHByb3ZlIj48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJhZyI+PGxhYmVsIGZvcj0iYWciIHN0eWxlPSJtYXJnaW46MDtmb250LXdlaWdodDo0MDAiPk1haW5lIHF1b3RlIHBhcmggbGl5YSBoYWkgYXVyIHByaWNlIG1hbnpvb3IgaGFpLiBUb2tlbiBnZW5lcmF0ZSBrYXJlaW4uPC9sYWJlbD48L2Rpdj4KICAgICAgPGRpdiBpZD0iYUVyciI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgb25jbGljaz0iYXBwcm92ZVF1b3RlKCcke28uc2VjdXJlX3JlZn0nKSI+UXVvdGUgTWFuem9vciBLYXJlaW4gQXVyIFRva2VuIExlaW48L2J1dHRvbj48L2Rpdj5gOwogIH0KICAkKCcjYXBwJykuaW5uZXJIVE1MPWAKICAke28udG9rZW5fbm8/YDxkaXYgY2xhc3M9InRva2VuLWJpZyI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjEzcHg7b3BhY2l0eTouODUiPkFhcGthIFRva2VuPC9kaXY+PGRpdiBjbGFzcz0ibiI+JHtlc2Moby50b2tlbl9ubyl9PC9kaXY+PGRpdiBzdHlsZT0iZm9udC1zaXplOjEzcHg7b3BhY2l0eTouODUiPiR7ZXNjKG8uc2VydmljZV9uYW1lKX08L2Rpdj48L2Rpdj5gOicnfQogIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuPk5hYW08L3NwYW4+PGI+JHtlc2Moby5jdXN0b21lcl9uYW1lKX08L2I+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4+U2VydmljZTwvc3Bhbj48Yj4ke2VzYyhvLnNlcnZpY2VfaWNvbil9ICR7ZXNjKG8uc2VydmljZV9uYW1lKX08L2I+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4+U3RhdHVzPC9zcGFuPjxiPjxzcGFuIGNsYXNzPSJwaWxsIj4ke2VzYyhvLnN0YXR1c191cil9PC9zcGFuPjwvYj48L2Rpdj4KICAgICR7by50b2tlbl9ubz9gPGRpdiBjbGFzcz0ia3YiPjxzcGFuPlFhdGFhciBudW1iZXI8L3NwYW4+PGI+JHtvLnF1ZXVlX3Bvc2l0aW9uPz8n4oCUJ308L2I+PC9kaXY+YDonJ30KICAgICR7by50b3RhbF9wcmljZSE9bnVsbD9gPGRpdiBjbGFzcz0ia3YiPjxzcGFuPlRvdGFsIFByaWNlPC9zcGFuPjxiPlJzLiAke051bWJlcihvLnRvdGFsX3ByaWNlKS50b0xvY2FsZVN0cmluZygpfTwvYj48L2Rpdj5gOicnfQogICAgJHtvLmNvbmZpcm1lZF9hdD9gPGRpdiBjbGFzcz0ia3YiPjxzcGFuPk9yZGVyIHRpbWU8L3NwYW4+PGI+JHtmbXREVChvLmNvbmZpcm1lZF9hdCl9PC9iPjwvZGl2PmA6Jyd9CiAgICAke28uZXN0aW1hdGVkX21pbnV0ZXMmJm8udG9rZW5fbm8/YDxkaXYgY2xhc3M9Imt2Ij48c3Bhbj5BbmRhemFuIHdhcXQ8L3NwYW4+PGI+JHtvLmVzdGltYXRlZF9taW51dGVzfSBtaW51dGU8L2I+PC9kaXY+YDonJ30KICA8L2Rpdj4KICAke21pZH0KICA8ZGl2IGNsYXNzPSJjYXJkIj48YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IiBvbmNsaWNrPSJsb2NhdGlvbi5yZWxvYWQoKSI+8J+UhCBSZWZyZXNoIEthcmVpbjwvYnV0dG9uPjwvZGl2PmA7Cn0KYXN5bmMgZnVuY3Rpb24gYXBwcm92ZVF1b3RlKHIpewogIGlmKCEkKCcjYWcnKS5jaGVja2VkKXskKCcjYUVycicpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZXJyIj5RdW90ZSBtYW56b29yIGthcm5lIGtlIGxpeWUgY2hlY2tib3ggdGljayBrYXJlaW4uPC9kaXY+JztyZXR1cm47fQogIGNvbnN0IHJlcz1hd2FpdCAoYXdhaXQgZmV0Y2goJy9hcGkvb3JkZXIvJytyKycvYXBwcm92ZS1xdW90ZScse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSxib2R5OkpTT04uc3RyaW5naWZ5KHthZ3JlZTp0cnVlfSl9KSkuanNvbigpOwogIGlmKCFyZXMub2speyQoJyNhRXJyJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJlcnIiPiR7ZXNjKHJlcy5lcnJvcil9PC9kaXY+YDtyZXR1cm47fQogIGxvYWRPcmRlcihyKTsKfQo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==","/admin.html":"PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InVyIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+QWRtaW4g4oCUIFNtYXJ0IFByaW50IFNob3A8L3RpdGxlPgo8c3R5bGU+Cip7Ym94LXNpemluZzpib3JkZXItYm94O21hcmdpbjowO3BhZGRpbmc6MH0KYm9keXtmb250LWZhbWlseTpzeXN0ZW0tdWksLWFwcGxlLXN5c3RlbSwiU2Vnb2UgVUkiLFJvYm90byxzYW5zLXNlcmlmO2JhY2tncm91bmQ6I2YxZjNmOTtjb2xvcjojMWExYTJlO21pbi1oZWlnaHQ6MTAwdmh9CmhlYWRlcntiYWNrZ3JvdW5kOiMxZTFiNGI7Y29sb3I6I2ZmZjtwYWRkaW5nOjE0cHggMTZweDtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO3Bvc2l0aW9uOnN0aWNreTt0b3A6MDt6LWluZGV4OjEwfQpoZWFkZXIgaDF7Zm9udC1zaXplOjE3cHh9CmhlYWRlciBidXR0b257YmFja2dyb3VuZDojMzczMGEzO2NvbG9yOiNmZmY7Ym9yZGVyOm5vbmU7cGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjhweDtjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTNweH0KLnRhYnN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7cGFkZGluZzoxMHB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXItYm90dG9tOjFweCBzb2xpZCAjZTVlNWU1O292ZXJmbG93LXg6YXV0bztwb3NpdGlvbjpzdGlja3k7dG9wOjUzcHg7ei1pbmRleDo5fQoudGFie3doaXRlLXNwYWNlOm5vd3JhcDtwYWRkaW5nOjEwcHggMTZweDtib3JkZXItcmFkaXVzOjEwcHg7Ym9yZGVyOm5vbmU7YmFja2dyb3VuZDojZWVmMGY3O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcn0KLnRhYi5vbntiYWNrZ3JvdW5kOiM0ZjQ2ZTU7Y29sb3I6I2ZmZn0KbWFpbnttYXgtd2lkdGg6OTAwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjE2cHggMTJweCA2MHB4fQouY2FyZHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyLXJhZGl1czoxNHB4O2JveC1zaGFkb3c6MCAycHggMTJweCByZ2JhKDAsMCwwLC4wNSk7cGFkZGluZzoxNnB4O21hcmdpbi1ib3R0b206MTJweH0KaDJ7Zm9udC1zaXplOjE4cHg7bWFyZ2luLWJvdHRvbTo4cHh9Ci5oaW50e2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM2NjY7bWFyZ2luLWJvdHRvbToxMHB4O2xpbmUtaGVpZ2h0OjEuNn0KbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXdlaWdodDo2MDA7Zm9udC1zaXplOjEzLjVweDttYXJnaW46MTBweCAwIDVweH0KaW5wdXQsc2VsZWN0LHRleHRhcmVhe3dpZHRoOjEwMCU7cGFkZGluZzoxMHB4O2JvcmRlcjoycHggc29saWQgI2UzZTZmMDtib3JkZXItcmFkaXVzOjEwcHg7Zm9udC1zaXplOjE1cHh9CnRleHRhcmVhe21pbi1oZWlnaHQ6NzBweDtmb250LWZhbWlseTptb25vc3BhY2U7Zm9udC1zaXplOjEzcHh9Ci5idG57cGFkZGluZzoxMXB4IDE4cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtc2l6ZToxNC41cHg7Zm9udC13ZWlnaHQ6NzAwO2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO2JhY2tncm91bmQ6IzRmNDZlNTtjb2xvcjojZmZmfQouYnRuLXNte3BhZGRpbmc6N3B4IDEycHg7Zm9udC1zaXplOjEzcHh9Ci5idG4tZ2hvc3R7YmFja2dyb3VuZDojZWVmMGY3O2NvbG9yOiMzMzN9Ci5idG4tZGFuZ2Vye2JhY2tncm91bmQ6I2RjMjYyNjtjb2xvcjojZmZmfQouYnRuLWdyZWVue2JhY2tncm91bmQ6IzA1OTY2OTtjb2xvcjojZmZmfQoucm93e2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO2FsaWduLWl0ZW1zOmNlbnRlcn0KdGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzLjVweH0KdGgsdGR7cGFkZGluZzo5cHggOHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkICNmMGYwZjA7dGV4dC1hbGlnbjpsZWZ0O3ZlcnRpY2FsLWFsaWduOnRvcH0KdGh7YmFja2dyb3VuZDojZjhmOWZkO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM1NTV9Ci5waWxse2Rpc3BsYXk6aW5saW5lLWJsb2NrO3BhZGRpbmc6NHB4IDEycHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjcwMDtiYWNrZ3JvdW5kOiNlMGU3ZmY7Y29sb3I6IzM3MzBhM30KLnBpbGwucXtiYWNrZ3JvdW5kOiNmZWYzYzc7Y29sb3I6IzkyNDAwZX0ucGlsbC5va3tiYWNrZ3JvdW5kOiNkMWZhZTU7Y29sb3I6IzA2NWY0Nn0ucGlsbC5iYWR7YmFja2dyb3VuZDojZmVlMmUyO2NvbG9yOiM5OTFiMWJ9Ci5lcnJ7YmFja2dyb3VuZDojZmRlOGU4O2NvbG9yOiNiOTFjMWM7cGFkZGluZzoxMHB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTRweDttYXJnaW4tYm90dG9tOjEwcHh9Ci53YXJue2JhY2tncm91bmQ6I2ZmZjdkNjtib3JkZXI6MXB4IHNvbGlkICNlNmM4NGE7cGFkZGluZzoxMnB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTRweDttYXJnaW4tYm90dG9tOjEycHg7bGluZS1oZWlnaHQ6MS42fQoubW9kYWx7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjUpO3otaW5kZXg6NTA7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7anVzdGlmeS1jb250ZW50OmNlbnRlcjtwYWRkaW5nOjIwcHggMTBweDtvdmVyZmxvdy15OmF1dG99Ci5tYm94e2JhY2tncm91bmQ6I2ZmZjtib3JkZXItcmFkaXVzOjE2cHg7bWF4LXdpZHRoOjY0MHB4O3dpZHRoOjEwMCU7cGFkZGluZzoyMHB4O21heC1oZWlnaHQ6OTJ2aDtvdmVyZmxvdy15OmF1dG99Ci5tYm94IGgze21hcmdpbi1ib3R0b206OHB4fQoua3Z7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6N3B4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgI2YyZjJmMjtmb250LXNpemU6MTRweDtnYXA6MTBweH0KLmt2IGJ7dGV4dC1hbGlnbjpyaWdodDt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9Ci5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0KLmdyaWQye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcjtnYXA6MTBweH0KQG1lZGlhKG1heC13aWR0aDo2MDBweCl7LmdyaWQye2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9fQoudG1wbHtmb250LXNpemU6MTJweDtiYWNrZ3JvdW5kOiNmMWY1Zjk7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDhweDttYXJnaW46MnB4O2N1cnNvcjpwb2ludGVyfQoubG9naW57bWF4LXdpZHRoOjM4MHB4O21hcmdpbjo2MHB4IGF1dG99Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxoZWFkZXI+PGgxPvCflqjvuI8gQWRtaW4gUGFuZWw8L2gxPjxidXR0b24gaWQ9ImxvZ291dEJ0biIgY2xhc3M9ImhpZGRlbiIgb25jbGljaz0ibG9nb3V0KCkiPkxvZ291dDwvYnV0dG9uPjwvaGVhZGVyPgo8ZGl2IGlkPSJsb2dpblZpZXciIGNsYXNzPSJsb2dpbiI+CiAgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPkFkbWluIExvZ2luPC9oMj48ZGl2IGlkPSJsRXJyIj48L2Rpdj4KICAgIDxsYWJlbD5Vc2VybmFtZTwvbGFiZWw+PGlucHV0IGlkPSJsVXNlciIgdmFsdWU9ImFkbWluIj4KICAgIDxsYWJlbD5QYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJsUGFzcyIgdHlwZT0icGFzc3dvcmQiIG9ua2V5ZG93bj0iaWYoZXZlbnQua2V5PT09J0VudGVyJylkb0xvZ2luKCkiPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBzdHlsZT0id2lkdGg6MTAwJTttYXJnaW4tdG9wOjE0cHgiIG9uY2xpY2s9ImRvTG9naW4oKSI+TG9naW48L2J1dHRvbj4KICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij5EZWZhdWx0OiBhZG1pbiAvIGFkbWluMTIzIOKAlCBsb2dpbiBrZSBiYWFkIHphcm9vciBiYWRsZWluLjwvcD4KICA8L2Rpdj4KPC9kaXY+CjxkaXYgaWQ9Im1haW5WaWV3IiBjbGFzcz0iaGlkZGVuIj4KICA8ZGl2IGNsYXNzPSJ0YWJzIiBpZD0idGFicyI+PC9kaXY+CiAgPG1haW4gaWQ9ImFwcCI+PC9tYWluPgo8L2Rpdj4KCjxkaXYgaWQ9Im1vZGFsIiBjbGFzcz0ibW9kYWwgaGlkZGVuIj48ZGl2IGNsYXNzPSJtYm94IiBpZD0ibWJveCI+PC9kaXY+PC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCAkPXM9PmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Iocyk7CmNvbnN0IGVzYz1zPT5TdHJpbmcocz8/JycpLnJlcGxhY2UoL1smPD4iJ10vZyxjPT4oeycmJzonJmFtcDsnLCc8JzonJmx0OycsJz4nOicmZ3Q7JywnIic6JyZxdW90OycsIiciOicmIzM5Oyd9W2NdKSk7CmNvbnN0IHRva2VuPSgpPT5sb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc3BfYWRtaW4nKTsKbGV0IFRBQj0ncXVldWUnLCBjYXRzPVtdLCBzZXR0aW5ncz17fTsKCmFzeW5jIGZ1bmN0aW9uIGFwaShwYXRoLG9wdHM9e30pewogIG9wdHMuaGVhZGVycz17Li4uKG9wdHMuaGVhZGVyc3x8e30pLCdDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJywnQXV0aG9yaXphdGlvbic6J0JlYXJlciAnK3Rva2VuKCl9OwogIGNvbnN0IHI9YXdhaXQgZmV0Y2gocGF0aCxvcHRzKTsKICBpZihyLnN0YXR1cz09PTQwMSl7bG9nb3V0KCk7dGhyb3cgbmV3IEVycm9yKCdTZXNzaW9uIGtoYXRhbS4gRG9iYXJhIGxvZ2luIGthcmVpbi4nKTt9CiAgcmV0dXJuIHIuanNvbigpOwp9CmZ1bmN0aW9uIGxvZ291dCgpe2xvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKCdzcF9hZG1pbicpO2xvY2F0aW9uLnJlbG9hZCgpO30KYXN5bmMgZnVuY3Rpb24gZG9Mb2dpbigpewogIGNvbnN0IHI9YXdhaXQgKGF3YWl0IGZldGNoKCcvYXBpL2FkbWluL2xvZ2luJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOnsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9LAogICAgYm9keTpKU09OLnN0cmluZ2lmeSh7dXNlcm5hbWU6JCgnI2xVc2VyJykudmFsdWUscGFzc3dvcmQ6JCgnI2xQYXNzJykudmFsdWV9KX0pKS5qc29uKCk7CiAgaWYoIXIub2speyQoJyNsRXJyJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJlcnIiPiR7ZXNjKHIuZXJyb3IpfTwvZGl2PmA7cmV0dXJuO30KICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc3BfYWRtaW4nLHIudG9rZW4pO2luaXQoKTsKfQpmdW5jdGlvbiBvcGVuTW9kYWwoaHRtbCl7JCgnI21ib3gnKS5pbm5lckhUTUw9aHRtbDskKCcjbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTt9CmZ1bmN0aW9uIGNsb3NlTW9kYWwoKXskKCcjbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTt9CiQoJyNtb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxlPT57aWYoZS50YXJnZXQuaWQ9PT0nbW9kYWwnKWNsb3NlTW9kYWwoKTt9KTsKCmFzeW5jIGZ1bmN0aW9uIGluaXQoKXsKICBpZighdG9rZW4oKSlyZXR1cm47CiAgJCgnI2xvZ2luVmlldycpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyQoJyNtYWluVmlldycpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyQoJyNsb2dvdXRCdG4nKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKICBjb25zdCBzPWF3YWl0IGFwaSgnL2FwaS9hZG1pbi9zZXR0aW5ncycpO3NldHRpbmdzPXMuc2V0dGluZ3M7CiAgY29uc3QgYz1hd2FpdCBhcGkoJy9hcGkvYWRtaW4vY2F0ZWdvcmllcycpO2NhdHM9Yy5jYXRlZ29yaWVzOwogIHJlbmRlclRhYnMoKTsKICBpZihzZXR0aW5ncy5zYW1wbGVfcHJpY2VzPT09JzEnKXsKICAgICQoJyNhcHAnKS5pbnNlcnRBZGphY2VudEhUTUwoJ2JlZm9yZWJlZ2luJywnJyk7CiAgfQogIHNob3dUYWIoJ3F1ZXVlJyk7Cn0KZnVuY3Rpb24gcmVuZGVyVGFicygpewogIGNvbnN0IHRhYnM9W1sncXVldWUnLCfwn6e+IFF1ZXVlJ10sWydxdW90ZXMnLCfwn5KsIFF1b3RlcyddLFsnc3RhZmYnLCfinpUgU3RhZmYgT3JkZXInXSxbJ3NlcnZpY2VzJywn8J+boO+4jyBTZXJ2aWNlcyddLFsnc2V0dGluZ3MnLCfimpnvuI8gU2V0dGluZ3MnXV07CiAgJCgnI3RhYnMnKS5pbm5lckhUTUw9dGFicy5tYXAoKFtrLGxdKT0+YDxidXR0b24gY2xhc3M9InRhYiAke1RBQj09PWs/J29uJzonJ30iIG9uY2xpY2s9InNob3dUYWIoJyR7a30nKSI+JHtsfTwvYnV0dG9uPmApLmpvaW4oJycpOwp9CmZ1bmN0aW9uIHNob3dUYWIoayl7VEFCPWs7cmVuZGVyVGFicygpOyh7cXVldWU6cmVuZGVyUXVldWUscXVvdGVzOnJlbmRlclF1b3RlcyxzdGFmZjpyZW5kZXJTdGFmZixzZXJ2aWNlczpyZW5kZXJTZXJ2aWNlcyxzZXR0aW5nczpyZW5kZXJTZXR0aW5nc30pW2tdKCk7fQoKLyogLS0tLS0tLS0tLSBRVUVVRSAtLS0tLS0tLS0tICovCmxldCBxRmlsdGVyPScnLHFTdGF0dXM9Jyc7CmFzeW5jIGZ1bmN0aW9uIHJlbmRlclF1ZXVlKCl7CiAgY29uc3Qgd2Fybj1zZXR0aW5ncy5zYW1wbGVfcHJpY2VzPT09JzEnP2A8ZGl2IGNsYXNzPSJ3YXJuIj7imqDvuI8gPGI+U2FtcGxlIHByaWNlczwvYj4gbGFnaSBodWkgaGFpbi4gQXNhbCByYXRlcyBsYWdhbmUga2UgbGl5ZSA8Yj5TZXJ2aWNlcyDihpIgUHJpY2luZyBSdWxlczwvYj4gbWVpbiBqYWF5ZWluLCBwaGlyIDxidXR0b24gY2xhc3M9InRtcGwiIG9uY2xpY2s9ImRpc21pc3NTYW1wbGUoKSI+T0sgc2FtYWpoIGdheWE8L2J1dHRvbj48L2Rpdj5gOicnOwogICQoJyNhcHAnKS5pbm5lckhUTUw9YCR7d2Fybn08ZGl2IGNsYXNzPSJjYXJkIj48aDI+8J+nviBPcmRlcnM8L2gyPgogICAgPGRpdiBjbGFzcz0icm93Ij48aW5wdXQgaWQ9InFTZWFyY2giIHBsYWNlaG9sZGVyPSJUb2tlbiAvIG1vYmlsZSAvIG5hYW0iIHN0eWxlPSJmbGV4OjEiIHZhbHVlPSIke2VzYyhxRmlsdGVyKX0iIG9ua2V5ZG93bj0iaWYoZXZlbnQua2V5PT09J0VudGVyJylkb1FTZWFyY2goKSI+CiAgICA8c2VsZWN0IGlkPSJxU3RhdHVzIiBzdHlsZT0id2lkdGg6YXV0byIgb25jaGFuZ2U9InFTdGF0dXM9dGhpcy52YWx1ZTtsb2FkT3JkZXJzKCkiPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPlNhYjwvb3B0aW9uPiR7WydxdW90ZV9yZXF1aXJlZCcsJ3F1b3RlX3NlbnQnLCdjb25maXJtZWQnLCdpbl9xdWV1ZScsJ2luX3Byb2dyZXNzJywncmVhZHknLCdjb21wbGV0ZWQnLCdjYW5jZWxsZWQnXS5tYXAocz0+YDxvcHRpb24gJHtxU3RhdHVzPT09cz8nc2VsZWN0ZWQnOicnfSB2YWx1ZT0iJHtzfSI+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgPC9zZWxlY3Q+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSIgb25jbGljaz0iZG9RU2VhcmNoKCkiPvCflI08L2J1dHRvbj48L2Rpdj4KICAgIDxkaXYgaWQ9Im9yZGVyTGlzdCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+PHAgY2xhc3M9ImhpbnQiPkxvYWQgaG8gcmFoYSBoYWkuLi48L3A+PC9kaXY+PC9kaXY+YDsKICBsb2FkT3JkZXJzKCk7Cn0KZnVuY3Rpb24gZG9RU2VhcmNoKCl7cUZpbHRlcj0kKCcjcVNlYXJjaCcpLnZhbHVlO2xvYWRPcmRlcnMoKTt9CmFzeW5jIGZ1bmN0aW9uIGRpc21pc3NTYW1wbGUoKXthd2FpdCBhcGkoJy9hcGkvYWRtaW4vc2V0dGluZ3MnLHttZXRob2Q6J1BVVCcsYm9keTpKU09OLnN0cmluZ2lmeSh7c2FtcGxlX3ByaWNlczonMCd9KX0pO3NldHRpbmdzLnNhbXBsZV9wcmljZXM9JzAnO3JlbmRlclF1ZXVlKCk7fQphc3luYyBmdW5jdGlvbiBsb2FkT3JkZXJzKCl7CiAgY29uc3Qgcj1hd2FpdCBhcGkoYC9hcGkvYWRtaW4vb3JkZXJzP3N0YXR1cz0ke2VuY29kZVVSSUNvbXBvbmVudChxU3RhdHVzKX0mcT0ke2VuY29kZVVSSUNvbXBvbmVudChxRmlsdGVyKX1gKTsKICBjb25zdCBwaWxsPXM9PnM9PT0ncXVvdGVfcmVxdWlyZWQnfHxzPT09J3F1b3RlX3NlbnQnPydwaWxsIHEnOihzPT09J3JlYWR5J3x8cz09PSdjb21wbGV0ZWQnKT8ncGlsbCBvayc6KHM9PT0nY2FuY2VsbGVkJyk/J3BpbGwgYmFkJzoncGlsbCc7CiAgJCgnI29yZGVyTGlzdCcpLmlubmVySFRNTD1yLm9yZGVycy5sZW5ndGg/YDx0YWJsZT48dHI+PHRoPlRva2VuPC90aD48dGg+Q3VzdG9tZXI8L3RoPjx0aD5TZXJ2aWNlPC90aD48dGg+UHJpY2U8L3RoPjx0aD5TdGF0dXM8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAke3Iub3JkZXJzLm1hcChvPT5gPHRyPjx0ZD48Yj4ke2VzYyhvLnRva2VuX25vfHwn4oCUJyl9PC9iPjwvdGQ+PHRkPiR7ZXNjKG8uY3VzdG9tZXJfbmFtZSl9PGJyPjxzbWFsbD4ke2VzYyhvLmN1c3RvbWVyX21vYmlsZSl9PC9zbWFsbD48L3RkPgogICAgPHRkPiR7ZXNjKG8uc2VydmljZV9pY29uKX0gJHtlc2Moby5zZXJ2aWNlX25hbWUpfTwvdGQ+PHRkPiR7by50b3RhbF9wcmljZSE9bnVsbD8nUnMuJytOdW1iZXIoby50b3RhbF9wcmljZSkudG9Mb2NhbGVTdHJpbmcoKTooby5xdW90ZWRfdG90YWw/J1E6JytOdW1iZXIoby5xdW90ZWRfdG90YWwpLnRvTG9jYWxlU3RyaW5nKCk6J+KAlCcpfTwvdGQ+CiAgICA8dGQ+PHNwYW4gY2xhc3M9IiR7cGlsbChvLnN0YXR1cyl9Ij4ke2VzYyhvLnN0YXR1c191cil9PC9zcGFuPjwvdGQ+CiAgICA8dGQ+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSIgb25jbGljaz0ib3JkZXJEZXRhaWwoJHtvLmlkfSkiPkRla2hlaW48L2J1dHRvbj48L3RkPjwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gCiAgICA6JzxwIGNsYXNzPSJoaW50Ij5Lb2kgb3JkZXIgbmFoaSBtaWxhLjwvcD4nOwp9CmFzeW5jIGZ1bmN0aW9uIG9yZGVyRGV0YWlsKGlkKXsKICBjb25zdCByPWF3YWl0IGFwaSgnL2FwaS9hZG1pbi9vcmRlci8nK2lkKTtjb25zdCBvPXIub3JkZXI7CiAgY29uc3QgZGV0PU9iamVjdC5lbnRyaWVzKG8uZGV0YWlscykubWFwKChbayx2XSk9PmA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4+JHtlc2Moby5maWVsZF9sYWJlbHNba118fGspfTwvc3Bhbj48Yj4ke2VzYyh2KX08L2I+PC9kaXY+YCkuam9pbignJyk7CiAgY29uc3QgbGluZXM9KG8ucHJpY2VfYnJlYWtkb3dufHxbXSkubWFwKGw9PmA8ZGl2IGNsYXNzPSJrdiI+PHNwYW4+JHtlc2MobC5sYWJlbCl9PC9zcGFuPjxiPlJzLiAke051bWJlcihsLmFtb3VudCkudG9Mb2NhbGVTdHJpbmcoKX08L2I+PC9kaXY+YCkuam9pbignJyk7CiAgb3Blbk1vZGFsKGA8aDM+JHtlc2Moby50b2tlbl9ub3x8J1F1b3RlIHBlbmRpbmcnKX0g4oCUICR7ZXNjKG8uc2VydmljZV9uYW1lKX08L2gzPgogICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuPkN1c3RvbWVyPC9zcGFuPjxiPiR7ZXNjKG8uY3VzdG9tZXJfbmFtZSl9ICgke2VzYyhvLmN1c3RvbWVyX21vYmlsZSl9KTwvYj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Imt2Ij48c3Bhbj5Tb3VyY2U8L3NwYW4+PGI+JHtlc2Moby5zb3VyY2UpfSR7by5vdHBfdmVyaWZpZWQ/JyDigKIgT1RQIOKckyc6Jyd9PC9iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuPlN0YXR1czwvc3Bhbj48Yj4ke2VzYyhvLnN0YXR1c191cil9PC9iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ia3YiPjxzcGFuPlFhdGFhcjwvc3Bhbj48Yj4ke28ucXVldWVfcG9zaXRpb24/PyfigJQnfTwvYj48L2Rpdj4KICAgICR7ZGV0fTxoMyBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5QcmljZTwvaDM+JHtsaW5lc3x8JzxwIGNsYXNzPSJoaW50Ij7igJQ8L3A+J30KICAgICR7by50b3RhbF9wcmljZSE9bnVsbD9gPGRpdiBjbGFzcz0ia3YiPjxzcGFuPjxiPlRvdGFsPC9iPjwvc3Bhbj48Yj5Scy4gJHtOdW1iZXIoby50b3RhbF9wcmljZSkudG9Mb2NhbGVTdHJpbmcoKX08L2I+PC9kaXY+YDonJ30KICAgICR7by5xdW90ZWRfdG90YWw/YDxkaXYgY2xhc3M9Imt2Ij48c3Bhbj48Yj5RdW90ZTwvYj48L3NwYW4+PGI+UnMuICR7TnVtYmVyKG8ucXVvdGVkX3RvdGFsKS50b0xvY2FsZVN0cmluZygpfTwvYj48L2Rpdj48ZGl2IGNsYXNzPSJrdiI+PHNwYW4+Tm90ZTwvc3Bhbj48Yj4ke2VzYyhvLnF1b3RlX25vdGUpfTwvYj48L2Rpdj5gOicnfQogICAgJHsoby5maWxlc3x8W10pLmxlbmd0aD9gPGgzIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPkZpbGVzPC9oMz5gKyhvLmZpbGVzLm1hcCgoZixpKT0+YDxkaXYgY2xhc3M9Imt2Ij48c3Bhbj4ke2VzYyhmLm5hbWUpfTwvc3Bhbj48Yj48YSBocmVmPSIvYXBpL2FkbWluL29yZGVyLyR7by5pZH0vZmlsZS8ke2l9IiB0YXJnZXQ9Il9ibGFuayI+RG93bmxvYWQ8L2E+PC9iPjwvZGl2PmApLmpvaW4oJycpKTonJ30KICAgIDxoMyBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5VcGRhdGU8L2gzPgogICAgPGRpdiBjbGFzcz0iZ3JpZDIiPgogICAgICA8ZGl2PjxsYWJlbD5TdGF0dXM8L2xhYmVsPjxzZWxlY3QgaWQ9Im1TdGF0dXMiPiR7Wydjb25maXJtZWQnLCdpbl9xdWV1ZScsJ2luX3Byb2dyZXNzJywncmVhZHknLCdjb21wbGV0ZWQnLCdjYW5jZWxsZWQnXS5tYXAocz0+YDxvcHRpb24gJHtvLnN0YXR1cz09PXM/J3NlbGVjdGVkJzonJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2PjxsYWJlbD5BbmRhemFuIHdhcXQgKG1pbik8L2xhYmVsPjxpbnB1dCBpZD0ibUV0YSIgdHlwZT0ibnVtYmVyIiB2YWx1ZT0iJHtvLmVzdGltYXRlZF9taW51dGVzPz8nJ30iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8bGFiZWw+UXVvdGUgKFJzLikg4oCUIHNpcmYgcXVvdGVfcmVxdWlyZWQgb3JkZXJzIGtlIGxpeWU8L2xhYmVsPjxpbnB1dCBpZD0ibVF1b3RlIiB0eXBlPSJudW1iZXIiIHBsYWNlaG9sZGVyPSIke28ucXVvdGVkX3RvdGFsfHwnJ30iPgogICAgPGxhYmVsPlF1b3RlIG5vdGUgKGN1c3RvbWVyIGtvIG5hemFyIGFheWVnYSk8L2xhYmVsPjx0ZXh0YXJlYSBpZD0ibVFOb3RlIiBzdHlsZT0ibWluLWhlaWdodDo1MHB4Ij4ke2VzYyhvLnF1b3RlX25vdGV8fCcnKX08L3RleHRhcmVhPgogICAgPGxhYmVsPkFkbWluIG5vdGUgKHNpcmYgYWFwIGtlIGxpeWUpPC9sYWJlbD48dGV4dGFyZWEgaWQ9Im1BTm90ZSIgc3R5bGU9Im1pbi1oZWlnaHQ6NTBweCI+JHtlc2Moby5hZG1pbl9ub3RlfHwnJyl9PC90ZXh0YXJlYT4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGJ1dHRvbiBjbGFzcz0iYnRuIiBvbmNsaWNrPSJzYXZlT3JkZXIoJHtvLmlkfSkiPlNhdmUgS2FyZWluPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgb25jbGljaz0iY2xvc2VNb2RhbCgpIj5CYW5kIEthcmVpbjwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBpZD0ibUVyciI+PC9kaXY+YCk7Cn0KYXN5bmMgZnVuY3Rpb24gc2F2ZU9yZGVyKGlkKXsKICBjb25zdCBib2R5PXtzdGF0dXM6JCgnI21TdGF0dXMnKS52YWx1ZSxhZG1pbl9ub3RlOiQoJyNtQU5vdGUnKS52YWx1ZSxxdW90ZV9ub3RlOiQoJyNtUU5vdGUnKS52YWx1ZX07CiAgaWYoJCgnI21RdW90ZScpLnZhbHVlKWJvZHkucXVvdGVkX3RvdGFsPU51bWJlcigkKCcjbVF1b3RlJykudmFsdWUpOwogIGlmKCQoJyNtRXRhJykudmFsdWUpYm9keS5lc3RpbWF0ZWRfbWludXRlcz1OdW1iZXIoJCgnI21FdGEnKS52YWx1ZSk7CiAgY29uc3Qgcj1hd2FpdCBhcGkoJy9hcGkvYWRtaW4vb3JkZXIvJytpZCx7bWV0aG9kOidQQVRDSCcsYm9keTpKU09OLnN0cmluZ2lmeShib2R5KX0pOwogIGlmKCFyLm9rKXskKCcjbUVycicpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iZXJyIj4ke2VzYyhyLmVycm9yKX08L2Rpdj5gO3JldHVybjt9CiAgY2xvc2VNb2RhbCgpO2xvYWRPcmRlcnMoKTsKfQoKLyogLS0tLS0tLS0tLSBRVU9URVMgLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJRdW90ZXMoKXsKICBjb25zdCByPWF3YWl0IGFwaSgnL2FwaS9hZG1pbi9vcmRlcnM/c3RhdHVzPXF1b3RlX3JlcXVpcmVkJyk7CiAgY29uc3QgcjI9YXdhaXQgYXBpKCcvYXBpL2FkbWluL29yZGVycz9zdGF0dXM9cXVvdGVfc2VudCcpOwogIGNvbnN0IGFsbD1bLi4uci5vcmRlcnMsLi4ucjIub3JkZXJzXTsKICAkKCcjYXBwJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+8J+SrCBRdW90ZSBXYWxlIE9yZGVyczwvaDI+PHAgY2xhc3M9ImhpbnQiPkluIG9yZGVycyBraSBwcmljZSBhdXRvLWNhbGN1bGF0ZSBuYWhpIGhvIHNha2kuIFF1b3RlIGRlaW4sIGN1c3RvbWVyIG1hbnpvb3Iga2FyZWdhIHRvIHRva2VuIGJhbiBqYXllZ2EuPC9wPgogICR7YWxsLmxlbmd0aD9gPHRhYmxlPjx0cj48dGg+Q3VzdG9tZXI8L3RoPjx0aD5TZXJ2aWNlPC90aD48dGg+U3RhdHVzPC90aD48dGg+PC90aD48L3RyPiR7YWxsLm1hcChvPT5gPHRyPjx0ZD4ke2VzYyhvLmN1c3RvbWVyX25hbWUpfTxicj48c21hbGw+JHtlc2Moby5jdXN0b21lcl9tb2JpbGUpfTwvc21hbGw+PC90ZD48dGQ+JHtlc2Moby5zZXJ2aWNlX25hbWUpfTwvdGQ+PHRkPjxzcGFuIGNsYXNzPSJwaWxsIHEiPiR7ZXNjKG8uc3RhdHVzX3VyKX08L3NwYW4+PC90ZD48dGQ+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSIgb25jbGljaz0ib3JkZXJEZXRhaWwoJHtvLmlkfSkiPlF1b3RlIERlaW48L2J1dHRvbj48L3RkPjwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gOic8cCBjbGFzcz0iaGludCI+S29pIHBlbmRpbmcgcXVvdGUgbmFoaS48L3A+J308L2Rpdj5gOwp9CgovKiAtLS0tLS0tLS0tIFNUQUZGIE9SREVSIC0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gcmVuZGVyU3RhZmYoKXsKICAkKCcjYXBwJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+4p6VIFN0YWZmIE9yZGVyIChXYWxrLWluIEN1c3RvbWVyKTwvaDI+CiAgPHAgY2xhc3M9ImhpbnQiPkR1a2FuIHBhciBhYXllIGN1c3RvbWVyIGthIG9yZGVyIHlhaGluIHNlIGJhbmF5ZWluLiBOZWVjaGUgYnV0dG9uIGRhYmF5ZWluIOKAlCBib29raW5nIGZvcm0ga2h1bGVnYSwgT1RQIGtpIHphcm9vcmF0IG5haGkgaG9naSAoYWFwIGFkbWluIGtlIHRvciBwYXIgbG9naW4gaGFpbikuPC9wPgogIDxidXR0b24gY2xhc3M9ImJ0biIgb25jbGljaz0id2luZG93Lm9wZW4oJy9ib29rP3NvdXJjZT1zdGFmZicsJ19ibGFuaycpIj5TdGFmZiBPcmRlciBGb3JtIEtob2xlaW48L2J1dHRvbj4KICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+Tm90ZTogeWUgaXNpIGJyb3dzZXIgbWVpbiBrYWFtIGthcmVnYSBqYWhhbiBhZG1pbiBsb2dpbiBoYWkuPC9wPjwvZGl2PmA7Cn0KCi8qIC0tLS0tLS0tLS0gU0VSVklDRVMgLS0tLS0tLS0tLSAqLwpsZXQgc3ZjQ2F0PW51bGw7CmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNlcnZpY2VzKCl7CiAgJCgnI2FwcCcpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iY2FyZCI+PGgyPvCfm6DvuI8gU2VydmljZXM8L2gyPjxwIGNsYXNzPSJoaW50Ij5DYXRlZ29yaWVzIGFkZC9lZGl0L2RlYWN0aXZhdGUga2FyZWluLCBmaWVsZHMgYXVyIHByaWNpbmcgcnVsZXMgbWFuYWdlIGthcmVpbi48L3A+CiAgPGRpdiBpZD0iY2F0TGlzdCI+PC9kaXY+CiAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPk5heWkgQ2F0ZWdvcnk8L2gyPgogIDxkaXYgY2xhc3M9ImdyaWQyIj48ZGl2PjxsYWJlbD5OYWFtIChVcmR1KTwvbGFiZWw+PGlucHV0IGlkPSJuY1VyIj48L2Rpdj48ZGl2PjxsYWJlbD5TbHVnIChlbmdsaXNoLCB1bmlxdWUpPC9sYWJlbD48aW5wdXQgaWQ9Im5jU2x1ZyIgcGxhY2Vob2xkZXI9Im1hc2FsYW46IGJhbm5lcnMiPjwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9ImdyaWQyIj48ZGl2PjxsYWJlbD5JY29uIChlbW9qaSk8L2xhYmVsPjxpbnB1dCBpZD0ibmNJY29uIiBwbGFjZWhvbGRlcj0i8J+WqO+4jyI+PC9kaXY+PGRpdj48bGFiZWw+QW5kYXphbiB3YXF0IChtaW51dGUpPC9sYWJlbD48aW5wdXQgaWQ9Im5jRXRhIiB0eXBlPSJudW1iZXIiIHZhbHVlPSI2MCI+PC9kaXY+PC9kaXY+CiAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4IiBvbmNsaWNrPSJhZGRDYXQoKSI+Q2F0ZWdvcnkgQWRkIEthcmVpbjwvYnV0dG9uPjxkaXYgaWQ9ImNFcnIiPjwvZGl2PjwvZGl2PgogIDxkaXYgaWQ9ImNhdERldGFpbCI+PC9kaXY+YDsKICBsb2FkQ2F0cygpOwp9CmFzeW5jIGZ1bmN0aW9uIGxvYWRDYXRzKCl7CiAgY29uc3Qgcj1hd2FpdCBhcGkoJy9hcGkvYWRtaW4vY2F0ZWdvcmllcycpO2NhdHM9ci5jYXRlZ29yaWVzOwogICQoJyNjYXRMaXN0JykuaW5uZXJIVE1MPWA8dGFibGU+PHRyPjx0aD48L3RoPjx0aD5OYWFtPC90aD48dGg+U2x1ZzwvdGg+PHRoPldhcXQ8L3RoPjx0aD5BY3RpdmU8L3RoPjx0aD48L3RoPjwvdHI+JHtjYXRzLm1hcChjPT5gCiAgPHRyIHN0eWxlPSIke2MuYWN0aXZlPycnOidvcGFjaXR5Oi41J30iPjx0ZCBzdHlsZT0iZm9udC1zaXplOjIwcHgiPiR7ZXNjKGMuaWNvbil9PC90ZD48dGQ+PGI+JHtlc2MoYy5uYW1lX3VyKX08L2I+PC90ZD48dGQ+PHNtYWxsPiR7ZXNjKGMuc2x1Zyl9PC9zbWFsbD48L3RkPgogIDx0ZD4ke2MuZXN0aW1hdGVkX21pbnV0ZXN9IG1pbjwvdGQ+PHRkPiR7Yy5hY3RpdmU/J+KchSc6J+KdjCd9PC90ZD4KICA8dGQ+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSIgb25jbGljaz0iZWRpdENhdCgke2MuaWR9KSI+TWFuYWdlPC9idXR0b24+PC90ZD48L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YDsKfQphc3luYyBmdW5jdGlvbiBhZGRDYXQoKXsKICBjb25zdCBib2R5PXtuYW1lX3VyOiQoJyNuY1VyJykudmFsdWUsc2x1ZzokKCcjbmNTbHVnJykudmFsdWUsaWNvbjokKCcjbmNJY29uJykudmFsdWUsZXN0aW1hdGVkX21pbnV0ZXM6TnVtYmVyKCQoJyNuY0V0YScpLnZhbHVlKX07CiAgY29uc3Qgcj1hd2FpdCBhcGkoJy9hcGkvYWRtaW4vY2F0ZWdvcmllcycse21ldGhvZDonUE9TVCcsYm9keTpKU09OLnN0cmluZ2lmeShib2R5KX0pOwogIGlmKCFyLm9rKXskKCcjY0VycicpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iZXJyIj4ke2VzYyhyLmVycm9yKX08L2Rpdj5gO3JldHVybjt9CiAgcmVuZGVyU2VydmljZXMoKTsKfQphc3luYyBmdW5jdGlvbiBlZGl0Q2F0KGlkKXsKICBzdmNDYXQ9Y2F0cy5maW5kKGM9PmMuaWQ9PT1pZCk7CiAgY29uc3QgW2Yscl09YXdhaXQgUHJvbWlzZS5hbGwoW2FwaShgL2FwaS9hZG1pbi9jYXRlZ29yaWVzLyR7aWR9L2ZpZWxkc2ApLGFwaShgL2FwaS9hZG1pbi9jYXRlZ29yaWVzLyR7aWR9L3J1bGVzYCldKTsKICAkKCcjY2F0RGV0YWlsJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+JHtlc2Moc3ZjQ2F0Lmljb24pfSAke2VzYyhzdmNDYXQubmFtZV91cil9IOKAlCBNYW5hZ2U8L2gyPgogIDxkaXYgY2xhc3M9ImdyaWQyIj4KICAgIDxkaXY+PGxhYmVsPk5hYW0gKFVyZHUpPC9sYWJlbD48aW5wdXQgaWQ9ImVjVXIiIHZhbHVlPSIke2VzYyhzdmNDYXQubmFtZV91cil9Ij48L2Rpdj4KICAgIDxkaXY+PGxhYmVsPkljb248L2xhYmVsPjxpbnB1dCBpZD0iZWNJY29uIiB2YWx1ZT0iJHtlc2Moc3ZjQ2F0Lmljb24pfSI+PC9kaXY+CiAgICA8ZGl2PjxsYWJlbD5Tb3J0IG9yZGVyPC9sYWJlbD48aW5wdXQgaWQ9ImVjU29ydCIgdHlwZT0ibnVtYmVyIiB2YWx1ZT0iJHtzdmNDYXQuc29ydF9vcmRlcn0iPjwvZGl2PgogICAgPGRpdj48bGFiZWw+QW5kYXphbiB3YXF0IChtaW4pPC9sYWJlbD48aW5wdXQgaWQ9ImVjRXRhIiB0eXBlPSJudW1iZXIiIHZhbHVlPSIke3N2Y0NhdC5lc3RpbWF0ZWRfbWludXRlc30iPjwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNtIiBvbmNsaWNrPSJzYXZlQ2F0KCR7aWR9KSI+U2F2ZTwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSAke3N2Y0NhdC5hY3RpdmU/J2J0bi1kYW5nZXInOididG4tZ3JlZW4nfSIgb25jbGljaz0idG9nZ2xlQ2F0KCR7aWR9LCR7c3ZjQ2F0LmFjdGl2ZT8wOjF9KSI+JHtzdmNDYXQuYWN0aXZlPydEZWFjdGl2YXRlJzonQWN0aXZhdGUnfTwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSBidG4tZ2hvc3QiIG9uY2xpY2s9IiQoJyNjYXREZXRhaWwnKS5pbm5lckhUTUw9JyciPkJhbmQ8L2J1dHRvbj4KICA8L2Rpdj48ZGl2IGlkPSJlY0VyciI+PC9kaXY+CiAgPGgyIHN0eWxlPSJtYXJnaW4tdG9wOjE2cHgiPkZpZWxkcyAoZm9ybSBrZSBraGFhbmUpPC9oMj4KICA8dGFibGU+PHRyPjx0aD5MYWJlbDwvdGg+PHRoPktleTwvdGg+PHRoPlR5cGU8L3RoPjx0aD5SZXE8L3RoPjx0aD48L3RoPjwvdHI+CiAgJHtmLmZpZWxkcy5tYXAoeD0+YDx0cj48dGQ+JHtlc2MoeC5sYWJlbF91cil9PC90ZD48dGQ+PHNtYWxsPiR7ZXNjKHguZmllbGRfa2V5KX08L3NtYWxsPjwvdGQ+PHRkPiR7ZXNjKHguZmllbGRfdHlwZSl9PC90ZD48dGQ+JHt4LnJlcXVpcmVkPyfinIUnOicnfTwvdGQ+CiAgPHRkPjxidXR0b24gY2xhc3M9ImJ0biBidG4tc20gYnRuLWdob3N0IiBvbmNsaWNrPSdlZGl0RmllbGQoJHtKU09OLnN0cmluZ2lmeSh4KS5yZXBsYWNlKC8nL2csIiYjMzk7Iil9KSc+RWRpdDwvYnV0dG9uPgogIDxidXR0b24gY2xhc3M9ImJ0biBidG4tc20gYnRuLWRhbmdlciIgb25jbGljaz0iZGVsRmllbGQoJHt4LmlkfSkiPsOXPC9idXR0b24+PC90ZD48L3RyPmApLmpvaW4oJycpfTwvdGFibGU+CiAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSIgc3R5bGU9Im1hcmdpbi10b3A6OHB4IiBvbmNsaWNrPSJmaWVsZEZvcm0oKSI+KyBGaWVsZCBBZGQgS2FyZWluPC9idXR0b24+PGRpdiBpZD0iZmZab25lIj48L2Rpdj4KICA8aDIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+UHJpY2luZyBSdWxlcyAocWVlbWF0IGtlIHVzb29sKTwvaDI+CiAgPHAgY2xhc3M9ImhpbnQiPlJ1bGVzIHRhcnRpYiAoc29ydCBvcmRlcikgc2UgbGFndGUgaGFpbi4gPGI+QmFja2VuZCBoaSBhc2FsIHByaWNlIG5pa2FhbHRhIGhhaTwvYj4g4oCUIGJyb3dzZXIga2kgYmhlamkgcHJpY2UgcGFyIGJoYXJvc2EgbmFoaSBob3RhLjwvcD4KICA8dGFibGU+PHRyPjx0aD5MYWJlbDwvdGg+PHRoPlR5cGU8L3RoPjx0aD5Tb3J0PC90aD48dGg+QWN0aXZlPC90aD48dGg+PC90aD48L3RyPgogICR7ci5ydWxlcy5tYXAoeD0+YDx0cj48dGQ+JHtlc2MoeC5sYWJlbF91cil9PC90ZD48dGQ+PHNtYWxsPiR7ZXNjKHgudHlwZSl9PC9zbWFsbD48L3RkPjx0ZD4ke3guc29ydF9vcmRlcn08L3RkPjx0ZD4ke3guYWN0aXZlPyfinIUnOifinYwnfTwvdGQ+CiAgPHRkPjxidXR0b24gY2xhc3M9ImJ0biBidG4tc20gYnRuLWdob3N0IiBvbmNsaWNrPSdlZGl0UnVsZSgke0pTT04uc3RyaW5naWZ5KHgpLnJlcGxhY2UoLycvZywiJiMzOTsiKX0pJz5FZGl0PC9idXR0b24+CiAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSBidG4tZGFuZ2VyIiBvbmNsaWNrPSJkZWxSdWxlKCR7eC5pZH0pIj7DlzwvYnV0dG9uPjwvdGQ+PC90cj5gKS5qb2luKCcnKX08L3RhYmxlPgogIDxidXR0b24gY2xhc3M9ImJ0biBidG4tc20iIHN0eWxlPSJtYXJnaW4tdG9wOjhweCIgb25jbGljaz0icnVsZUZvcm0oKSI+KyBSdWxlIEFkZCBLYXJlaW48L2J1dHRvbj48ZGl2IGlkPSJyZlpvbmUiPjwvZGl2PgogIDwvZGl2PmA7CiAgd2luZG93LnNjcm9sbFRvKDAsZG9jdW1lbnQuYm9keS5zY3JvbGxIZWlnaHQpOwp9CmFzeW5jIGZ1bmN0aW9uIHNhdmVDYXQoaWQpewogIGNvbnN0IHI9YXdhaXQgYXBpKCcvYXBpL2FkbWluL2NhdGVnb3JpZXMvJytpZCx7bWV0aG9kOidQVVQnLGJvZHk6SlNPTi5zdHJpbmdpZnkoe25hbWVfdXI6JCgnI2VjVXInKS52YWx1ZSxpY29uOiQoJyNlY0ljb24nKS52YWx1ZSxzb3J0X29yZGVyOk51bWJlcigkKCcjZWNTb3J0JykudmFsdWUpLGVzdGltYXRlZF9taW51dGVzOk51bWJlcigkKCcjZWNFdGEnKS52YWx1ZSl9KX0pOwogIGlmKCFyLm9rKXskKCcjZWNFcnInKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+JHtlc2Moci5lcnJvcil9PC9kaXY+YDtyZXR1cm47fQogIHJlbmRlclNlcnZpY2VzKCk7Cn0KYXN5bmMgZnVuY3Rpb24gdG9nZ2xlQ2F0KGlkLHRvKXthd2FpdCBhcGkoJy9hcGkvYWRtaW4vY2F0ZWdvcmllcy8nK2lkLHttZXRob2Q6J1BVVCcsYm9keTpKU09OLnN0cmluZ2lmeSh7YWN0aXZlOiEhdG99KX0pO3JlbmRlclNlcnZpY2VzKCk7fQpmdW5jdGlvbiBmaWVsZEZvcm0oZil7CiAgZj1mfHx7ZmllbGRfa2V5OicnLGxhYmVsX3VyOicnLGZpZWxkX3R5cGU6J3RleHQnLG9wdGlvbnM6W10scmVxdWlyZWQ6ZmFsc2UscGxhY2Vob2xkZXJfdXI6JycsdmFsaWRhdGlvbjp7fSxzb3J0X29yZGVyOjk5LGFjdGl2ZTp0cnVlfTsKICBjb25zdCBvcHRzPShmLm9wdGlvbnN8fFtdKS5tYXAobz0+YCR7by52YWx1ZX18JHtvLmxhYmVsX3VyfWApLmpvaW4oJ1xuJyk7CiAgJCgnI2ZmWm9uZScpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZjlmZCI+PGgzPiR7Zi5pZD8nRmllbGQgRWRpdCc6J05heWEgRmllbGQnfTwvaDM+CiAgPGRpdiBjbGFzcz0iZ3JpZDIiPgogIDxkaXY+PGxhYmVsPkZpZWxkIGtleSAoZW5nbGlzaCwgdW5pcXVlKTwvbGFiZWw+PGlucHV0IGlkPSJmZktleSIgdmFsdWU9IiR7ZXNjKGYuZmllbGRfa2V5KX0iICR7Zi5pZD8nZGlzYWJsZWQnOicnfT48L2Rpdj4KICA8ZGl2PjxsYWJlbD5MYWJlbCAoVXJkdSk8L2xhYmVsPjxpbnB1dCBpZD0iZmZMYWJlbCIgdmFsdWU9IiR7ZXNjKGYubGFiZWxfdXIpfSI+PC9kaXY+CiAgPGRpdj48bGFiZWw+VHlwZTwvbGFiZWw+PHNlbGVjdCBpZD0iZmZUeXBlIj4ke1sndGV4dCcsJ251bWJlcicsJ3RleHRhcmVhJywnc2VsZWN0JywncmFkaW8nLCdjaGVja2JveCcsJ2ZpbGUnXS5tYXAodD0+YDxvcHRpb24gJHtmLmZpZWxkX3R5cGU9PT10PydzZWxlY3RlZCc6Jyd9PiR7dH08L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICA8ZGl2PjxsYWJlbD5Tb3J0PC9sYWJlbD48aW5wdXQgaWQ9ImZmU29ydCIgdHlwZT0ibnVtYmVyIiB2YWx1ZT0iJHtmLnNvcnRfb3JkZXJ9Ij48L2Rpdj48L2Rpdj4KICA8ZGl2PjxsYWJlbD5PcHRpb25zIChzZWxlY3QvcmFkaW8ga2UgbGl5ZSDigJQgaGFyIGxpbmU6IHZhbHVlfExhYmVsKTwvbGFiZWw+PHRleHRhcmVhIGlkPSJmZk9wdHMiPiR7ZXNjKG9wdHMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgPGRpdj48bGFiZWw+UGxhY2Vob2xkZXI8L2xhYmVsPjxpbnB1dCBpZD0iZmZQaCIgdmFsdWU9IiR7ZXNjKGYucGxhY2Vob2xkZXJfdXJ8fCcnKX0iPjwvZGl2PgogIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij48bGFiZWwgc3R5bGU9Im1hcmdpbjowIj48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJmZlJlcSIgJHtmLnJlcXVpcmVkPydjaGVja2VkJzonJ30gc3R5bGU9IndpZHRoOmF1dG8iPiBaYXJvb3JpPC9sYWJlbD4KICA8bGFiZWwgc3R5bGU9Im1hcmdpbjowIj48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJmZkFjdCIgJHtmLmFjdGl2ZT8nY2hlY2tlZCc6Jyd9IHN0eWxlPSJ3aWR0aDphdXRvIj4gQWN0aXZlPC9sYWJlbD48L2Rpdj4KICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjxidXR0b24gY2xhc3M9ImJ0biBidG4tc20iIG9uY2xpY2s9InNhdmVGaWVsZCgke2YuaWR8fCdudWxsJ30pIj5TYXZlPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSBidG4tZ2hvc3QiIG9uY2xpY2s9IiQoJyNmZlpvbmUnKS5pbm5lckhUTUw9JyciPkNhbmNlbDwvYnV0dG9uPjwvZGl2PjxkaXYgaWQ9ImZmRXJyIj48L2Rpdj48L2Rpdj5gOwp9CmZ1bmN0aW9uIHBhcnNlT3B0cyh0KXtyZXR1cm4gdC5zcGxpdCgnXG4nKS5tYXAobD0+bC50cmltKCkpLmZpbHRlcihCb29sZWFuKS5tYXAobD0+e2NvbnN0IFt2YWx1ZSwuLi5yZXN0XT1sLnNwbGl0KCd8Jyk7cmV0dXJue3ZhbHVlOnZhbHVlLnRyaW0oKSxsYWJlbF91cjpyZXN0LmpvaW4oJ3wnKS50cmltKCl8fHZhbHVlLnRyaW0oKX07fSk7fQphc3luYyBmdW5jdGlvbiBzYXZlRmllbGQoaWQpewogIGNvbnN0IGJvZHk9e2ZpZWxkX2tleTokKCcjZmZLZXknKS52YWx1ZSxsYWJlbF91cjokKCcjZmZMYWJlbCcpLnZhbHVlLGZpZWxkX3R5cGU6JCgnI2ZmVHlwZScpLnZhbHVlLG9wdGlvbnM6cGFyc2VPcHRzKCQoJyNmZk9wdHMnKS52YWx1ZSksCiAgICByZXF1aXJlZDokKCcjZmZSZXEnKS5jaGVja2VkLGFjdGl2ZTokKCcjZmZBY3QnKS5jaGVja2VkLHBsYWNlaG9sZGVyX3VyOiQoJyNmZlBoJykudmFsdWUsc29ydF9vcmRlcjpOdW1iZXIoJCgnI2ZmU29ydCcpLnZhbHVlKX07CiAgY29uc3Qgcj1pZD9hd2FpdCBhcGkoJy9hcGkvYWRtaW4vZmllbGRzLycraWQse21ldGhvZDonUFVUJyxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpfSkKICAgICAgICAgICA6YXdhaXQgYXBpKGAvYXBpL2FkbWluL2NhdGVnb3JpZXMvJHtzdmNDYXQuaWR9L2ZpZWxkc2Ase21ldGhvZDonUE9TVCcsYm9keTpKU09OLnN0cmluZ2lmeShib2R5KX0pOwogIGlmKCFyLm9rKXskKCcjZmZFcnInKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+JHtlc2Moci5lcnJvcil9PC9kaXY+YDtyZXR1cm47fQogIGVkaXRDYXQoc3ZjQ2F0LmlkKTsKfQphc3luYyBmdW5jdGlvbiBkZWxGaWVsZChpZCl7aWYoY29uZmlybSgnRmllbGQgZGVsZXRlIGthcmVpbj8nKSl7YXdhaXQgYXBpKCcvYXBpL2FkbWluL2ZpZWxkcy8nK2lkLHttZXRob2Q6J0RFTEVURSd9KTtlZGl0Q2F0KHN2Y0NhdC5pZCk7fX0KZnVuY3Rpb24gZWRpdEZpZWxkKGYpe2ZpZWxkRm9ybShmKTt9Cgpjb25zdCBSVUxFX1RZUEVTPVsnYmFzZScsJ3Blcl91bml0JywncGVyX2FyZWEnLCdvcHRpb25fcmF0ZScsJ29wdGlvbl9jaGFyZ2UnLCd0aWVyJywncGVyY2VudCcsJ21pbmltdW0nLCdmaXhlZCcsJ21hbnVhbCddOwpjb25zdCBSVUxFX1RNUEw9ewogYmFzZToneyJhbW91bnQiOiAxMDB9JywKIHBlcl91bml0Oid7ImZpZWxkIjogInBhZ2VzIiwgIm11bHRpcGx5X2J5IjogWyJjb3BpZXMiXSwgImFtb3VudCI6IDV9JywKIHBlcl9hcmVhOid7IndpZHRoX2ZpZWxkIjogIndpZHRoIiwgImhlaWdodF9maWVsZCI6ICJoZWlnaHQiLCAidW5pdF9maWVsZCI6ICJ1bml0IiwgInF1YW50aXR5X2ZpZWxkIjogInF1YW50aXR5IiwgInVuaXQiOiAic3FmdCIsICJhbW91bnQiOiAxNTAsICJtaW5fYmlsbGFibGVfYXJlYSI6IDJ9JywKIG9wdGlvbl9yYXRlOid7ImZpZWxkIjogImNvbG91ciIsICJyYXRlcyI6IHsiY29sb3VyIjogMTAsICJidyI6IDN9LCAicGVyIjogInVuaXRzIiwgInVuaXRfZmllbGRzIjogWyJwYWdlcyIsICJjb3BpZXMiXX0nLAogb3B0aW9uX2NoYXJnZToneyJmaWVsZCI6ICJkZXNpZ25fbmVlZGVkIiwgImNoYXJnZXMiOiB7InllcyI6IDUwMCwgIm5vIjogMH19JywKIHRpZXI6J3siZmllbGQiOiAicXVhbnRpdHkiLCAidGllcnMiOiBbeyJtaW4iOiAxLCAibWF4IjogMTAwLCAicmF0ZSI6IDh9LCB7Im1pbiI6IDEwMSwgIm1heCI6IDUwMCwgInJhdGUiOiA2fSwgeyJtaW4iOiA1MDEsICJtYXgiOiBudWxsLCAicmF0ZSI6IDR9XX0nLAogcGVyY2VudDoneyJraW5kIjogInRheCIsICJwZXJjZW50IjogNX0nLAogbWluaW11bToneyJhbW91bnQiOiA1MDB9JywKIGZpeGVkOid7ImFtb3VudCI6IDE1MDB9JywKIG1hbnVhbDone30nfTsKZnVuY3Rpb24gcnVsZUZvcm0ocil7CiAgcj1yfHx7dHlwZTonYmFzZScsbGFiZWxfdXI6JycsY29uZmlnOnt9LGFjdGl2ZTp0cnVlLHNvcnRfb3JkZXI6OTl9OwogICQoJyNyZlpvbmUnKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGY5ZmQiPjxoMz4ke3IuaWQ/J1J1bGUgRWRpdCc6J05heWEgUnVsZSd9PC9oMz4KICA8cCBjbGFzcz0iaGludCI+VHlwZTogYmFzZSAoZml4ZWQgY2hhcmdlcykg4oCiIHBlcl91bml0IChmaSB1bml0KSDigKIgcGVyX2FyZWEgKHNxZnQpIOKAoiBvcHRpb25fcmF0ZSAob3B0aW9uIGtlIGhpc2FhYiBzZSByYXRlKSDigKIgb3B0aW9uX2NoYXJnZSDigKIgdGllciAoc2xhYikg4oCiIHBlcmNlbnQgKHRheC9kaXNjb3VudDoga2luZD10YXh8ZGlzY291bnR8c3VyY2hhcmdlKSDigKIgbWluaW11bSDigKIgZml4ZWQg4oCiIG1hbnVhbCAocXVvdGUgcmVxdWlyZWQpPC9wPgogIDxkaXY+PGxhYmVsPlRlbXBsYXRlPC9sYWJlbD48ZGl2PiR7UlVMRV9UWVBFUy5tYXAodD0+YDxidXR0b24gY2xhc3M9InRtcGwiIG9uY2xpY2s9ImZpbGxUbXBsKCcke3R9JykiPiR7dH08L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJncmlkMiI+PGRpdj48bGFiZWw+VHlwZTwvbGFiZWw+PHNlbGVjdCBpZD0icmZUeXBlIj4ke1JVTEVfVFlQRVMubWFwKHQ9PmA8b3B0aW9uICR7ci50eXBlPT09dD8nc2VsZWN0ZWQnOicnfT4ke3R9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgPGRpdj48bGFiZWw+U29ydCBvcmRlcjwvbGFiZWw+PGlucHV0IGlkPSJyZlNvcnQiIHR5cGU9Im51bWJlciIgdmFsdWU9IiR7ci5zb3J0X29yZGVyfSI+PC9kaXY+PC9kaXY+CiAgPGRpdj48bGFiZWw+TGFiZWwgKFVyZHUg4oCUIGN1c3RvbWVyIGtvIG5hemFyIGFheWVnYSk8L2xhYmVsPjxpbnB1dCBpZD0icmZMYWJlbCIgdmFsdWU9IiR7ZXNjKHIubGFiZWxfdXIpfSI+PC9kaXY+CiAgPGRpdj48bGFiZWw+Q29uZmlnIChKU09OKTwvbGFiZWw+PHRleHRhcmVhIGlkPSJyZkNmZyIgc3R5bGU9Im1pbi1oZWlnaHQ6MTIwcHgiPiR7ZXNjKEpTT04uc3RyaW5naWZ5KHIuY29uZmlnLG51bGwsMSkpfTwvdGV4dGFyZWE+PC9kaXY+CiAgPGxhYmVsIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0icmZBY3QiICR7ci5hY3RpdmU/J2NoZWNrZWQnOicnfSBzdHlsZT0id2lkdGg6YXV0byI+IEFjdGl2ZTwvbGFiZWw+CiAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNtIiBvbmNsaWNrPSJzYXZlUnVsZSgke3IuaWR8fCdudWxsJ30pIj5TYXZlPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbSBidG4tZ2hvc3QiIG9uY2xpY2s9IiQoJyNyZlpvbmUnKS5pbm5lckhUTUw9JyciPkNhbmNlbDwvYnV0dG9uPjwvZGl2PjxkaXYgaWQ9InJmRXJyIj48L2Rpdj48L2Rpdj5gOwp9CmZ1bmN0aW9uIGZpbGxUbXBsKHQpeyQoJyNyZlR5cGUnKS52YWx1ZT10OyQoJyNyZkNmZycpLnZhbHVlPVJVTEVfVE1QTFt0XTt9CmFzeW5jIGZ1bmN0aW9uIHNhdmVSdWxlKGlkKXsKICBsZXQgY2ZnO3RyeXtjZmc9SlNPTi5wYXJzZSgkKCcjcmZDZmcnKS52YWx1ZSk7fWNhdGNoeyQoJyNyZkVycicpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZXJyIj5Db25maWcgc2FoaSBKU09OIG5haGkgaGFpLjwvZGl2Pic7cmV0dXJuO30KICBjb25zdCBib2R5PXt0eXBlOiQoJyNyZlR5cGUnKS52YWx1ZSxsYWJlbF91cjokKCcjcmZMYWJlbCcpLnZhbHVlLGNvbmZpZzpjZmcsYWN0aXZlOiQoJyNyZkFjdCcpLmNoZWNrZWQsc29ydF9vcmRlcjpOdW1iZXIoJCgnI3JmU29ydCcpLnZhbHVlKX07CiAgY29uc3Qgcj1pZD9hd2FpdCBhcGkoJy9hcGkvYWRtaW4vcnVsZXMvJytpZCx7bWV0aG9kOidQVVQnLGJvZHk6SlNPTi5zdHJpbmdpZnkoYm9keSl9KQogICAgICAgICAgIDphd2FpdCBhcGkoYC9hcGkvYWRtaW4vY2F0ZWdvcmllcy8ke3N2Y0NhdC5pZH0vcnVsZXNgLHttZXRob2Q6J1BPU1QnLGJvZHk6SlNPTi5zdHJpbmdpZnkoYm9keSl9KTsKICBpZighci5vayl7JCgnI3JmRXJyJykuaW5uZXJIVE1MPWA8ZGl2IGNsYXNzPSJlcnIiPiR7ZXNjKHIuZXJyb3IpfTwvZGl2PmA7cmV0dXJuO30KICBlZGl0Q2F0KHN2Y0NhdC5pZCk7Cn0KYXN5bmMgZnVuY3Rpb24gZGVsUnVsZShpZCl7aWYoY29uZmlybSgnUnVsZSBkZWxldGUga2FyZWluPycpKXthd2FpdCBhcGkoJy9hcGkvYWRtaW4vcnVsZXMvJytpZCx7bWV0aG9kOidERUxFVEUnfSk7ZWRpdENhdChzdmNDYXQuaWQpO319CmZ1bmN0aW9uIGVkaXRSdWxlKHIpe3J1bGVGb3JtKHIpO30KCi8qIC0tLS0tLS0tLS0gU0VUVElOR1MgLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiByZW5kZXJTZXR0aW5ncygpewogIGNvbnN0IHM9c2V0dGluZ3M7CiAgJCgnI2FwcCcpLmlubmVySFRNTD1gPGRpdiBjbGFzcz0iY2FyZCI+PGgyPuKame+4jyBEdWthbiBTZXR0aW5nczwvaDI+CiAgPGRpdiBjbGFzcz0iZ3JpZDIiPgogIDxkaXY+PGxhYmVsPkR1a2FuIGthIG5hYW08L2xhYmVsPjxpbnB1dCBpZD0ic05hbWUiIHZhbHVlPSIke2VzYyhzLnNob3BfbmFtZXx8JycpfSI+PC9kaXY+CiAgPGRpdj48bGFiZWw+VG9rZW4gcHJlZml4PC9sYWJlbD48aW5wdXQgaWQ9InNQcmVmaXgiIHZhbHVlPSIke2VzYyhzLnNob3BfcHJlZml4fHwnJyl9Ij48L2Rpdj4KICA8ZGl2PjxsYWJlbD5XaGF0c0FwcCBudW1iZXI8L2xhYmVsPjxpbnB1dCBpZD0ic1dhIiB2YWx1ZT0iJHtlc2Mocy5zaG9wX3doYXRzYXBwfHwnJyl9IiBwbGFjZWhvbGRlcj0iOTIzMDAxMjM0NTY3Ij48L2Rpdj4KICA8ZGl2PjxsYWJlbD5BZGRyZXNzPC9sYWJlbD48aW5wdXQgaWQ9InNBZGRyIiB2YWx1ZT0iJHtlc2Mocy5zaG9wX2FkZHJlc3N8fCcnKX0iPjwvZGl2PgogIDxkaXY+PGxhYmVsPkF2ZyBtaW51dGVzIHBlciB0b2tlbiAocWF0YWFyKTwvbGFiZWw+PGlucHV0IGlkPSJzQXZnIiB0eXBlPSJudW1iZXIiIHZhbHVlPSIke2VzYyhzLmF2Z19taW51dGVzfHwnMjAnKX0iPjwvZGl2PgogIDxkaXY+PGxhYmVsPldhc29vbGkga2kgbXVkZGF0IChob3Vycyk8L2xhYmVsPjxpbnB1dCBpZD0ic0NoayIgdHlwZT0ibnVtYmVyIiB2YWx1ZT0iJHtlc2Mocy5jaGVja2luX2hvdXJzfHwnNDgnKX0iPjwvZGl2PgogIDwvZGl2PgogIDxsYWJlbCBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJzRGV2IiAke3MuZGV2X290cD09PScxJz8nY2hlY2tlZCc6Jyd9IHN0eWxlPSJ3aWR0aDphdXRvIj4gRGV2ZWxvcG1lbnQgT1RQIG1vZGUgKGFzYWwgU01TIG5haGkgamF5ZWdhIOKAlCB0ZXN0aW5nIGtlIGxpeWUpPC9sYWJlbD4KICA8YnV0dG9uIGNsYXNzPSJidG4iIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiIG9uY2xpY2s9InNhdmVTZXR0aW5ncygpIj5TYXZlIEthcmVpbjwvYnV0dG9uPjxkaXYgaWQ9InNFcnIiPjwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9ImNhcmQiPjxoMj7wn5SRIFBhc3N3b3JkIEJhZGxlaW48L2gyPgogIDxsYWJlbD5QdXJhbmEgcGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0icE9sZCIgdHlwZT0icGFzc3dvcmQiPgogIDxsYWJlbD5OYXlhIHBhc3N3b3JkPC9sYWJlbD48aW5wdXQgaWQ9InBOZXciIHR5cGU9InBhc3N3b3JkIj4KICA8YnV0dG9uIGNsYXNzPSJidG4iIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiIG9uY2xpY2s9ImNoYW5nZVB3KCkiPlBhc3N3b3JkIEJhZGxlaW48L2J1dHRvbj48ZGl2IGlkPSJwRXJyIj48L2Rpdj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+8J+UlyBNdXN0YXFpbCBCb29raW5nIExpbms8L2gyPgogIDxwIGNsYXNzPSJoaW50Ij5ZZWhpIGVrIGxpbmsgdGFtYW0gY3VzdG9tZXJzIGtlIHNhYXRoIHNoYXJlIGthcmVpbiAoV2hhdHNBcHAsIFNNUywgUVIpOjwvcD4KICA8ZGl2IGNsYXNzPSJ3YXJuIiBzdHlsZT0id29yZC1icmVhazpicmVhay1hbGwiPjxiPiR7ZXNjKGxvY2F0aW9uLm9yaWdpbil9L2Jvb2s8L2I+PC9kaXY+CiAgPHAgY2xhc3M9ImhpbnQiPkhhciBjdXN0b21lciBrZSBsaXllIG5heWEgbGluayBuYWhpIGJhbnRhIOKAlCB5ZWhpIHBlcm1hbmVudCBsaW5rIGhhaS48L3A+PC9kaXY+YDsKfQphc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3MoKXsKICBjb25zdCBib2R5PXtzaG9wX25hbWU6JCgnI3NOYW1lJykudmFsdWUsc2hvcF9wcmVmaXg6JCgnI3NQcmVmaXgnKS52YWx1ZSxzaG9wX3doYXRzYXBwOiQoJyNzV2EnKS52YWx1ZSxzaG9wX2FkZHJlc3M6JCgnI3NBZGRyJykudmFsdWUsCiAgICBhdmdfbWludXRlczokKCcjc0F2ZycpLnZhbHVlLGNoZWNraW5faG91cnM6JCgnI3NDaGsnKS52YWx1ZSxkZXZfb3RwOiQoJyNzRGV2JykuY2hlY2tlZD8nMSc6JzAnfTsKICBjb25zdCByPWF3YWl0IGFwaSgnL2FwaS9hZG1pbi9zZXR0aW5ncycse21ldGhvZDonUFVUJyxib2R5OkpTT04uc3RyaW5naWZ5KGJvZHkpfSk7CiAgJCgnI3NFcnInKS5pbm5lckhUTUw9ci5vaz8nPGRpdiBjbGFzcz0id2FybiIgc3R5bGU9ImJhY2tncm91bmQ6I2U2ZjlmMDtib3JkZXItY29sb3I6I2I3ZThjZCI+4pyFIFNhdmUgaG8gZ2F5YS48L2Rpdj4nOmA8ZGl2IGNsYXNzPSJlcnIiPiR7ZXNjKHIuZXJyb3IpfTwvZGl2PmA7CiAgaWYoci5vaylzZXR0aW5ncz17Li4uc2V0dGluZ3MsLi4uYm9keX07Cn0KYXN5bmMgZnVuY3Rpb24gY2hhbmdlUHcoKXsKICBjb25zdCByPWF3YWl0IGFwaSgnL2FwaS9hZG1pbi9jaGFuZ2UtcGFzc3dvcmQnLHttZXRob2Q6J1BPU1QnLGJvZHk6SlNPTi5zdHJpbmdpZnkoe29sZF9wYXNzd29yZDokKCcjcE9sZCcpLnZhbHVlLG5ld19wYXNzd29yZDokKCcjcE5ldycpLnZhbHVlfSl9KTsKICBpZighci5vayl7JCgnI3BFcnInKS5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+JHtlc2Moci5lcnJvcil9PC9kaXY+YDtyZXR1cm47fQogIGFsZXJ0KHIubWVzc2FnZSk7bG9nb3V0KCk7Cn0KCmlmKHRva2VuKCkpaW5pdCgpOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg=="};

function serveStatic(req, res) {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  if (p === '/book') p = '/book.html';
  if (p === '/admin') p = '/admin.html';
  if (p === '/status') p = '/status.html';
  const emb = EMBEDDED_PUBLIC[p];
  if (emb) {
    const buf = Buffer.from(emb, 'base64');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  const safe = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(404); res.end('Page nahi mila.'); return; }
  import('node:fs').then(fs => {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Page nahi mila.');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ============================== server ============================== */

const handler = async (req, res) => {
  try {
    // Vercel: catch-all rewrite function ko destination URL deta hai, is liye asal path __path query se wapas lete hain.
    const rawUrl = new URL(req.url, 'http://x');
    const origPath = rawUrl.searchParams.get('__path');
    if (origPath) {
      rawUrl.searchParams.delete('__path');
      const qs = rawUrl.searchParams.toString();
      req.url = (origPath.startsWith('/') ? origPath : '/' + origPath) + (qs ? '?' + qs : '');
    }
    const url = new URL(req.url, 'http://x');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      if (r.admin && !(await adminFromReq(req))) return bad(res, 'Login required.', 401);
      await r.handler(req, res, m);
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    console.error('ERR', e);
    if (!res.headersSent) bad(res, 'Server mein masla hua. Dobara koshish karein.', 500);
  }
};

export default handler;

/* Direct run (local / VPS): node server.js — Vercel par ye hissa skip hota hai, wahan upar wala handler export use hota hai. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`Smart Print Token System chal raha hai (${isCloud ? 'Turso cloud DB' : 'local DB'}): http://localhost:${PORT}/book`);
  });
}
