/**
 * sw.js — Service Worker برای حالت آفلاین (مورد ۲۵)
 *
 * استراتژی:
 *  - «پوستهٔ» اصلی سایت (index.htm، اسکریپت‌ها، ویوئر PDF) در نصب،
 *    از قبل کش می‌شود - تا خودِ سایت حتی در اولین بازدیدِ بدون‌اینترنتِ
 *    بعدی هم باز شود.
 *  - صفحات کتاب‌ها و فایل‌های PDF، به‌صورت خودکار «هرکدام که کاربر
 *    باز کرد» کش می‌شوند (runtime caching) - نه همهٔ کتابخانه یک‌جا،
 *    چون ممکن است کتابخانه حجم زیادی داشته باشد و کش‌کردن همهٔ آن از
 *    اول، هم کند است هم غیرضروری.
 *  - embeddings.json (پایگاه‌دادهٔ جست‌وجو) و خودِ index.htm به‌صورت
 *    "network-first با بازگشت به کش": وقتی اینترنت هست همیشه نسخهٔ
 *    تازه گرفته و کش هم به‌روز می‌شود؛ وقتی اینترنت نیست، آخرین نسخهٔ
 *    کش‌شده نشان داده می‌شود.
 *  - درخواست‌های خارج از همین سایت (مثل تماس با Worker برای گفتگو/
 *    جست‌وجوی معنایی) دست‌نخورده می‌مانند - چون پاسخشان پویاست و
 *    کش‌کردنشان معنی ندارد؛ فقط کتابخانه‌های CDN (مثل PDF.js، که در
 *    آدرسشان شمارهٔ نسخه دارند و هیچ‌وقت عوض نمی‌شوند) کش می‌شوند تا
 *    ویوئر PDF هم آفلاین کار کند.
 *
 * نکته: این فایل باید در ریشهٔ سایت (کنار index.htm) باشد - محدودهٔ
 * (scope) یک Service Worker پیش‌فرض همان پوشه‌ای است که خودش در آن
 * قرار دارد.
 */

// Item جدید (به‌روزرسانی خودکار): این مقدار دیگر نیازی به تغییر دستی
// ندارد - یک workflow جداگانه در گیت‌هاب (.github/workflows/
// update-sw-version.yml) با هر تغییری در index.htm، search-widget.js
// یا in-page-search.js، این خط را خودش با شناسهٔ کامیت (SHA) همان
// تغییر جایگزین می‌کند و مستقیماً commit می‌کند - یعنی هیچ‌وقت لازم
// نیست خودتان یادتان باشد این عدد را بالا ببرید. مقدار زیر فقط یک
// پیش‌فرضِ اولیه است (تا وقتی اولین اجرای آن workflow آن را عوض کند).
const CACHE_VERSION = "milani-cache-07397108";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// آدرس‌هایی که همین حالا (در لحظهٔ نصب) کش می‌شوند - پوستهٔ اصلی سایت.
const SHELL_FILES = [
  "./",
  "index.htm",
  "search-widget.js",
  "in-page-search.js",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      // هر فایلی که (مثلاً چون هنوز آپلود نشده) با خطا مواجه بشه، کل
      // نصب رو خراب نکنه - addAll همه‌یا‌هیچ عمل می‌کنه، پس تک‌تک با
      // catch امتحان می‌کنیم.
      Promise.all(
        SHELL_FILES.map(url =>
          cache.add(url).catch(err => console.warn("cache install skip:", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith("milani-cache-") && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

function isNetworkFirstUrl(url) {
  return url.pathname.endsWith("/index.htm") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/embeddings.json") ||
    url.pathname.endsWith("/embeddings-version.json") ||
    // Item جدید (رفع باگ: فیلتر تاریخ/دکمهٔ ریست تو مرورگرِ عادی دیده
    // نمی‌شد ولی تو ناشناس دیده می‌شد): stats.html این‌جا نبود، پس با
    // اولین بازدید یک‌بار cache-first می‌شد و از اون به بعد، حتی بعد
    // از هر آپدیتی روی خودِ فایل، همون نسخهٔ قدیمیِ کش‌شده برمی‌گشت -
    // چون تغییرات stats.html باعثِ بالارفتنِ CACHE_VERSION نمی‌شه (اون
    // فقط با تغییرِ index.htm/search-widget.js/in-page-search.js عوض
    // می‌شه، نه stats.html) تا کشِ قدیمی باطل بشه. حالت ناشناس چون از
    // اول کشی نداشت، این مشکل رو نشون نمی‌داد. صفحهٔ آمار یک پنلِ
    // مدیریتیه که همیشه باید نسخهٔ تازه‌اش لود بشه، پس بهتره اصلاً
    // هیچ‌وقت cache-first نشه.
    url.pathname.endsWith("/stats.html");
}

async function networkFirst(request) {
  try {
    // Item جدید (رفع باگ: نسخهٔ قدیمی گاهی برمی‌گشت، گاهی نه): سرورِ
    // GitHub Pages برای این فایل‌ها هدر Cache-Control: max-age=3600
    // می‌فرسته - یعنی مرورگر اجازه داره تا یک ساعت، حتی برای همین
    // fetch داخلیِ Service Worker، بدون رفتن به شبکه، نسخهٔ کش‌شده‌ی
    // HTTP معمولیِ خودش رو برگردونه. این کاملاً جدا از Cache Storage
    // (که خودمون کنترلش می‌کنیم) و جدا از کشِ Cloudflare/GitHubه - و
    // همینه که باعث می‌شد نتیجه گاهی تازه، گاهی کهنه باشه. با
    // {cache: "no-store"} صریحاً می‌گیم این fetch همیشه واقعاً از
    // شبکه بره، بدون مشورت با هیچ کشِ HTTP.
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("آفلاین و نسخهٔ کش‌شده‌ای هم موجود نیست");
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;

  // فقط درخواست‌های GET قابل کش‌شدن‌اند.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Item جدید: کتابخانه‌های CDN با نسخه در آدرس (مثل pdf.js) - چون
  // هیچ‌وقت محتوایشان عوض نمی‌شود، cache-first امن و مفید است (هم
  // برای سرعت، هم برای کارکردن ویوئر PDF در حالت آفلاین).
  const isVersionedCdnAsset = !isSameOrigin && /\/\d+\.\d+\.\d+\//.test(url.pathname);

  if (!isSameOrigin && !isVersionedCdnAsset) {
    // بقیهٔ درخواست‌های خارجی (تماس با Worker برای گفتگو/جست‌وجوی
    // معنایی، فونت‌ها و مانند آن) دست‌نخورده و بدون کش رد می‌شوند.
    return;
  }

  if (isVersionedCdnAsset) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isNetworkFirstUrl(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // بقیهٔ فایل‌های همین سایت (صفحات کتاب‌ها، PDFها، تصاویر و غیره):
  // هرچی یک‌بار باز شد، از این به بعد برای آفلاین هم در دسترس می‌ماند.
  event.respondWith(cacheFirst(request));
});
