// Smart Print Token System — Database layer (async, @libsql/client)
// Local:  file:data/app.db            (node server.js — koi setup nahi)
// Cloud:  TURSO_URL=libsql://xxx.turso.io + TURSO_AUTH_TOKEN  (Render/production)
import { createClient } from '@libsql/client';
import { scryptSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

export const isCloud = !!TURSO_URL;

const client = TURSO_URL
  ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
  : (() => { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); return createClient({ url: 'file:' + DB_PATH }); })();

/* Tiny promise wrapper — server.js sirf ye 3 istemal karta hai */
export async function q(sql, ...args) {
  const r = await client.execute({ sql, args });
  return r.rows;
}
export async function q1(sql, ...args) {
  const rows = await q(sql, ...args);
  return rows[0];
}
export async function run(sql, ...args) {
  const r = await client.execute({ sql, args });
  return { changes: Number(r.rowsAffected), lastId: Number(r.lastInsertRowid ?? 0) };
}
async function execMulti(sql) {
  await client.executeMultiple(sql);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name_ur TEXT NOT NULL,
  name_en TEXT NOT NULL,
  icon TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  estimated_minutes INTEGER DEFAULT 60
);
CREATE TABLE IF NOT EXISTS fields(
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label_ur TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  options TEXT DEFAULT '[]',
  required INTEGER DEFAULT 0,
  placeholder_ur TEXT DEFAULT '',
  validation TEXT DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  UNIQUE(category_id, field_key)
);
CREATE TABLE IF NOT EXISTS pricing_rules(
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label_ur TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS token_sequence(
  shop_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(shop_id, date)
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY,
  token_no TEXT UNIQUE,
  secure_ref TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE,
  shop_id INTEGER DEFAULT 1,
  category_id INTEGER REFERENCES categories(id),
  customer_name TEXT NOT NULL,
  customer_mobile TEXT NOT NULL,
  customer_email TEXT DEFAULT '',
  otp_verified INTEGER DEFAULT 0,
  source TEXT DEFAULT 'online',
  status TEXT NOT NULL DEFAULT 'draft',
  queue_position INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  price_breakdown TEXT DEFAULT '[]',
  total_price REAL,
  quoted_total REAL,
  quote_note TEXT DEFAULT '',
  estimated_minutes INTEGER,
  checkin_deadline TEXT,
  admin_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_files(
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  PRIMARY KEY(order_id, idx)
);
CREATE TABLE IF NOT EXISTS otps(
  id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_otps_mobile ON otps(mobile);
CREATE TABLE IF NOT EXISTS verified_mobiles(
  token TEXT PRIMARY KEY,
  mobile TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  return scryptSync(password, salt, 64).toString('hex') === hash;
}
export function hashPasswordNew(password) { return hashPassword(password); }
export { randomBytes };

export async function getSetting(key) {
  const row = await q1('SELECT value FROM settings WHERE key=?', key);
  return row ? row.value : null;
}
export async function setSetting(key, value) {
  await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
}

const karachiDate = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');

/* Atomic daily token allocation — single statement, no explicit transaction needed.
   Concurrent callers can never get the same number (gaps possible, duplicates impossible). */
export async function allocTokenNo() {
  const prefix = (await getSetting('shop_prefix')) || 'SP';
  const ymd = karachiDate();
  const row = await q1(
    `INSERT INTO token_sequence(shop_id, date, last_seq) VALUES(1, ?, 1)
     ON CONFLICT(shop_id, date) DO UPDATE SET last_seq = last_seq + 1
     RETURNING last_seq`, ymd);
  return `${prefix}-${ymd}-${String(Number(row.last_seq)).padStart(3, '0')}`;
}

/* ---------------- seed (sirf pehli baar) ---------------- */
async function seedIfEmpty() {
  await execMulti(SCHEMA);
  if ((await getSetting('seeded')) === '1') return;

  const settings = {
    seeded: '1',
    shop_name: 'Smart Print Shop',
    shop_prefix: 'SP',
    shop_whatsapp: '',
    shop_address: '',
    avg_minutes: '20',
    checkin_hours: '48',
    dev_otp: '1',
    sample_prices: '1',
  };
  for (const [k, v] of Object.entries(settings)) await setSetting(k, v);

  await run('INSERT OR IGNORE INTO admin_users(username, pass_hash, created_at) VALUES(?,?,?)',
    'admin', hashPassword('admin123'), new Date().toISOString());

  const cats = [
    { slug: 'cv', name_ur: 'CV / Resume', name_en: 'CV / Resume', icon: '📄', est: 60 },
    { slug: 'visiting-cards', name_ur: 'Visiting Cards', name_en: 'Visiting Cards', icon: '💳', est: 1440 },
    { slug: 'panaflex', name_ur: 'Panaflex / Large Prints', name_en: 'Panaflex / Large Prints', icon: '🖼️', est: 1440 },
    { slug: 'document-printing', name_ur: 'Document Printing', name_en: 'Document Printing', icon: '🖨️', est: 60 },
    { slug: 'composing', name_ur: 'Composing / Typing', name_en: 'Composing / Typing', icon: '⌨️', est: 240 },
    { slug: 'legal', name_ur: 'Legal Documents', name_en: 'Legal Documents', icon: '⚖️', est: 2880 },
    { slug: 'other', name_ur: 'Other Services', name_en: 'Other Services', icon: '🛠️', est: 1440 },
  ];
  const catIds = {};
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const r = await run('INSERT INTO categories(slug,name_ur,name_en,icon,sort_order,active,estimated_minutes) VALUES(?,?,?,?,?,?,?)',
      c.slug, c.name_ur, c.name_en, c.icon, i, 1, c.est);
    catIds[c.slug] = r.lastId;
  }

  const opt = (arr) => JSON.stringify(arr.map(([value, label_ur]) => ({ value, label_ur })));
  const F = [];
  const addF = (slug, field_key, label_ur, field_type, o = {}) => {
    F.push([catIds[slug], field_key, label_ur, field_type, o.options ? opt(o.options) : '[]',
      o.required ? 1 : 0, o.placeholder || '', JSON.stringify(o.validation || {}), o.sort ?? F.length, 1]);
  };

  addF('cv', 'cv_name', 'CV par naam', 'text', { required: true, sort: 1, placeholder: 'Masalan: Ali Raza' });
  addF('cv', 'contact', 'Rabta number / email (CV ke liye)', 'text', { required: true, sort: 2 });
  addF('cv', 'education', 'Taleem', 'textarea', { required: true, sort: 3, placeholder: 'Degree, idara, saal...' });
  addF('cv', 'experience', 'Tajurba (kaam ka)', 'textarea', { sort: 4 });
  addF('cv', 'skills', 'Skills', 'textarea', { sort: 5 });
  addF('cv', 'other_info', 'Mazeed maloomat', 'textarea', { sort: 6 });
  addF('cv', 'creation_needed', 'CV banana hai?', 'radio', { required: true, sort: 7, options: [['yes', 'Ji haan'], ['no', 'Nahi']] });
  addF('cv', 'printing_needed', 'Printing chahiye?', 'radio', { required: true, sort: 8, options: [['yes', 'Ji haan'], ['no', 'Nahi']] });
  addF('cv', 'print_type', 'Print kis tarah?', 'select', { sort: 9, options: [['colour', 'Colour'], ['bw', 'Black & White']] });
  addF('cv', 'copies', 'Kitni copies?', 'number', { sort: 10, validation: { min: 0, max: 1000 } });
  addF('cv', 'paper_type', 'Paper', 'select', { sort: 11, options: [['normal', 'Normal'], ['premium', 'Premium']] });
  addF('cv', 'instructions', 'Koi khaas hidayat', 'textarea', { sort: 12 });

  addF('visiting-cards', 'card_category', 'Card category', 'select', { required: true, sort: 1, options: [['standard', 'Standard'], ['matte', 'Matte'], ['glossy', 'Glossy'], ['premium', 'Premium']] });
  addF('visiting-cards', 'quantity', 'Kitne cards?', 'number', { required: true, sort: 2, validation: { min: 1, max: 100000 } });
  addF('visiting-cards', 'sides', 'Printing', 'select', { required: true, sort: 3, options: [['single', 'Single side'], ['double', 'Double side']] });
  addF('visiting-cards', 'design_needed', 'Design banwana hai?', 'radio', { required: true, sort: 4, options: [['yes', 'Ji haan'], ['no', 'Nahi']] });
  addF('visiting-cards', 'design_package', 'Design package', 'select', { sort: 5, options: [['simple', 'Simple'], ['premium', 'Premium design']] });
  addF('visiting-cards', 'finishing', 'Finishing', 'select', { sort: 6, options: [['none', 'Koi nahi'], ['lamination', 'Lamination'], ['uv', 'UV coating']] });
  addF('visiting-cards', 'card_text', 'Card par kya likhna hai (naam, number, address)', 'textarea', { required: true, sort: 7 });
  addF('visiting-cards', 'design_file', 'Design file (agar hai to)', 'file', { sort: 8 });

  addF('panaflex', 'width', 'Chaurai (width)', 'number', { required: true, sort: 1, validation: { min: 0.1, max: 1000 } });
  addF('panaflex', 'height', 'Lambai (height)', 'number', { required: true, sort: 2, validation: { min: 0.1, max: 1000 } });
  addF('panaflex', 'unit', 'Paimaish', 'select', { required: true, sort: 3, options: [['feet', 'Feet'], ['inches', 'Inches'], ['cm', 'CM']] });
  addF('panaflex', 'material', 'Material', 'select', { required: true, sort: 4, options: [['normal', 'Normal panaflex'], ['premium', 'Premium'], ['backlit', 'Backlit']] });
  addF('panaflex', 'quality', 'Print quality', 'select', { sort: 5, options: [['standard', 'Standard'], ['high', 'High quality']] });
  addF('panaflex', 'quantity', 'Quantity', 'number', { sort: 6, validation: { min: 1, max: 1000 } });
  addF('panaflex', 'design_needed', 'Design banwana hai?', 'radio', { required: true, sort: 7, options: [['yes', 'Ji haan'], ['no', 'Nahi']] });
  addF('panaflex', 'finishing', 'Finishing / Installation', 'select', { sort: 8, options: [['none', 'Koi nahi'], ['finishing', 'Sirf finishing'], ['installation', 'Installation ke saath']] });
  addF('panaflex', 'instructions', 'Mazeed hidayat', 'textarea', { sort: 9 });
  addF('panaflex', 'design_file', 'Design file (agar hai to)', 'file', { sort: 10 });

  addF('document-printing', 'doc_type', 'Document kis qism ka?', 'select', { sort: 1, options: [['form', 'Form'], ['assignment', 'Assignment'], ['report', 'Report'], ['other', 'Other']] });
  addF('document-printing', 'pages', 'Kitne pages?', 'number', { required: true, sort: 2, validation: { min: 1, max: 10000 } });
  addF('document-printing', 'copies', 'Kitni copies?', 'number', { required: true, sort: 3, validation: { min: 1, max: 10000 } });
  addF('document-printing', 'colour', 'Colour ya Black & White?', 'select', { required: true, sort: 4, options: [['colour', 'Colour'], ['bw', 'Black & White']] });
  addF('document-printing', 'paper_size', 'Paper size', 'select', { sort: 5, options: [['a4', 'A4'], ['legal', 'Legal'], ['letter', 'Letter']] });
  addF('document-printing', 'sides', 'Ek taraf ya dono taraf?', 'select', { sort: 6, options: [['single', 'Single side'], ['double', 'Double side']] });
  addF('document-printing', 'paper_type', 'Paper', 'select', { sort: 7, options: [['normal', 'Normal'], ['premium', 'Premium']] });
  addF('document-printing', 'binding', 'Binding', 'select', { sort: 8, options: [['none', 'Koi nahi'], ['spiral', 'Spiral binding'], ['hard', 'Hard binding']] });
  addF('document-printing', 'file', 'File upload karein', 'file', { sort: 9 });

  addF('composing', 'doc_category', 'Document category', 'select', { required: true, sort: 1, options: [['letter', 'Letter'], ['application', 'Application'], ['assignment', 'Assignment'], ['thesis', 'Thesis / Report'], ['other', 'Other']] });
  addF('composing', 'pages', 'Kitne pages? (andazan)', 'number', { sort: 2, validation: { min: 0, max: 10000 } });
  addF('composing', 'words', 'Alfaaz (agar maloom hon)', 'number', { sort: 3, validation: { min: 0, max: 1000000 } });
  addF('composing', 'language', 'Zubaan', 'select', { sort: 4, options: [['urdu', 'Urdu'], ['english', 'English'], ['both', 'Dono']] });
  addF('composing', 'service_type', 'Kya karwana hai?', 'select', { required: true, sort: 5, options: [['typing', 'Typing'], ['formatting', 'Formatting'], ['composing', 'Mukammal composing']] });
  addF('composing', 'urgency', 'Kitni jaldi chahiye?', 'select', { sort: 6, options: [['normal', 'Normal'], ['urgent', 'Urgent']] });
  addF('composing', 'extras', 'Mazeed', 'select', { sort: 7, options: [['none', 'Koi nahi'], ['print', 'Printing bhi chahiye']] });
  addF('composing', 'file', 'File (agar hai to)', 'file', { sort: 8 });

  addF('legal', 'doc_category', 'Document category', 'select', { required: true, sort: 1, options: [['affidavit', 'Affidavit / Halafnama'], ['agreement', 'Agreement'], ['stamp', 'Stamp paper work'], ['other', 'Other']] });
  addF('legal', 'pages', 'Kitne pages? (andazan)', 'number', { sort: 2, validation: { min: 0, max: 10000 } });
  addF('legal', 'service', 'Kya karwana hai?', 'select', { required: true, sort: 3, options: [['composing', 'Composing'], ['printing', 'Printing'], ['both', 'Composing + Printing']] });
  addF('legal', 'instructions', 'Tafseel likhein', 'textarea', { required: true, sort: 4 });

  addF('other', 'title', 'Kaam ka naam', 'text', { required: true, sort: 1 });
  addF('other', 'description', 'Kaam ki tafseel likhein', 'textarea', { required: true, sort: 2 });
  addF('other', 'file', 'File (agar hai to)', 'file', { sort: 3 });

  for (const f of F) {
    await run('INSERT INTO fields(category_id,field_key,label_ur,field_type,options,required,placeholder_ur,validation,sort_order,active) VALUES(?,?,?,?,?,?,?,?,?,?)', ...f);
  }

  const R = [];
  const addR = (slug, type, label_ur, config, sort) => {
    R.push([catIds[slug], type, label_ur, JSON.stringify(config), 1, sort]);
  };
  addR('cv', 'option_charge', 'CV Composing', { field: 'creation_needed', charges: { yes: 300, no: 0 } }, 1);
  addR('cv', 'option_rate', 'Printing charges', { field: 'print_type', rates: { colour: 20, bw: 5 }, per: 'units', unit_fields: ['copies'], condition: { field: 'printing_needed', equals: 'yes' } }, 2);
  addR('cv', 'option_charge', 'Premium paper', { field: 'paper_type', charges: { premium: 50, normal: 0 }, condition: { field: 'printing_needed', equals: 'yes' } }, 3);
  addR('visiting-cards', 'tier', 'Card printing (slab rate)', { field: 'quantity', tiers: [{ min: 1, max: 100, rate: 8 }, { min: 101, max: 500, rate: 6 }, { min: 501, max: null, rate: 4 }] }, 1);
  addR('visiting-cards', 'option_rate', 'Category charges', { field: 'card_category', rates: { standard: 0, matte: 3, glossy: 4, premium: 10 }, per: 'quantity', quantity_field: 'quantity' }, 2);
  addR('visiting-cards', 'option_rate', 'Double side charges', { field: 'sides', rates: { single: 0, double: 2 }, per: 'quantity', quantity_field: 'quantity' }, 3);
  addR('visiting-cards', 'option_charge', 'Design charges', { field: 'design_needed', charges: { yes: 500, no: 0 } }, 4);
  addR('visiting-cards', 'option_charge', 'Premium design', { field: 'design_package', charges: { premium: 500, simple: 0 }, condition: { field: 'design_needed', equals: 'yes' } }, 5);
  addR('visiting-cards', 'option_charge', 'Finishing', { field: 'finishing', charges: { none: 0, lamination: 300, uv: 500 } }, 6);
  addR('visiting-cards', 'minimum', 'Minimum order', { amount: 500 }, 7);
  const areaCfg = { width_field: 'width', height_field: 'height', unit_field: 'unit', quantity_field: 'quantity', unit: 'sqft', min_billable_area: 2 };
  addR('panaflex', 'per_area', 'Panaflex printing', { ...areaCfg, amount: 150 }, 1);
  addR('panaflex', 'option_rate', 'Material charges', { field: 'material', rates: { normal: 0, premium: 50, backlit: 120 }, per: 'area', area_config: areaCfg }, 2);
  addR('panaflex', 'option_charge', 'Design charges', { field: 'design_needed', charges: { yes: 800, no: 0 } }, 3);
  addR('panaflex', 'option_charge', 'Finishing / Installation', { field: 'finishing', charges: { none: 0, finishing: 500, installation: 1500 } }, 4);
  addR('panaflex', 'option_charge', 'High quality print', { field: 'quality', charges: { high: 200, standard: 0 } }, 5);
  addR('document-printing', 'option_rate', 'Printing charges', { field: 'colour', rates: { colour: 10, bw: 3 }, per: 'units', unit_fields: ['pages', 'copies'] }, 1);
  addR('document-printing', 'option_rate', 'Premium paper', { field: 'paper_type', rates: { normal: 0, premium: 2 }, per: 'units', unit_fields: ['pages', 'copies'] }, 2);
  addR('document-printing', 'option_charge', 'Binding', { field: 'binding', charges: { none: 0, spiral: 80, hard: 250 } }, 3);
  addR('composing', 'option_rate', 'Composing charges', { field: 'service_type', rates: { typing: 100, formatting: 150, composing: 300 }, per: 'units', unit_fields: ['pages'] }, 1);
  addR('composing', 'option_charge', 'Urgent charges', { field: 'urgency', charges: { urgent: 500, normal: 0 } }, 2);
  addR('composing', 'option_charge', 'Printing', { field: 'extras', charges: { print: 200, none: 0 } }, 3);
  addR('legal', 'manual', 'Is service ke liye dukan aapko quote degi. Sarkari fee / stamp duty is mein shaamil nahi — wo alag se hogi.', {}, 1);
  addR('other', 'manual', 'Is kaam ke liye dukan aapko quote bhejegi.', {}, 1);

  for (const r of R) {
    await run('INSERT INTO pricing_rules(category_id,type,label_ur,config,active,sort_order) VALUES(?,?,?,?,?,?)', ...r);
  }
  console.log(`Database seeded (${isCloud ? 'Turso cloud' : 'local file'}): 7 categories, fields, sample pricing rules.`);
}

await seedIfEmpty();
