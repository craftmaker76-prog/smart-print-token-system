// Smart Print Token System — Backend (Node.js + @libsql/client)
// Local:  node server.js            → file:data/app.db
// Cloud:  TURSO_URL + TURSO_AUTH_TOKEN env → Turso (Render/production)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { q, q1, run, getSetting, setSetting, verifyPassword, hashPasswordNew, allocTokenNo, randomBytes, isCloud } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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

function serveStatic(req, res) {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  if (p === '/book') p = '/book.html';
  if (p === '/admin') p = '/admin.html';
  if (p === '/status') p = '/status.html';
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
