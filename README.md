# HAJAS Perfumes — موقع عطور (Cloudflare Workers)

موقع متجر عطور بالعربي والإنجليزي: 7 شركات، 144 عطر، سلة طلبات، وإرسال الطلب إلى تليجرام وقاعدة بيانات.

> Cloudflare صارت تنصح بالمشاريع الجديدة على **Workers** (بدل Pages)، ولوحتها الحالية تفتح Workers. لذلك هذا المشروع جاهز لـ Workers ويتنشر عن طريق GitHub.

## معلومات المشروع

| البند | القيمة |
|---|---|
| نوع المشروع | HTML + JavaScript جاهز (بدون React / Next.js / Vite) |
| ملف الإعداد | `wrangler.jsonc` (بأعلى المستودع) |
| اسم الـ Worker | `hajas-parfums` (لازم يطابق الاسم بلوحة Cloudflare) |
| Build command | **فارغ** |
| Deploy command | `npx wrangler deploy` (الافتراضي) |
| الموقع (ملفات ثابتة) | مجلد `public` |
| كود الطلبات | `public/_worker.js` (ما يظهر للزوار، بسبب `public/.assetsignore`) |

## محتوى المجلد

```
wrangler.jsonc       إعداد النشر: اسم الـ Worker، مجلد الموقع، ربط القاعدة، المسارات اللي تمر على الكود
public/              الموقع
  index.html           الموقع كامل: التصميم + العطور + الصور داخله
  robots.txt           يمنع فهرسة /admin و /api
  _worker.js           كود الطلبات (API)
  _routes.json         ملف قديم لـ Pages (ما يُستخدم هنا، وهو مستثنى من الرفع)
  .assetsignore        يمنع نشر _worker.js و _routes.json كملفات عامة
server/
  worker.js            المصدر المقروء لكود الطلبات
  build_worker.py      يولّد public/_worker.js من worker.js (فقط إذا عدّلت الكود)
database/
  schema.sql           جدول الطلبات
.dev.vars.example    أسماء الأسرار المطلوبة (بدون قيم)
.gitignore           يمنع رفع الأسرار بالغلط
```

## الخلفية وقاعدة البيانات والمتغيرات

| المطلوب | النوع | الوصف |
|---|---|---|
| `DB` | D1 binding | معرّف بـ `wrangler.jsonc`، يشير لقاعدة `hajas-orders` (تم إنشاؤها ونفّذ فيها `schema.sql`) |
| `TELEGRAM_BOT_TOKEN` | Secret | توكن البوت من @BotFather |
| `TELEGRAM_CHAT_ID` | Secret | رقم المحادثة اللي توصلها الإشعارات |
| `ADMIN_TOKEN` | Secret | كلمة سر لصفحة `/admin` (اختارها طويلة) |

اختياري: `IP_SALT` (نص عشوائي لتشفير عنوان الـ IP).
إذا الأسرار ما انضافت، الزبون يشوف شاشة بديلة فيها زر **واتساب/نسخ** بنفس بيانات الطلب، فما يضيع أي طلب.

> إذا أنشأت قاعدة D1 ثانية بدل `hajas-orders`، غيّر `database_id` بملف `wrangler.jsonc` إلى المعرّف الجديد (تلقاه بصفحة القاعدة بـ Cloudflare).

---

## الخطوة 1: GitHub

1. المستودع لازم يكون بهذا الشكل (بأعلى الصفحة): `database` و`public` و`server` و`README.md` و`wrangler.jsonc`.
2. وداخل `public`: `index.html` و`_worker.js` و`_routes.json` و`robots.txt` و`.assetsignore`.
3. إذا ينقص `wrangler.jsonc` أو `public/.assetsignore`: GitHub ← **Add file ← Create new file** ← اكتب الاسم (للثاني اكتب `public/.assetsignore`، والشرطة المائلة تنشئ المجلد) ← الصق المحتوى ← **Commit changes**.

## الخطوة 2: ربط Cloudflare بالمستودع

1. افتح dash.cloudflare.com ← **Workers & Pages** ← **Create application**.
2. اختر **Import a repository** (أو Continue with GitHub) ووافق على صلاحيات GitHub، واختر المستودع.
3. **Project name:** `hajas-parfums` (لازم يطابق `name` بـ `wrangler.jsonc`، وإلا يفشل البناء).
4. **Build command:** اتركه فارغ. **Deploy command:** `npx wrangler deploy`.
5. اضغط **Deploy**. بعد دقيقة يصير الموقع على `hajas-parfums.<اسمك>.workers.dev`.

> لا ترفع المجلد بواجهة **Upload and deploy** (رفع الملفات): هذي الواجهة للملفات الثابتة فقط، ما تشغّل `_worker.js` ولا نظام الطلبات، وتنشر كل الملفات بشكل علني.

## الخطوة 3: الأسرار

افتح الـ Worker `hajas-parfums` ← **Settings** ← **Variables and Secrets** ← **Add**:
اختر النوع **Secret**، واكتب الاسم والقيمة لكل من `TELEGRAM_BOT_TOKEN` و`TELEGRAM_CHAT_ID` و`ADMIN_TOKEN`، ثم **Deploy**.

### بوت تليجرام
1. بتليجرام افتح **@BotFather** ← `/newbot` ← خذ **التوكن**.
2. أرسل أي رسالة للبوت، ثم افتح بالمتصفح `https://api.telegram.org/bot<التوكن>/getUpdates` وخذ الرقم بعد `"chat":{"id":` (هذا Chat ID).

## الخطوة 4: التجربة

1. افتح الموقع، ضيف عطر للسلة ← **إتمام الطلب** ← عبّي بيانات تجريبية.
2. لازم يظهر رقم طلب مثل `HJ-00001` وتوصلك رسالة تليجرام بكل التفاصيل.
3. صفحة الطلبات: `/admin` ← اكتب `ADMIN_TOKEN`.
4. فحص سريع: `/health` لازم يرجع `{"ok":true}`.

## الدومين

بعد ما يصير الدومين Active على Cloudflare: الـ Worker ← **Settings** ← **Domains & Routes** ← **Add** ← **Custom domain** ← اكتب `hajasparfums.com` (وكرر مع `www.hajasparfums.com`). يضيف سجل DNS تلقائياً.

## تحديث الموقع لاحقاً

أي تعديل بالمستودع ينشر تلقائياً بدقيقة. لتغيير الموقع: أعطيك `public/index.html` جديد وترفعه بنفس المسار:
GitHub ← **Add file ← Upload files** ← داخل مجلد `public` ← **Commit**.

## إذا ظهرت مشكلة

| العَرَض | السبب والحل |
|---|---|
| البناء يفشل: `name ... must match the name of your Worker` | اسم المشروع بـ Cloudflare غير `hajas-parfums`. غيّر `name` بـ `wrangler.jsonc` ليطابقه. |
| البناء يفشل: `Missing entry-point` | `wrangler.jsonc` غير موجود بأعلى المستودع، أو انرفع داخل مجلد زائد. |
| الموقع يفتح لكن `/health` ما يرجع `{"ok":true}` | `public/_worker.js` ناقص أو `run_worker_first` متغيّر بـ `wrangler.jsonc`. |
| الطلب التجريبي يعرض شاشة واتساب/نسخ | الأسرار ما انضافت، أو ما سويت Deploy بعدها. |
| رقم الطلب يظهر لكن ما توصل رسالة تليجرام | تأكد من `TELEGRAM_BOT_TOKEN` و`TELEGRAM_CHAT_ID` وأنك أرسلت رسالة للبوت أولاً. الطلب محفوظ وبـ `/admin` يظهر ⚠ عليه. |
| خطأ `no such table: orders` | نفّذ `database/schema.sql` بقاعدة `hajas-orders` (آمن لو كررته). |

## ملاحظات مهمة

- أدوات التحكم بالعطور (الأسعار والأحجام والتوفر) تشتغل فقط داخل نسخة Claude، ولا تظهر للزبائن.
  أي تعديل تسويه هناك لازم تطلب مني نسخة جديدة منه لترفعها هنا.
- الأسعار اللي يرسلها المتصفح يرسلها الزبون، فأكّد الطلب بالاتصال قبل الشحن.
- إعادة إرسال إشعار تليجرام الفاشل تصير مع أول طلب جديد، وبـ `/admin` يظهر تحذير ⚠ على أي طلب ما وصل إشعاره.
- الصفحة الأولى حجمها ~4 ميغا لأن صور كل العطور داخل `index.html`.
