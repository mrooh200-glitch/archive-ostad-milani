// Item جدید: پرش به «رخداد Nام» یک کلمهٔ تکرارشده در PDF.
//
// خودِ pdf.js فقط از #search=...&phrase=true پشتیبانی می‌کند که همیشه
// به اولین رخداد می‌رود - چیزی مثل occ=N (که در نسخهٔ HTML سایت داریم)
// را نمی‌شناسد. این فایل آن قابلیت را بدون دست‌زدن به خودِ کدِ pdf.js
// اضافه می‌کند: با گوش‌دادن به رویداد استاندارد و مستندِ
// "updatefindmatchescount" (که pdf.js خودش بعد از هر جست‌وجو/رفتن‌به‌
// نتیجهٔ‌بعدی با {current, total} صدا می‌زند)، به همان تعداد لازم رویداد
// "find" با type:"again" (دقیقاً همان چیزی که دکمهٔ «نتیجهٔ بعدی» خودِ
// نوار جست‌وجوی pdf.js می‌زند) دوباره صدا زده می‌شود تا شمارندهٔ داخلیِ
// خودِ pdf.js به رخداد موردنظر برسد. یعنی حرکت واقعی بین نتایج را کاملاً
// خودِ موتور find رسمی pdf.js انجام می‌دهد؛ این اسکریپت فقط چند بار
// دکمهٔ «بعدی» را برایش فشار می‌دهد.
(function () {
  "use strict";

  function getHashParams() {
    var hash = location.hash || "";
    if (hash.charAt(0) === "#") {
      hash = hash.slice(1);
    }
    return new URLSearchParams(hash);
  }

  var hashParams = getHashParams();
  var targetOccurrence = parseInt(hashParams.get("occ"), 10);

  // اگر رخدادی درخواست نشده، یا همان رخداد اول است (که pdf.js خودش
  // به‌طور پیش‌فرض به آن می‌رود)، کاری لازم نیست.
  if (!targetOccurrence || targetOccurrence <= 1) {
    return;
  }

  var rawQuery = hashParams.get("search") || "";
  var isPhrase = hashParams.get("phrase") === "true";
  var query = isPhrase ? rawQuery : (rawQuery.match(/\S+/g) || []);

  function dispatchFindAgain(app) {
    app.eventBus.dispatch("find", {
      source: window,
      type: "again",
      query: query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: true
    });
  }

  function startAdvancing(app) {
    var settled = false;

    function onMatchesCount(evt) {
      var count = evt && evt.matchesCount;

      // هنوز شمارش نتایج آماده نیست (total=0)؛ صبر می‌کنیم تا رویداد
      // بعدی با اطلاعات واقعی برسد.
      if (!count || !count.total) {
        return;
      }

      var reachable = Math.min(targetOccurrence, count.total);

      if (count.current >= reachable) {
        if (!settled) {
          settled = true;
          app.eventBus.off("updatefindmatchescount", onMatchesCount);
        }
        return;
      }

      dispatchFindAgain(app);
    }

    app.eventBus.on("updatefindmatchescount", onMatchesCount);

    // ایمنیِ اضافه: اگر به هر دلیلی رویداد اول هرگز با total واقعی
    // نرسد (مثلاً جست‌وجو چیزی پیدا نکرد)، بعد از چند ثانیه گوش‌دادن را
    // متوقف می‌کنیم تا اسکریپت برای همیشه به رویدادها گوش ندهد.
    setTimeout(function () {
      if (!settled) {
        app.eventBus.off("updatefindmatchescount", onMatchesCount);
      }
    }, 15000);
  }

  function whenReady(callback) {
    var app = window.PDFViewerApplication;

    if (app && app.initializedPromise) {
      app.initializedPromise.then(function () {
        callback(app);
      });
      return;
    }

    document.addEventListener("DOMContentLoaded", function () {
      whenReady(callback);
    });
  }

  whenReady(startAdvancing);
})();
