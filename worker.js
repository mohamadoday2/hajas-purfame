/**
 * HAJAS Perfumes - order service (Cloudflare Worker + D1 database + Telegram bot)
 *
 *   POST  /api/orders            website checkout  -> validate -> save in D1 -> Telegram message
 *   GET   /api/orders            (admin) latest orders as JSON         Authorization: Bearer <ADMIN_TOKEN>
 *   GET   /api/orders.csv        (admin) same list as CSV (opens in Excel)
 *   PATCH /api/orders/HJ-00012   (admin) {"status":"confirmed|shipped|delivered|cancelled"}
 *   GET   /health
 *   GET   /admin                  small page to view / manage orders from a phone (asks for ADMIN_TOKEN)
 *
 * Secrets (wrangler secret put): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ADMIN_TOKEN
 * Vars: ALLOWED_ORIGIN, optional IP_SALT, optional TELEGRAM_API_BASE (tests only)
 */
const PROVINCES = ['بغداد', 'البصرة', 'نينوى', 'أربيل', 'السليمانية', 'دهوك', 'كركوك', 'الأنبار', 'ديالى', 'صلاح الدين',
  'بابل', 'كربلاء', 'النجف', 'واسط', 'ذي قار', 'ميسان', 'المثنى', 'القادسية', 'حلبجة'];
const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const MAX_BODY = 30 * 1024, RATE_LIMIT = 5, RATE_WINDOW_MIN = 10;

// ------------------------------------------------------------------ helpers
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function normPhone(v) {
  let s = String(v || '').replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d)).replace(/[^\d+]/g, '');
  s = s.replace(/^\+/, '').replace(/^00/, '');
  if (s.startsWith('964')) s = '0' + s.slice(3);
  if (/^7\d{9}$/.test(s)) s = '0' + s;
  return s;
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = n => Number(n).toLocaleString('en-US') + ' د.ع';
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function corsHeaders(req, env) {
  const allow = String(env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (allow.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (allow.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });

function isAdmin(req, env) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const real = env.ADMIN_TOKEN || '';
  if (!real || tok.length !== real.length) return false;
  let d = 0; for (let i = 0; i < real.length; i++) d |= tok.charCodeAt(i) ^ real.charCodeAt(i);
  return d === 0;
}

// ------------------------------------------------------------------ validation (the server never trusts the browser)
export function validate(b) {
  const e = {}, o = {};
  o.name = clean(b.name, 80);                       if (o.name.length < 2) e.name = 'الاسم مطلوب';
  o.phone = normPhone(b.phone);                     if (!/^07\d{9}$/.test(o.phone)) e.phone = 'رقم الهاتف غير صحيح (مثال: 07701234567)';
  o.city = clean(b.city, 40);                       if (!PROVINCES.includes(o.city)) e.city = 'اختر المحافظة';
  o.landmark = clean(b.landmark, 150);              if (o.landmark.length < 2) e.landmark = 'اكتب أقرب نقطة دالة';
  o.address = clean(b.address, 300);                if (o.address.length < 5) e.address = 'اكتب العنوان التفصيلي (الشارع، الدار، الشقة)';
  o.notes = clean(b.notes, 300);
  o.lang = b.lang === 'en' ? 'en' : 'ar';
  o.client_ref = /^[A-Za-z0-9_-]{8,64}$/.test(String(b.client_ref || '')) ? String(b.client_ref) : null;
  const items = Array.isArray(b.items) ? b.items.slice(0, 40) : [];
  o.items = []; o.total = 0;
  for (const it of items) {
    const price = Math.round(Number(it && it.price)), qty = Math.round(Number(it && it.qty)), name = clean(it && it.name, 100);
    if (!name || !(price > 0 && price <= 5000000) || !(qty >= 1 && qty <= 50)) { e.items = 'السلة غير صحيحة'; break; }
    o.items.push({ id: clean(it.id, 20), name, brand: clean(it.brand, 60), size: clean(it.size, 30), price, qty });
    o.total += price * qty;
  }
  if (!o.items.length && !e.items) e.items = 'السلة فارغة';
  return { errors: e, order: o };
}

// ------------------------------------------------------------------ Telegram
export function telegramText(o) {
  const lines = o.items.map((it, i) => `${i + 1}. <b>${esc(it.name)}</b>${it.brand ? ' (' + esc(it.brand) + ')' : ''}\n    ${esc(it.size)} × ${it.qty} = ${money(it.price * it.qty)}`);
  const when = new Date((o.created_at ? o.created_at.replace(' ', 'T') + 'Z' : Date.now()))
    .toLocaleString('en-GB', { timeZone: 'Asia/Baghdad', dateStyle: 'short', timeStyle: 'short' });
  let t = `🛍 <b>طلب جديد ${esc(o.order_no)}</b>\n\n` +
    `👤 <b>الاسم:</b> ${esc(o.name)}\n📞 <b>الهاتف:</b> <code>${esc(o.phone)}</code>\n` +
    `📍 <b>المحافظة:</b> ${esc(o.city)}\n🏷 <b>أقرب نقطة دالة:</b> ${esc(o.landmark)}\n🏠 <b>العنوان:</b> ${esc(o.address)}\n`;
  if (o.notes) t += `📝 <b>ملاحظات:</b> ${esc(o.notes)}\n`;
  t += `\n🧴 <b>المنتجات:</b>\n${lines.join('\n')}\n\n💰 <b>الإجمالي:</b> ${money(o.total)}\n🕐 ${when}`;
  return t.length > 4000 ? t.slice(0, 3990) + '…' : t;
}
async function sendTelegram(env, o) {
  const token = env.TELEGRAM_BOT_TOKEN, chats = String(env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !chats.length) throw new Error('telegram not configured');
  const base = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const wa = 'https://wa.me/964' + o.phone.slice(1);
  let sent = 0, last = '';
  for (const chat of chats) {
    const r = await fetch(`${base}/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: telegramText(o), parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '💬 واتساب الزبون', url: wa }]] } }) });
    if (r.ok) sent++; else last = `${r.status} ${(await r.text()).slice(0, 150)}`;
  }
  if (!sent) throw new Error(last || 'send failed');
}
async function notify(env, o) {
  try { await sendTelegram(env, o); await env.DB.prepare('UPDATE orders SET notified=1, notify_error=NULL WHERE id=?').bind(o.id).run(); return true; }
  catch (err) { await env.DB.prepare('UPDATE orders SET notify_error=? WHERE id=?').bind(String(err.message || err).slice(0, 200), o.id).run(); return false; }
}
const rowToOrder = r => ({ ...r, items: JSON.parse(r.items_json) });

// ------------------------------------------------------------------ routes
async function createOrder(req, env, ctx, cors) {
  if (Number(req.headers.get('Content-Length') || 0) > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413, cors);
  let body; try { const txt = await req.text(); if (txt.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413, cors); body = JSON.parse(txt); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400, cors); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad_json' }, 400, cors);
  if (body.website) return json({ ok: true, orderNo: 'HJ-00000' }, 201, cors);          // honeypot: bots fill this hidden field
  const { errors, order } = validate(body);
  if (Object.keys(errors).length) return json({ ok: false, errors }, 400, cors);

  if (order.client_ref) {                                                                // same tap sent twice -> same order
    const ex = await env.DB.prepare('SELECT order_no FROM orders WHERE client_ref=?').bind(order.client_ref).first();
    if (ex) return json({ ok: true, orderNo: ex.order_no, duplicate: true }, 200, cors);
  }
  const ipHash = (await sha256((req.headers.get('CF-Connecting-IP') || 'unknown') + (env.IP_SALT || 'hajas'))).slice(0, 32);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ip_hash=? AND created_at > datetime('now', ?)`).bind(ipHash, `-${RATE_WINDOW_MIN} minutes`).first('n');
  if (recent >= RATE_LIMIT) return json({ ok: false, error: 'rate_limited' }, 429, cors);

  const ins = await env.DB.prepare(`INSERT INTO orders (client_ref,name,phone,city,landmark,address,notes,items_json,total,lang,ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(order.client_ref, order.name, order.phone, order.city, order.landmark, order.address, order.notes, JSON.stringify(order.items), order.total, order.lang, ipHash).run();
  const id = ins.meta.last_row_id, orderNo = 'HJ-' + String(id).padStart(5, '0');
  await env.DB.prepare('UPDATE orders SET order_no=? WHERE id=?').bind(orderNo, id).run();

  const saved = { ...order, id, order_no: orderNo, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19) };
  const job = notify(env, saved).then(() => retryUnsent(env, id)).catch(() => {});       // Telegram runs after the reply (customer does not wait); also re-sends any earlier order that failed
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true, orderNo }, 201, cors);
}
async function listOrders(req, env, cors, csv) {
  const u = new URL(req.url), limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit')) || 50)), st = u.searchParams.get('status');
  const q = st && STATUSES.includes(st) ? env.DB.prepare('SELECT * FROM orders WHERE status=? ORDER BY id DESC LIMIT ?').bind(st, limit) : env.DB.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').bind(limit);
  const rows = (await q.all()).results.map(rowToOrder);
  if (!csv) return json({ ok: true, count: rows.length, orders: rows.map(({ items_json, ip_hash, ...r }) => r) }, 200, cors);
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['order_no', 'created_at_utc', 'status', 'name', 'phone', 'city', 'landmark', 'address', 'notes', 'items', 'total'];
  const out = [head.join(',')].concat(rows.map(r => [r.order_no, r.created_at, r.status, r.name, r.phone, r.city, r.landmark, r.address, r.notes,
    r.items.map(i => `${i.name} (${i.size}) x${i.qty}`).join(' | '), r.total].map(cell).join(',')));
  return new Response('﻿' + out.join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hajas-orders.csv"', ...cors } });
}
async function setStatus(req, env, no, cors) {
  let b; try { b = await req.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400, cors); }
  if (!STATUSES.includes(b.status)) return json({ ok: false, error: 'bad_status' }, 400, cors);
  const r = await env.DB.prepare('UPDATE orders SET status=? WHERE order_no=?').bind(b.status, no).run();
  return r.meta.changes ? json({ ok: true, orderNo: no, status: b.status }, 200, cors) : json({ ok: false, error: 'not_found' }, 404, cors);
}
async function retryUnsent(env, exceptId) {
  const rows = (await env.DB.prepare(`SELECT * FROM orders WHERE notified=0 AND id<>? AND created_at > datetime('now','-1 day') ORDER BY id LIMIT 20`).bind(exceptId || 0).all()).results;
  for (const r of rows) await notify(env, rowToOrder(r));
  return rows.length;
}

const ADMIN_HTML = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>طلبات HAJAS</title>
<style>:root{color-scheme:dark}body{margin:0;background:#051F20;color:#fff;font:15px/1.6 system-ui,Segoe UI,Tahoma,sans-serif;padding:14px}h1{font-size:20px;color:#f1d58a;margin:4px 0 12px}
input,select,button{font:inherit;border-radius:10px;border:1px solid #2b5d5a;background:#082a2b;color:#fff;padding:9px 12px}button{cursor:pointer;background:#c9a24d;color:#051F20;border:0;font-weight:700}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.c{background:#0a3335;border:1px solid #1d4f4c;border-radius:16px;padding:12px 14px;margin-bottom:10px}
.h{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px}.h b{color:#f1d58a;font-size:17px}.m{color:#9fb9b6;font-size:13px}a{color:#8fd3c8}.t{margin-top:6px;padding-top:6px;border-top:1px dashed #1d4f4c}.err{color:#f0a39c}</style></head><body>
<h1>طلبات HAJAS</h1><div class="bar"><input id="tk" type="password" placeholder="كلمة سر الإدارة (ADMIN_TOKEN)" style="flex:1;min-width:200px"><button id="go">عرض الطلبات</button><button id="csv" style="background:#2b5d5a;color:#fff">تحميل Excel</button></div><div id="msg" class="m"></div><div id="list"></div>
<script>
const $=id=>document.getElementById(id),S={new:'جديد',confirmed:'مؤكد',shipped:'تم الشحن',delivered:'تم التسليم',cancelled:'ملغي'};
const tok=()=>$('tk').value.trim()||sessionStorage.getItem('hj_admin')||'';
const H=()=>({Authorization:'Bearer '+tok()});
const mk=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
async function load(){$('msg').textContent='جاري التحميل…';$('msg').className='m';
 const r=await fetch('/api/orders?limit=100',{headers:H()});
 if(r.status===401){$('msg').textContent='كلمة السر غير صحيحة';$('msg').className='err';return}
 const j=await r.json();sessionStorage.setItem('hj_admin',tok());$('msg').textContent=j.count+' طلب';const L=$('list');L.innerHTML='';
 j.orders.forEach(o=>{const c=mk('div','c'),h=mk('div','h');h.append(mk('b','',o.order_no));
  const sel=mk('select');Object.keys(S).forEach(k=>{const op=mk('option','',S[k]);op.value=k;if(k===o.status)op.selected=true;sel.append(op)});
  sel.onchange=async()=>{const r=await fetch('/api/orders/'+o.order_no,{method:'PATCH',headers:{...H(),'Content-Type':'application/json'},body:JSON.stringify({status:sel.value})});if(!r.ok)alert('تعذر التحديث')};h.append(sel);c.append(h);
  const d=new Date(o.created_at.replace(' ','T')+'Z');c.append(mk('div','m',d.toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'})+(o.notified?'':' · ⚠ لم يصل إشعار تليجرام')));
  c.append(mk('div','','👤 '+o.name));const p=mk('div','','📞 ');const a=mk('a','',o.phone);a.href='tel:'+o.phone;p.append(a,' · ');const w=mk('a','','واتساب');w.href='https://wa.me/964'+o.phone.slice(1);w.target='_blank';p.append(w);c.append(p);
  c.append(mk('div','','📍 '+o.city+' — '+o.landmark));c.append(mk('div','','🏠 '+o.address));if(o.notes)c.append(mk('div','','📝 '+o.notes));
  const t=mk('div','t');o.items.forEach(i=>t.append(mk('div','',i.name+' ('+i.size+') × '+i.qty+' = '+(i.price*i.qty).toLocaleString('en-US')+' د.ع')));t.append(mk('b','','الإجمالي: '+o.total.toLocaleString('en-US')+' د.ع'));c.append(t);L.append(c)})}
$('go').onclick=load;$('tk').onkeydown=e=>{if(e.key==='Enter')load()};
$('csv').onclick=async()=>{const r=await fetch('/api/orders.csv?limit=500',{headers:H()});if(!r.ok){$('msg').textContent='كلمة السر غير صحيحة';return}const u=URL.createObjectURL(await r.blob()),a=mk('a');a.href=u;a.download='hajas-orders.csv';a.click()};
if(sessionStorage.getItem('hj_admin'))load();
</script></body></html>`;

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env), url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (p === '/health') return json({ ok: true }, 200, cors);
      if (p === '/admin' && req.method === 'GET') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
      if (p === '/api/orders' && req.method === 'POST') return await createOrder(req, env, ctx, cors);
      if (p === '/api/orders' || p === '/api/orders.csv' || /^\/api\/orders\/HJ-\d+$/.test(p)) {
        if (!isAdmin(req, env)) return json({ ok: false, error: 'unauthorized' }, 401, cors);
        if (req.method === 'GET' && p === '/api/orders') return await listOrders(req, env, cors, false);
        if (req.method === 'GET' && p === '/api/orders.csv') return await listOrders(req, env, cors, true);
        if (req.method === 'PATCH') return await setStatus(req, env, p.split('/').pop(), cors);
      }
      return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (err) {
      console.error('order service error', err && err.stack || err);
      return json({ ok: false, error: 'server_error' }, 500, cors);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(retryUnsent(env)); }
};
