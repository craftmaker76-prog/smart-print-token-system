# LIVE Deploy Guide (Roman Urdu)

## Tareeqa 1 — VPS (Asal dukan ke liye BEST ✅)

**Chahiye:** Ek VPS (Hostinger/Contabo/Hetzner — ~Rs. 1,200–2,000/month) + domain (optional, ~Rs. 2,500/saal).

```bash
# 1. Server par Node 22 install karein (Ubuntu):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx

# 2. Project copy karein:
sudo mkdir -p /opt/smart-print-token-system
sudo chown $USER:$USER /opt/smart-print-token-system
# (apne computer se: scp -r smart-print-token-system/* user@SERVER_IP:/opt/smart-print-token-system/)

# 3. Service lagayein:
sudo cp deploy/smart-print.service /etc/systemd/system/
# file mein User= aur WorkingDirectory= check karein
sudo systemctl daemon-reload
sudo systemctl enable --now smart-print
curl http://localhost:3000/api/config   # test

# 4. Nginx + free HTTPS:
sudo cp deploy/nginx-smart-print.conf /etc/nginx/sites-available/smart-print
# file mein apna domain likhein
sudo ln -s /etc/nginx/sites-available/smart-print /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d order.aapkidukan.pk
```

Ho gaya! `https://order.aapkidukan.pk/book` — yehi permanent public link hai.

**Backup (roz):** `sudo cp /opt/smart-print-token-system/data/app.db ~/backup/app-$(date +%F).db`

## Tareeqa 2 — Render + Turso (100% FREE, koi card nahi chahiye ✅)

**Ye sab se behtar muft tareeqa hai.** Data Turso (free cloud database) mein mehfooz rehta hai — kabhi delete nahi hota.

**Step 1 — Turso database banayein (2 minute, free):**
1. [turso.com](https://turso.com) kholein → **Sign up** (GitHub account se login ho jata hai, paise nahi lagte)
2. Dashboard mein **Create Database** → naam likhein `smart-print` → Create
3. Database par click karein → **Connect** button dabayein → **URL** copy karein
   (masalan: `libsql://smart-print-abc123.turso.io`)
4. Left side menu mein **API Tokens** → **Create Token** → jo token mile **copy karke sambhal lein** (yeh dobara nahi dikhega!)

**Step 2 — Code GitHub par dalein:**
1. [github.com](https://github.com) par free account → **New repository** (naam: `smart-print-token-system`)
2. Apne PC par us folder mein terminal kholein aur ye commands chalayein:
```bash
git init
git add .
git commit -m "smart print system"
git branch -M main
git remote add origin https://github.com/AAPKA-USERNAME/smart-print-token-system.git
git push -u origin main
```
(GitHub username/password poochega — de dein. Agar `git` nahi hai to [git-scm.com](https://git-scm.com) se install karein.)

**Step 3 — Render par deploy karein:**
1. [render.com](https://render.com) par free account (GitHub se login)
2. Dashboard → **New → Web Service** → apna `smart-print-token-system` repo select karein
3. Settings: Build Command `npm install`, Start Command `node server.js` (render.yaml se auto-fill ho jayega)
4. Neeche **Environment Variables** mein 2 add karein:
   - Key: `TURSO_URL`, Value: Step 1 wala URL
   - Key: `TURSO_AUTH_TOKEN`, Value: Step 1 wala token
5. **Deploy** dabayein → 2-4 minute mein aapka link tayyar: `https://smart-print-xxx.onrender.com/book` 🎉

**Yaad rakhein:** free plan par 15 minute koi na aaye to server "so" jata hai — pehle customer ko ~30 second lagega, phir normal chalega. Ye paise kharch kiye baghair sab se acha free setup hai.

## Tareeqa 3 — Cloudflare Tunnel (Fori demo link, temporary)

Apne computer/VPS par jahan app chal rahi ho:

```bash
cloudflared tunnel --url http://localhost:3000
```

Foran public link milega: `https://kuch-random.trycloudflare.com/book`
Ye link computer band hone par khatam. Mustaqil domain ke liye Cloudflare Zero Trust mein tunnel banayein (free).

## Live hone ke baad LAZMI checklist

- [ ] Admin password badla (`/admin` → Settings → Password Badlein)
- [ ] Asal rates lagayeen (Services → Pricing Rules) — sample rates hatayein
- [ ] Dukan ka naam, WhatsApp, address Settings mein
- [ ] Dev OTP mode OFF + asal SMS provider (production ke liye)
- [ ] HTTPS on hai (tareeqa 1 mein certbot se)
- [ ] Roz backup ka intezam

## Vercel (free, card ki zaroorat NAHI — recommended 2026-10-19)
Note: Render ab naye accounts se card maangta hai, aur Koyeb ka free plan Mistral acquisition ke baad khatam ho gaya — is liye Vercel istemal karein.
1. GitHub repo mein updated files upload karein (api/ folder aur vercel.json lazmi).
2. vercel.com → Sign Up (GitHub) → "Add New" → "Project" → repo `smart-print-token-system` Import karein.
3. Environment Variables mein `TURSO_URL` aur `TURSO_AUTH_TOKEN` add karein.
4. Deploy → link milega: https://<project>.vercel.app/book
Had: Vercel par file upload max ~4.5MB hai.
