# Smart Print Token System 🖨️

Printing/document shop ke liye **mukammal token & order management web app** — customer online order kare, price dekhe, manzoor kare, aur **token** hasil kare. Dukan ko order turant admin dashboard mein nazar aaye.

**Sirf 2 cheezein chahiye:** Node.js (v22+) aur ek baar `npm install`.
Database: local SQLite file (`data/app.db`) **ya** free cloud database **Turso** (Render/production ke liye — data kabhi delete nahi hota).

## Jaldi Start (2 minute)

```bash
cd smart-print-token-system
npm install   # sirf pehli baar
node server.js
```

Phir browser mein kholein:

| Page | Link | Kaam |
|---|---|---|
| Customer booking | `http://localhost:3000/book` | **Yehi permanent link hai** — tamam customers ko yehi dein (WhatsApp/SMS/QR) |
| Order status | `http://localhost:3000/status` | Token + mobile se status |
| Admin panel | `http://localhost:3000/admin` | Queue, quotes, services, pricing, settings |

**Admin login:** username `admin`, password `admin123`
⚠️ Pehli login ke baad **Settings → Password Badlein** se zaroor badlein.

## Customer Flow (Roman Urdu, mobile-first)

1. **Apni Details** — naam, mobile → OTP verify (neeche OTP note dekhein)
2. **Kaam Select** — CV, Visiting Cards, Panaflex, Document Printing, Composing, Legal, Other
3. **Tafseel** — har service ka apna dynamic form (admin configurable)
4. **Price + Manzoori** — mukammal breakdown, checkbox tick → **Order Confirm Karein**
5. **Token** — bara token number (masalan `SP-20261018-001`), qataar number, andazan waqt, **Download / WhatsApp Share / Status** buttons

- Token sirf confirm ke baad banta hai — website kholne se nahi.
- Double-click se duplicate order nahi banta (idempotency key).
- Website kholne se koi app install nahi hoti.

## Quote Wala Flow

Jin services ki price auto-calculate nahi ho sakti (Legal, Other), order **"Quote Required"** mein jata hai:
Admin dashboard → Quotes → quote + note likhein → customer ko status link par quote nazar aata hai → customer **manzoor** kare → **tab token banta hai**.

## Pricing Engine (Backend = Source of Truth)

- Saari prices **server par calculate** hoti hain — browser ki bheji price par bharosa nahi hota.
- Admin **Services → Pricing Rules** mein rules banaye: `base`, `per_unit`, `per_area` (sqft, unit conversion ke saath), `option_rate`, `option_charge`, `tier` (slab), `percent` (tax/discount), `minimum`, `fixed`, `manual` (quote required).
- Har rule ke liye JSON config + ready-made templates maujood hain.
- Approved price ka **snapshot** order mein save hota hai — baad mein rates badalne se purane orders nahi badalte.
- ⚠️ Seed mein **SAMPLE rates** hain. Admin panel mein warning nazar aayegi — apni **asal rates** lagayein.

## OTP Note

Abhi **Development OTP mode** ON hai (`Settings` mein): asal SMS **nahi** jata — code screen par dikhaya jata hai (wazeh "Development mode" label ke saath).
Asal SMS ke liye: koi SMS provider (masalan Twilio / local SMS gateway) lagayein — `server.js` mein `/api/otp/send` route mein hook maujood hai — phir Settings mein dev mode OFF kar dein.

## Deploy (Permanent Public Link)

`/book` **ek hi permanent link** hai — har customer ke liye naya link nahi banta. Ise public karne ke 3 aasaan tareeqe:

**Option A — VPS (recommended, ~Rs. 1,500/month):**
```bash
# server par Node 22+ install karein, phir:
cd smart-print-token-system
node server.js   # ya PM2: pm2 start server.js --name smart-print
```
Domain lagayein (masalan `order.aapkidukan.pk/book`) — Nginx reverse proxy ke saath, HTTPS zaroori (admin login ke liye).

**Option B — Render + Turso (100% FREE, koi card nahi chahiye ✅):**

Ye tareeqa bilkul muft hai aur data bhi mehfooz rehta hai (Turso free cloud database).

*Step 1 — Turso database (2 minute):*
1. [turso.com](https://turso.com) par free account banayein (GitHub se login ho jata hai)
2. Dashboard → **Create Database** → naam rakhein `smart-print`
3. Database kholein → **Connect** button → wahan se **URL** copy karein (masalan `libsql://smart-print-abc123.turso.io`)
4. Left menu → **API Tokens** → **Create** → token copy kar lein (yeh dobara nazar nahi aayega!)

*Step 2 — Render par deploy:*
1. Ye project GitHub par push karein
2. [render.com](https://render.com) → **New → Web Service** → apna repo select karein
3. Build Command: `npm install` — Start Command: `node server.js` (render.yaml mein pehle se hai)
4. **Environment** tab mein 2 variables add karein:
   - `TURSO_URL` = turso wala URL
   - `TURSO_AUTH_TOKEN` = turso wala token
5. **Deploy** dabayein → 2-3 minute mein link mil jayega, masalan `https://smart-print-xxx.onrender.com/book`

Note: free plan par 15 minute idle rehne par server "so" jata hai — pehla customer ~30 second wait karega, uske baad normal. Paise kharch kiye baghair yehi sab se behtar free option hai.

**Option C — Quick test (Cloudflare Tunnel):**
```bash
cloudflared tunnel --url http://localhost:3000
```
Turant public link mil jata hai (testing ke liye).

**Backup:** Roz `data/app.db` ka backup lein (local mode mein) — Turso mode mein data cloud par auto-mehfooz hai.

## File Structure

```
server.js            → Backend API (pricing engine, OTP, orders, tokens, admin)
db.js                → Database layer: local SQLite file ya Turso cloud (env se), schema + seed
public/
  index.html         → Landing page
  book.html          → Customer booking flow (Roman Urdu)
  status.html        → Order status + quote approval
  admin.html         → Admin dashboard
data/app.db          → Database (local mode mein auto-banti hai; Turso mode mein cloud par)
deploy/              → systemd service + nginx config (VPS ke liye)
Dockerfile/render.yaml → Docker / Render deploy config
```

## Token Format

`SP-20261018-001` = Prefix + Tareekh (Asia/Karachi) + Roz ka sequence.
Sequence roz reset hoti hai, lekin internal order ID kabhi reuse nahi hoti. Simultaneous bookings DB transaction se safe hain.

## Security Notes (production se pehle)

1. Admin password badlein (default `admin123`).
2. HTTPS lagayein (admin token + customer data ke liye).
3. `dev_otp` OFF karke asal SMS provider lagayein.
4. Server sirf trusted network/admin ke liye khula rakhein — `/api/admin/*` login ke baghair band hai.
