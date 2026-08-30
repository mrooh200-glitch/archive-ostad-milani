(function () {
  "use strict";

  const ignoredTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "SVG",
    "CANVAS",
    "MARK",
    "TEXTAREA",
    "INPUT",
    "BUTTON",
    "SELECT",
    "OPTION"
  ]);

  let matches = [];
  let currentMatch = -1;
  let searchBoxElement = null;
  let resultsPanelElement = null;
  let archiveOverlayElement = null;
  const selectedMatchIndexes = new Set();
  const activeDerivativeKeys = new Set();

  // Item ب: results-panel ordering. "position" keeps the original
  // top-to-bottom document order; "frequency" puts the most-repeated
  // surface form first (see getResultsSortComparator).
  let resultsSortMode = "position";

  // Item ز: proximity search state. When enabled, the query's words
  // no longer need to be adjacent - they just need to occur within
  // proximityDistance words of each other (see highlightProximityMatches).
  let proximitySearchEnabled = false;
  let proximityDistance = 5;

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // fall through to the legacy fallback below
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      const successful = document.execCommand("copy");
      document.body.removeChild(textarea);

      return successful;
    } catch (error) {
      return false;
    }
  }

  // Copies both a plain-text version (for targets that only accept
  // text) and an HTML version (for targets that accept rich paste -
  // Word, Gmail, WhatsApp/Telegram desktop, etc.). The HTML version
  // turns each long reference URL into a short clickable "لینک منبع"
  // link instead of dumping the raw address into the pasted text.
  async function copyRichTextToClipboard(text, html) {
    try {
      if (
        navigator.clipboard &&
        window.isSecureContext &&
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard.write
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" })
          })
        ]);
        return true;
      }
    } catch (error) {
      // fall through to the plain-text-only fallback below
    }

    return copyTextToClipboard(text);
  }

  // ---- Item 1: recent-search history ---------------------------------
  // A small custom dropdown (shown on focus/hover, before the user has
  // typed anything new) listing the last few searches, backed by
  // localStorage so it survives reloads and isn't at the mercy of the
  // browser's own autocomplete (which only ever surfaced a single old
  // value). Shared across all book pages under one key, same pattern
  // as ARCHIVE_STORAGE_KEY below.
  const SEARCH_HISTORY_KEY = "milaniSearchHistoryRecent";
  const SEARCH_HISTORY_MAX = 5;

  function loadSearchHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : [];
    } catch (error) {
      return [];
    }
  }

  function saveSearchHistory(list) {
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list));
    } catch (error) {
      // Storage unavailable or full - history just won't persist.
    }
  }

  function pushSearchHistory(query) {
    const trimmed = (query || "").trim();

    if (!trimmed) {
      return;
    }

    const existing = loadSearchHistory().filter(item => item !== trimmed);
    existing.unshift(trimmed);

    saveSearchHistory(existing.slice(0, SEARCH_HISTORY_MAX));
  }

  let searchHistoryReflowHandler = null;

  // Positions #inPageSearchHistory in fixed (viewport) coordinates,
  // anchored under the input's own current on-screen rect. This has to
  // be position:fixed rather than the simpler position:absolute anchor
  // because the dropdown lives inside .in-page-search-row, which has
  // overflow-x:auto - and per the CSS overflow spec, setting overflow-x
  // to anything but visible forces overflow-y to effectively become
  // auto too, so that row clips away anything poking out below it,
  // including an absolutely-positioned dropdown. This is the exact
  // issue #inPageSettingsMenu already had to work around; see
  // positionSettingsMenu() below for the same pattern.
  function positionSearchHistoryDropdown() {
    const dropdown = document.getElementById("inPageSearchHistory");
    const input = document.getElementById("inPageSearchInput");

    if (!dropdown || !input || !dropdown.classList.contains("is-open")) {
      return;
    }

    const GAP = 4;
    const inputRect = input.getBoundingClientRect();

    // Default: right under the input box itself, matching its width.
    dropdown.style.left = inputRect.left + "px";
    dropdown.style.top = (inputRect.bottom + GAP) + "px";
    dropdown.style.width = inputRect.width + "px";

    if (historyFitsOnOneLine(dropdown)) {
      return;
    }

    // Doesn't fit at the input's own (often narrow) width. Rather than
    // splitting the label away from the pills, give the whole label+
    // pills row much more room: move the WHOLE box to start under the
    // book title (the toolbar row's own right/start edge) and span
    // that row's full width, so the label and pills can stay together
    // on one line there instead.
    const row = searchBoxElement && searchBoxElement.querySelector(".in-page-search-row");

    if (!row) {
      return;
    }

    const rowRect = row.getBoundingClientRect();

    dropdown.style.left = rowRect.left + "px";
    dropdown.style.top = (rowRect.bottom + GAP) + "px";
    dropdown.style.width = rowRect.width + "px";
  }

  // Real measurement (not a guess) of whether the label + all pills,
  // together with the gaps between them, fit within the dropdown's
  // current width without wrapping.
  function historyFitsOnOneLine(dropdown) {
    const COLUMN_GAP = 8; // must match the CSS "gap" column value
    const children = Array.from(dropdown.children);
    const neededWidth = children.reduce((sum, el) => sum + el.offsetWidth, 0)
      + COLUMN_GAP * Math.max(children.length - 1, 0);

    return neededWidth <= dropdown.clientWidth;
  }

  function renderSearchHistoryDropdown() {
    const dropdown = document.getElementById("inPageSearchHistory");

    if (!dropdown) {
      return;
    }

    const history = loadSearchHistory();

    if (history.length === 0) {
      dropdown.innerHTML = "";
      dropdown.classList.remove("is-open");
      dropdown.style.left = "";
      dropdown.style.top = "";
      dropdown.style.width = "";
      return;
    }

    dropdown.innerHTML =
      `<div class="in-page-search-history-label">جست‌وجوهای اخیر</div>` +
      history.map(item =>
        `<button type="button" class="in-page-search-history-item">${escapeHtml(item)}</button>`
      ).join("");

    dropdown.querySelectorAll(".in-page-search-history-item").forEach(button => {
      // mousedown (not click) so this fires BEFORE the input's blur
      // handler hides the dropdown out from under it.
      button.addEventListener("mousedown", event => {
        event.preventDefault();

        const input = document.getElementById("inPageSearchInput");
        input.value = button.textContent;
        closeSearchHistoryDropdown();
        performSearch();
        pushSearchHistory(button.textContent);
        renderSearchHistoryDropdown();
      });
    });
  }

  function openSearchHistoryDropdown() {
    const dropdown = document.getElementById("inPageSearchHistory");
    const input = document.getElementById("inPageSearchInput");

    if (!dropdown || !input) {
      return;
    }

    // Note: deliberately NOT bailing out just because the box already
    // has text in it. Unlike the site-wide search box on index.htm
    // (which starts empty on every page load), this box keeps whatever
    // was last typed for as long as the book page stays open, so
    // requiring an empty box here would mean the history almost never
    // shows on hover/focus after the first search of the session.
    // Typing a new character still closes it immediately (see the
    // "input" listener in initialize()).
    renderSearchHistoryDropdown();

    if (dropdown.innerHTML.trim()) {
      dropdown.classList.add("is-open");
      positionSearchHistoryDropdown();

      if (!searchHistoryReflowHandler) {
        searchHistoryReflowHandler = () => positionSearchHistoryDropdown();
        window.addEventListener("resize", searchHistoryReflowHandler);
        window.addEventListener("scroll", searchHistoryReflowHandler, true);
      }
    }
  }

  // Item 1 (extended): the dropdown can end up positioned away from
  // the input itself (see positionSearchHistoryDropdown() - it may
  // widen out to the full toolbar row), so a plain "mouseleave on the
  // input" can no longer be trusted to mean "the user is done with
  // this" - the cursor is very likely just crossing the gap on its way
  // TO the dropdown. historyCloseTimer debounces closing so it only
  // actually happens if the pointer isn't hovering the input, isn't
  // hovering the dropdown, AND the input isn't focused, all checked
  // together after a short delay.
  let historyCloseTimer = null;

  function cancelScheduledHistoryClose() {
    if (historyCloseTimer) {
      clearTimeout(historyCloseTimer);
      historyCloseTimer = null;
    }
  }

  function scheduleHistoryClose() {
    cancelScheduledHistoryClose();

    historyCloseTimer = setTimeout(() => {
      historyCloseTimer = null;

      const dropdown = document.getElementById("inPageSearchHistory");
      const input = document.getElementById("inPageSearchInput");

      const stillWanted =
        (dropdown && dropdown.matches(":hover")) ||
        (input && (input.matches(":hover") || document.activeElement === input));

      if (!stillWanted) {
        closeSearchHistoryDropdown();
      }
    }, 200);
  }

  function closeSearchHistoryDropdown() {
    cancelScheduledHistoryClose();

    const dropdown = document.getElementById("inPageSearchHistory");

    if (dropdown) {
      dropdown.classList.remove("is-open");
      dropdown.style.left = "";
      dropdown.style.top = "";
      dropdown.style.width = "";
    }

    if (searchHistoryReflowHandler) {
      window.removeEventListener("resize", searchHistoryReflowHandler);
      window.removeEventListener("scroll", searchHistoryReflowHandler, true);
      searchHistoryReflowHandler = null;
    }
  }

  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ۀ/g, "ه")
      .replace(/ة/g, "ه")
      // Strip Arabic/Persian diacritics (اعراب) and tatweel so a query
      // typed WITHOUT diacritics still matches text that HAS them
      // (e.g. "کتاب" finds "کِتاب").
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Root-based (stemming) search --------------------------------
  // Two layers, applied in order:
  //  1) Arabic root-and-pattern (وزن) extraction, a simplified version
  //     of the classic ISRI algorithm: recognizes the most common
  //     "augment letter" positions (سألتمونيه) in 4/5/6-letter words
  //     and strips them to reach the 3-letter triliteral root. This
  //     is what connects surface-different words like حادثه / حدوث /
  //     حوادث / حادث, or کتاب / کاتب / مکتوب / الکتاب, which no
  //     amount of prefix/suffix stripping alone can do.
  //  2) A light Persian/Arabic affix stripper (prefixes می‌/نمی‌/بی‌/
  //     ال, suffixes ها/ان/تر/ترین/...) for words the pattern step
  //     doesn't fully resolve.
  // Pattern extraction runs BEFORE the generic suffix stripper so that
  // real root letters aren't cannibalized by an accidentally-matching
  // generic suffix (e.g. "کریم" ends in "یم", which is also a common
  // verb suffix - resolving the فعیل pattern first keeps the "م" that
  // a naive suffix strip would have removed).
  // Not a full morphological analyzer or dictionary lookup - it will
  // still miss irregular/weak-letter verbs and occasionally produce a
  // wrong or overly short root. Good enough for connecting the common
  // derivational families in this archive; a dictionary-based
  // approach (e.g. the Arramooz word/root database) would be the next
  // step up in accuracy if ever needed.

  const STEM_MIN_ROOT_LENGTH = 2;

  // Note: single-letter Arabic proclitics (و/ف/ب/ل/ک) are deliberately
  // NOT included here - they falsely strip the first letter of countless
  // ordinary Persian words (e.g. "کتاب" -> "تاب"), doing far more harm
  // than good on this mostly-Persian corpus.
  const STEM_PREFIXES = [
    "نمی", "می", "بی",
    "وال", "بال", "فال", "کال", "لل",
    "ال"
  ].sort((a, b) => b.length - a.length);

  const STEM_SUFFIXES = [
    "هایمان", "هایتان", "هایشان",
    "هایم", "هایت", "هایش",
    "ترین", "های", "گان",
    "یم", "ید", "ند", "تر",
    "ها", "ان", "ات", "ون", "ین", "یه",
    "ی", "ه"
  ].sort((a, b) => b.length - a.length);

  // "سألتمونيه" - the classic set of Arabic augment letters (with ي
  // normalized to ی), used when deciding whether a leading/trailing
  // letter on a long word is likely an augment rather than a root
  // letter.
  const AUGMENT_LETTERS = new Set(
    ["ا", "و", "ی", "ت", "ن", "م", "س", "ه"]
  );

  const WORD_PATTERN = /[\u0621-\u06FF]+(?:\u200c[\u0621-\u06FF]+)*/g;

  function stripDiacritics(text) {
    return (text || "")
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
      .replace(/[\u200c\u200e\u200f]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ی");
  }

  function cleanWord(word) {
    return normalize(stripDiacritics(word));
  }

  // Reduce a 4-letter word to its 3-letter root by removing one
  // augment letter at the position where a known measure (وزن) puts
  // it. Returns null if no recognized pattern applies.
  function reduceFourLetter(word) {
    const c0 = word[0];
    const c1 = word[1];
    const c2 = word[2];
    const c3 = word[3];

    if (c1 === "ا") return c0 + c2 + c3; // فاعل  (حادث -> حدث)
    if (c2 === "ا") return c0 + c1 + c3; // فِعال (کتاب -> کتب)
    if (c2 === "و") return c0 + c1 + c3; // فعول  (حدوث -> حدث)
    if (c2 === "ی") return c0 + c1 + c3; // فعیل  (کریم -> کرم)
    if (c0 === "م") return c1 + c2 + c3; // مفعل  (مکتب -> کتب)
    if (c0 === "ت") return c1 + c2 + c3; // تفعّل (تعلم -> علم)

    return null;
  }

  // Reduce a 5-letter word to its 3-letter root by removing two
  // augment letters at known measure positions.
  function reduceFiveLetter(word) {
    const c0 = word[0];
    const c1 = word[1];
    const c2 = word[2];
    const c3 = word[3];
    const c4 = word[4];

    if (c1 === "و" && c2 === "ا") return c0 + c3 + c4; // فواعل (حوادث -> حدث)
    if (c0 === "م" && c2 === "ا") return c1 + c3 + c4; // مفاعل (مساجد -> سجد)
    if (c0 === "م" && c3 === "و") return c1 + c2 + c4; // مفعول (مکتوب -> کتب)
    if (c0 === "ت" && c3 === "ی") return c1 + c2 + c4; // تفعیل (توحید -> وحد)
    if (c1 === "ت" && c3 === "ا") return c0 + c2 + c4; // تفاعل-ish
    if (c2 === "ا" && c3 === "ی") return c0 + c1 + c4; // فعائل (رسائل -> رسل)

    return null;
  }

  // For 6+ letter words, fall back to peeling one plausible augment
  // letter off either end and letting the loop in deaugmentToRoot()
  // retry the shorter word.
  function reduceLongWord(word) {
    const first = word[0];

    if (AUGMENT_LETTERS.has(first) && word.length - 1 >= 4) {
      return word.slice(1);
    }

    const last = word[word.length - 1];

    if (AUGMENT_LETTERS.has(last) && word.length - 1 >= 4) {
      return word.slice(0, -1);
    }

    return null;
  }

  function deaugmentToRoot(word) {
    let w = word;
    let guard = 0;

    while (w.length > 3 && guard < 4) {
      guard += 1;

      let reduced = null;

      if (w.length === 4) {
        reduced = reduceFourLetter(w);
      } else if (w.length === 5) {
        reduced = reduceFiveLetter(w);
      } else if (w.length >= 6) {
        reduced = reduceLongWord(w);
      }

      if (reduced === null || reduced.length >= w.length) {
        break;
      }

      w = reduced;
    }

    return w;
  }

  function stripOnePrefix(word) {
    for (const prefix of STEM_PREFIXES) {
      if (
        word.startsWith(prefix) &&
        word.length - prefix.length >= STEM_MIN_ROOT_LENGTH
      ) {
        return word.slice(prefix.length);
      }
    }

    return word;
  }

  function stripSuffixes(word) {
    let result = word;

    for (let pass = 0; pass < 2; pass++) {
      for (const suffix of STEM_SUFFIXES) {
        if (
          result.endsWith(suffix) &&
          result.length - suffix.length >= STEM_MIN_ROOT_LENGTH
        ) {
          result = result.slice(0, -suffix.length);
          break;
        }
      }
    }

    return result;
  }

  function stemWord(word) {
    let w = stripOnePrefix(cleanWord(word));

    if (w.length > 3) {
      const patternResult = deaugmentToRoot(w);

      if (patternResult.length === 3) {
        return patternResult;
      }

      w = patternResult;
    }

    w = stripSuffixes(w);

    if (w.length > 3) {
      w = deaugmentToRoot(w);
    }

    return w;
  }

  function getQueryStems(query) {
    return query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(stemWord)
      .filter(Boolean);
  }

  function isRootSearchEnabled() {
    const toggle = document.getElementById("inPageSearchRoot");
    return !!(toggle && toggle.checked);
  }

  // The derivatives block is opt-in (separate from root-search itself)
  // so that turning on root search alone doesn't automatically eat up
  // screen space - the reader has to explicitly ask to see it.
  function isDerivativesViewEnabled() {
    const toggle = document.getElementById("inPageShowDerivatives");
    return !!(toggle && toggle.checked);
  }

  // Only relevant while root search is on. Keeps the checkbox out of
  // the way (and unchecked) the rest of the time.
  function updateDerivativesToggleVisibility() {
    const label = document.getElementById("inPageShowDerivativesLabel");

    if (!label) {
      return;
    }

    label.style.display = isRootSearchEnabled() ? "inline-flex" : "none";
  }

  const bookTitlesByFileName = {
    "Aghaye-Javadi-va-Hodous.htm": "آقای جوادی و حدوث",
    "Esbat-e-Towhid-va-Botlan-e-Vahdat-e-Vojoud.htm":
      "اثبات توحید و بطلان وحدت وجود",
    "Faratar-az-Erfan.htm": "فراتر از عرفان",
    "Osoul-al-Maaref-al-Elahiyya.htm": "اصول المعارف الالهیة",
    "al-Elan-an-Asrar-al-Falsafa-wal-Erfan.htm":
      "الإعلان عن اسرار الفلسفة والعرفان",
    "marefatollah-mohashsha.htm": "متن درس معرفة الله (محشّی)"
  };

  function getPageTitle() {
    const fileName = decodeURIComponent(
      (location.pathname.split("/").pop() || "").trim()
    );

    if (bookTitlesByFileName[fileName]) {
      return bookTitlesByFileName[fileName];
    }

    return document.title || "";
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Character-variant equivalence classes - the same letter pairs
  // normalize() treats as identical (ي/ی/ى, ك/ک, ة/ه/ۀ). Building the
  // search regex with these classes (instead of the literal typed
  // character) means a query typed with a Persian keyboard (ک) still
  // matches - and highlights - the Arabic form (ك) wherever it occurs
  // in the source text, and vice versa, without needing to rewrite
  // the original text or remap character offsets.
  const CHAR_VARIANTS = {
    "ي": "يیى", "ی": "يیى", "ى": "يیى",
    "ك": "كک", "ک": "كک",
    "ة": "ةه", "ه": "ةهۀ", "ۀ": "ۀه"
  };

  function charClassFor(ch) {
    const variants = CHAR_VARIANTS[ch];

    if (variants) {
      const unique = [...new Set(variants.split(""))];
      return `[${unique.join("")}]`;
    }

    return escapeRegExp(ch);
  }

  // Boundary used so normal (non-root) search only matches whole
  // words - e.g. searching "وجود" must not match inside "الوجود" or
  // "موجودات". \b doesn't work here since JS regex \w is ASCII-only
  // and doesn't recognize Arabic/Persian letters, so this uses an
  // explicit lookaround against the Arabic Unicode letter block
  // (plus ZWNJ, so a half-spaced compound like "کتاب‌خانه" still
  // counts as one word and isn't matched by "کتاب" alone).
  const WORD_BOUNDARY_CHARS = "\\u0621-\\u06FF\\u200c";

  // Optional run of diacritics/tatweel allowed BETWEEN each typed
  // character when matching against the real (undiacritized-query,
  // possibly-diacritized-source) page text - this is what lets a
  // plain query still highlight a diacritized occurrence like
  // "کِتاب" in the actual page content.
  const DIACRITIC_GAP = "[\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u0640]*";

  function buildQueryPattern(query) {
    const collapsed = query.trim().replace(/\s+/g, " ");

    if (!collapsed) {
      return "";
    }

    const charPattern = collapsed
      .split("")
      .map(ch => (ch === " " ?
        "\\s+" :
        charClassFor(ch) + DIACRITIC_GAP))
      .join("");

    return (
      `(?<![${WORD_BOUNDARY_CHARS}])` +
      charPattern +
      `(?![${WORD_BOUNDARY_CHARS}])`
    );
  }

  // Item 1: previously-searched words on hover/focus. This relies on
  // the browser's own native "remember what I typed in this field"
  // autocomplete, not a custom dropdown - so the fix is just making
  // sure this field looks like a normal remembered field to the
  // browser: autocomplete must not be "off", and it needs a stable
  // name. It intentionally reuses the SAME name ("siteSearch") as the
  // main site's search box in index.htm, so the two share one
  // browser-side history: anything typed in either one shows up as a
  // suggestion in both.
  function createSearchBox() {
    const box = document.createElement("section");

    box.id = "inPageSearchBox";
    box.innerHTML = `
      <div class="in-page-search-row">
        <span id="inPageSearchTitle">${getPageTitle()}</span>

        <label for="inPageSearchInput">جست‌وجو:</label>

        <div class="in-page-search-input-wrap">
          <input
            id="inPageSearchInput"
            name="siteSearch"
            type="search"
            placeholder="کلمه یا عبارت مورد نظر را بنویسید."
            autocomplete="off">

          <div id="inPageSearchHistory" class="in-page-search-history"></div>
        </div>

        <button
          id="inPageSearchPrevious"
          type="button"
          disabled
          title="قبلی"
          aria-label="قبلی">
          ▶
        </button>

        <button
          id="inPageSearchNext"
          type="button"
          disabled
          title="بعدی"
          aria-label="بعدی">
          ◀
        </button>

        <button
          id="inPageVoiceInput"
          type="button"
          class="in-page-voice-input-button"
          title="جست‌وجوی صوتی"
          aria-label="جست‌وجوی صوتی">
          🎤
        </button>

        <label class="in-page-search-root-label" for="inPageSearchRoot">
          <input id="inPageSearchRoot" type="checkbox">
          ریشه‌ای
        </label>

        <label
          id="inPageShowDerivativesLabel"
          class="in-page-search-derivatives-toggle-label"
          for="inPageShowDerivatives"
          style="display:none;">
          <input id="inPageShowDerivatives" type="checkbox">
          مشاهده مشتقات
        </label>

        <div class="in-page-settings-wrap">
          <button
            id="inPageSettingsGear"
            type="button"
            class="in-page-settings-gear"
            title="ابزارها و تنظیمات نتایج"
            aria-label="ابزارها و تنظیمات نتایج"
            aria-haspopup="true"
            aria-expanded="false">
            ⚙️
          </button>

          <div id="inPageSettingsMenu" class="in-page-settings-menu" role="menu"></div>
        </div>

        <p id="inPageSearchStatus" aria-live="polite"></p>
      </div>

      <div class="in-page-status-row">
        <div
          id="inPageDerivativesBlock"
          class="in-page-derivatives-inline"
          aria-label="مشتقات یافت‌شده"></div>
      </div>
    `;

    document.body.insertBefore(box, document.body.firstChild);
    searchBoxElement = box;

    const resultsPanel = document.createElement("aside");
    resultsPanel.id = "inPageSearchResults";
    resultsPanel.setAttribute("aria-label", "نتایج جست‌وجو");

    document.body.insertBefore(resultsPanel, box.nextSibling);
    resultsPanelElement = resultsPanel;

    const archiveOverlay = document.createElement("div");
    archiveOverlay.id = "inPageArchiveOverlay";
    archiveOverlay.innerHTML = `<div id="inPageArchivePanel" role="dialog" aria-label="آرشیو نتایج"></div>`;
    document.body.insertBefore(archiveOverlay, resultsPanel.nextSibling);
    archiveOverlayElement = archiveOverlay;

    archiveOverlay.addEventListener("click", event => {
      if (event.target === archiveOverlay) {
        closeArchivePanel();
      }
    });

    const style = document.createElement("style");
    style.textContent = `
      #inPageSearchBox {
        position: sticky;
        top: 0;
        z-index: 9999;
        box-sizing: border-box;
        padding: 6px 12px;
        border-bottom: 1px solid #cbd5e1;
        background: #ffffff;
        box-shadow: 0 3px 10px rgba(15, 23, 42, 0.10);
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl !important;
        text-align: right !important;
      }

      #inPageSearchTitle {
        color: #b45309;
        font-size: 0.95rem;
        font-weight: bold;
        white-space: nowrap;
        flex-shrink: 0;
        padding-inline-end: 8px;
        border-inline-end: 2px solid #2563eb;
      }

      .in-page-search-row {
        display: flex;
        flex-wrap: nowrap;
        overflow-x: auto;
        align-items: center;
        gap: 8px;
        width: min(1100px, 100%);
        margin: 0 auto;
      }

      .in-page-search-row label {
        color: #173b63;
        font-size: 0.92rem;
        font-weight: bold;
      }

      .in-page-search-row button,
      .in-page-search-row > label {
        flex-shrink: 0;
      }

      #inPageSearchInput {
        flex: 1 1 220px;
        min-width: 140px;
        padding: 6px 10px;
        border: 1px solid #94a3b8;
        border-radius: 7px;
        outline: none;
        font: inherit;
      }

      #inPageSearchInput:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
      }

      #inPageSearchBox button {
        padding: 5px 10px;
        border: 1px solid #93c5fd;
        border-radius: 7px;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font: inherit;
        font-size: 0.86rem;
      }

      #inPageSearchBox button:hover:not(:disabled) {
        background: #dbeafe;
      }

      #inPageSearchBox button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .in-page-search-root-label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #173b63;
        font-size: 0.84rem;
        font-weight: normal;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }

      .in-page-search-root-label input {
        margin: 0;
        cursor: pointer;
      }

      /* The status line ("نتیجهٔ ۱ از ۱") and the derivatives chips
         share one row, using the empty space after the status text
         instead of opening a separate full-width block underneath. */
      .in-page-status-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        width: min(1100px, 100%);
        margin: 0 auto;
      }

      /* Only reserve space for the row once it actually has content
         (a status message and/or derivative chips). Empty (no
         active search) collapses to zero height instead of leaving
         blank space at the bottom of the white search bar. */
      .in-page-status-row.has-content {
        margin-top: 4px;
        min-height: 16px;
      }

      #inPageSearchStatus {
        margin: 0;
        color: #475569;
        font-size: 0.78rem;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .in-page-derivatives-inline {
        display: none;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }

      .in-page-derivatives-inline.is-visible {
        display: flex;
      }

      .in-page-derivatives-inline-label {
        color: #334155;
        font-size: 0.72rem;
        font-weight: 600;
        white-space: nowrap;
      }

      .in-page-search-input-wrap {
        position: relative;
        flex: 1 1 220px;
        min-width: 140px;
      }

      .in-page-search-input-wrap #inPageSearchInput {
        width: 100%;
      }

      .in-page-search-history {
        display: none;
        /* position:fixed (not absolute) is required here for the same
           reason as .in-page-settings-menu below: the toolbar row
           above sets overflow-x:auto, which per spec forces its
           overflow-y to auto as well, clipping any absolutely-
           positioned descendant that pokes out below the row - which
           this dropdown always does. Fixed positioning escapes that
           clipping. Exact left/top/width are set in JS by
           positionSearchHistoryDropdown(); these are just harmless
           pre-JS defaults. */
        position: fixed;
        top: 0;
        left: 0;
        z-index: 10002;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.15);
        padding: 6px 8px;
      }

      /* Horizontal, wrapping layout: the label and the (up to 5)
         recent-search pills sit in one row, right after each other.
         The container's width is pinned (in JS) to the search box's
         own width, so once the pills no longer fit on one line, flex-
         wrap moves the overflow onto a second line - and since the
         label is the first flex item, it's what ends up alone at the
         start of the first line while the pills wrap beneath it. */
      .in-page-search-history.is-open {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 8px;
      }

      .in-page-search-history-label {
        flex: 0 0 auto;
        color: #94a3b8;
        font-size: 0.62rem;
        font-weight: bold;
        white-space: nowrap;
      }

      .in-page-search-history-item {
        flex: 0 0 auto;
        box-sizing: border-box;
        padding: 3px 8px;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        background: #f8fafc;
        color: #173b63;
        font: inherit;
        font-size: 0.62rem;
        white-space: nowrap;
        cursor: pointer;
      }

      .in-page-search-history-item:hover {
        background: #eff6ff;
        border-color: #93c5fd;
      }

      .in-page-settings-wrap {
        position: relative;
        flex-shrink: 0;
      }

      .in-page-settings-gear {
        padding: 5px 9px;
        border: 1px solid #93c5fd;
        border-radius: 7px;
        background: #eff6ff;
        cursor: pointer;
        font-size: 0.95rem;
        line-height: 1;
      }

      .in-page-settings-gear:hover {
        background: #dbeafe;
      }

      .in-page-settings-menu {
        display: none;
        /* position:fixed (not absolute) is required here: the
           toolbar row above sets overflow-x:auto, and per the CSS
           spec that forces its overflow-y to auto as well, which
           clips ANY absolutely-positioned descendant (like this
           menu used to be) down to the row's own one-line height —
           no matter what max-height the menu itself has. Fixed
           positioning escapes that clipping entirely. Exact
           left/top/bottom/max-height are all set in JS by
           positionSettingsMenu(), which runs synchronously before
           paint, so these are just harmless pre-JS defaults. */
        position: fixed;
        top: 0;
        left: 0;
        z-index: 10002;
        width: 240px;
        max-width: 88vw;
        /* Fallback only, used before JS has a chance to measure the
           real available space (see positionSettingsMenu). */
        max-height: 70vh;
        overflow-y: auto;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        box-shadow: 0 10px 26px rgba(15, 23, 42, 0.20);
        padding: 6px;
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
      }

      .in-page-settings-menu.is-open {
        display: block;
      }

      .in-page-settings-menu button.in-page-settings-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 9px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #1f2937;
        font: inherit;
        font-size: 0.84rem;
        text-align: right;
        cursor: pointer;
      }

      .in-page-settings-menu button.in-page-settings-item:hover:not(:disabled) {
        background: #eff6ff;
      }

      .in-page-settings-menu button.in-page-settings-item:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .in-page-settings-menu .in-page-settings-badge {
        color: #64748b;
        font-size: 0.72rem;
      }

      .in-page-settings-separator {
        height: 1px;
        margin: 5px 2px;
        background: #e2e8f0;
      }

      .in-page-settings-section-label {
        padding: 6px 9px 2px;
        color: #94a3b8;
        font-size: 0.68rem;
        font-weight: bold;
      }

      .in-page-settings-menu label.in-page-settings-radio,
      .in-page-settings-menu label.in-page-settings-checkbox {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 9px;
        font-size: 0.82rem;
        color: #1f2937;
        cursor: pointer;
      }

      .in-page-settings-proximity-distance {
        width: 42px;
        margin-inline-start: 4px;
        padding: 2px 4px;
        border: 1px solid #cbd5e1;
        border-radius: 5px;
        font: inherit;
      }

      mark.in-page-search-match {
        padding: 1px 2px;
        border-radius: 2px;
        background: #fde68a;
        color: inherit;
      }

      mark.in-page-search-match.current-match {
        outline: 2px solid #ea580c;
        background: #fbbf24;
      }

      @media (max-width: 600px) {
        #inPageSearchBox {
          padding: 6px 10px;
        }

        .in-page-search-row {
          flex-wrap: wrap;
          overflow-x: visible;
          gap: 6px;
        }

        .in-page-search-row label {
          width: 100%;
        }

        .in-page-search-input-wrap {
          flex-basis: 100%;
        }
      }

      .in-page-voice-input-button {
        padding: 5px 10px;
        border: 1px solid #93c5fd;
        border-radius: 8px;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        white-space: nowrap;
      }

      .in-page-voice-input-button:hover:not(:disabled) {
        background: #dbeafe;
      }

      .in-page-voice-input-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .in-page-voice-input-button.is-listening {
        background: #fee2e2;
        border-color: #fca5a5;
        color: #b91c1c;
      }

      #inPageSearchResults {
        display: none;
        box-sizing: border-box;
        overflow-y: auto;
        background: #ffffff;
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
      }

      #inPageSearchResults.has-results {
        display: block;
      }

      #inPageSearchResults .in-page-search-results-header {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        padding: 8px 12px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #173b63;
        font-size: 0.82rem;
        font-weight: bold;
      }

      #inPageSearchResults .in-page-search-results-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .in-page-search-copy-button {
        border: 1px solid #93c5fd;
        border-radius: 6px;
        background: #eff6ff;
        color: #1d4ed8;
        font: inherit;
        font-size: 0.74rem;
        padding: 4px 8px;
        cursor: pointer;
      }

      .in-page-search-copy-button:hover:not(:disabled) {
        background: #dbeafe;
      }

      .in-page-search-copy-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      #inPageSearchResults .in-page-search-results-close {
        border: none;
        background: transparent;
        color: #64748b;
        font-size: 1.05rem;
        line-height: 1;
        cursor: pointer;
        padding: 2px 6px;
      }

      #inPageSearchResults .in-page-search-results-close:hover {
        color: #1d4ed8;
      }

      .in-page-search-result-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        padding: 9px 12px;
        border-bottom: 1px solid #eef2f7;
      }

      .in-page-search-result-item:last-child {
        border-bottom: none;
      }

      .in-page-result-checkbox {
        margin: 5px 0 0;
        flex-shrink: 0;
        cursor: pointer;
      }

      /* Item 5: small ordinal badge next to each result. */
      .in-page-result-number {
        flex-shrink: 0;
        margin-top: 3px;
        min-width: 18px;
        padding: 1px 5px;
        border-radius: 9999px;
        background: #f1f5f9;
        color: #64748b;
        font-size: 0.68rem;
        font-weight: bold;
        text-align: center;
      }

      .in-page-search-result-jump {
        flex: 1;
        min-width: 0;
        padding: 0;
        border: none;
        background: transparent;
        color: #334155;
        font: inherit;
        font-size: 0.85rem;
        line-height: 1.9;
        text-align: right;
        direction: rtl;
        cursor: pointer;
      }

      .in-page-search-result-jump:hover {
        text-decoration: underline;
      }

      .in-page-search-result-item.active {
        background: #dbeafe;
        border-right: 3px solid #2563eb;
        padding-right: 9px;
      }

      .in-page-search-result-item mark {
        padding: 1px 2px;
        border-radius: 2px;
        background: #fde68a;
      }

      @media (min-width: 861px) {
        #inPageSearchResults {
          position: fixed;
          top: 0;
          left: 0;
          width: 220px;
          max-width: 90vw;
          bottom: 0;
          border-left: 1px solid #cbd5e1;
          box-shadow: 3px 0 10px rgba(15, 23, 42, 0.08);
        }

        /* Item 8 fix: the results panel above is position:fixed and
           sits on top of the page, so without this the left edge of
           the actual book text is hidden underneath it. Push the
           whole page content to the right by the panel's width
           whenever it's open, so nothing is covered. */
        body.in-page-search-results-open {
          margin-left: 220px;
          transition: margin-left 0.15s ease;
        }

        /* Exempt the sticky search bar itself from the push above:
           cancel the shift so it stays full width and its settings
           row doesn't need horizontal scrolling to reach the
           derivatives-toggle / archive button at the end of the
           row. Safe to extend back over that space because the
           results panel already starts below the search bar's own
           height (see reserveScrollOffsetForStickyBox), not at the
           very top, so nothing ends up covered. */
        body.in-page-search-results-open #inPageSearchBox {
          margin-left: -220px;
          width: calc(100% + 220px);
        }
      }

      @media (max-width: 860px) {
        #inPageSearchResults {
          position: static;
          width: 100%;
          max-height: 320px;
          border-top: 1px solid #cbd5e1;
        }
      }

      .in-page-search-derivatives-toggle-label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #173b63;
        font-size: 0.84rem;
        font-weight: normal;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }

      .in-page-search-derivatives-toggle-label input {
        margin: 0;
        cursor: pointer;
      }

      .in-page-derivatives-empty {
        font-size: 0.85rem;
        color: #64748b;
      }

      .in-page-derivatives-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        font-size: 0.72rem;
        border: 1px solid #cbd5e1;
        border-radius: 9999px;
        background: #ffffff;
        color: #334155;
        cursor: pointer;
        user-select: none;
      }

      .in-page-derivatives-item.is-active {
        background: #0f766e;
        border-color: #0f766e;
        color: #ffffff;
      }

      #inPageArchiveOverlay {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 10001;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.45);
      }

      #inPageArchiveOverlay.open {
        display: flex;
      }

      #inPageArchivePanel {
        width: min(560px, 100%);
        max-height: 80vh;
        overflow-y: auto;
        background: #ffffff;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.25);
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
      }

      #inPageArchivePanel .archive-header {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #173b63;
        font-weight: bold;
      }

      #inPageArchivePanel .archive-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .archive-item {
        padding: 10px 16px;
        border-bottom: 1px solid #eef2f7;
      }

      .archive-item:last-child {
        border-bottom: none;
      }

      .archive-item-title {
        color: #b45309;
        font-size: 0.78rem;
        font-weight: bold;
        margin-bottom: 4px;
      }

      .archive-item-text {
        margin: 0 0 6px;
        color: #334155;
        font-size: 0.86rem;
        line-height: 1.8;
      }

      .archive-item-actions {
        display: flex;
        gap: 8px;
      }

      .archive-item-actions a,
      .archive-item-actions button,
      #inPageArchivePanel .archive-header-actions button {
        border: 1px solid #93c5fd;
        border-radius: 6px;
        background: #eff6ff;
        color: #1d4ed8;
        font: inherit;
        font-size: 0.74rem;
        padding: 4px 8px;
        cursor: pointer;
        text-decoration: none;
      }

      .archive-item-actions a:hover,
      .archive-item-actions button:hover,
      #inPageArchivePanel .archive-header-actions button:hover {
        background: #dbeafe;
      }

      .archive-empty {
        padding: 26px 16px;
        color: #64748b;
        text-align: center;
        font-size: 0.86rem;
      }
    `;

    document.head.appendChild(style);

    reserveScrollOffsetForStickyBox();
    window.addEventListener("resize", reserveScrollOffsetForStickyBox);
  }

  function reserveScrollOffsetForStickyBox() {
    if (!searchBoxElement) {
      return;
    }

    const boxHeight = searchBoxElement.offsetHeight;
    let totalHeight = boxHeight;

    if (resultsPanelElement) {
      // Has no effect when the panel is position:static (mobile),
      // but keeps the fixed desktop side panel below the sticky bar
      // instead of hidden behind it.
      resultsPanelElement.style.top = boxHeight + "px";

      if (
        resultsPanelElement.classList.contains("has-results") &&
        getComputedStyle(resultsPanelElement).position !== "fixed"
      ) {
        totalHeight += resultsPanelElement.offsetHeight;
      }
    }

    document.documentElement.style.setProperty(
      "scroll-padding-top",
      totalHeight + "px"
    );
  }

  function isSearchInterface(node) {
    return node.parentElement &&
      (
        node.parentElement.closest("#inPageSearchBox") ||
        node.parentElement.closest("#inPageSearchResults")
      );
  }

  function removeHighlights() {
    document.querySelectorAll("mark.in-page-search-match").forEach(mark => {
      const parent = mark.parentNode;

      parent.replaceChild(
        document.createTextNode(mark.textContent),
        mark
      );

      parent.normalize();
    });

    matches = [];
    currentMatch = -1;
    selectedMatchIndexes.clear();
  }

  function getSearchableTextNodes() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;

          if (
            !parent ||
            ignoredTags.has(parent.tagName) ||
            isSearchInterface(node) ||
            !node.nodeValue.trim()
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    return nodes;
  }

  function wrapRanges(node, ranges) {
    const originalText = node.nodeValue;
    const fragment = document.createDocumentFragment();
    const createdMatches = [];
    let lastIndex = 0;

    ranges.forEach(range => {
      if (range.start > lastIndex) {
        fragment.appendChild(
          document.createTextNode(
            originalText.slice(lastIndex, range.start)
          )
        );
      }

      const mark = document.createElement("mark");
      mark.className = "in-page-search-match";
      mark.textContent = originalText.slice(range.start, range.end);

      fragment.appendChild(mark);
      createdMatches.push(mark);

      lastIndex = range.end;
    });

    if (lastIndex < originalText.length) {
      fragment.appendChild(
        document.createTextNode(originalText.slice(lastIndex))
      );
    }

    node.parentNode.replaceChild(fragment, node);

    return createdMatches;
  }

  function highlightLiteralMatches(query) {
    const normalizedQuery = normalize(query);

    if (!normalizedQuery) {
      return [];
    }

    const patternSource = buildQueryPattern(query);

    if (!patternSource) {
      return [];
    }

    const createdMatches = [];

    getSearchableTextNodes().forEach(node => {
      const originalText = node.nodeValue;
      const normalizedText = normalize(originalText);

      if (!normalizedText.includes(normalizedQuery)) {
        return;
      }

      const pattern = new RegExp(patternSource, "gi");

      if (!pattern.test(originalText)) {
        return;
      }

      pattern.lastIndex = 0;

      const ranges = [];
      let match;

      let firstMatchFound = false;
      while ((match = pattern.exec(originalText)) !== null) {
        if (!firstMatchFound) {
          ranges.push({
            start: match.index,
            end: match.index + match[0].length
          });
          firstMatchFound = true;
          break;
        }
      }

      if (ranges.length > 0) {
        createdMatches.push(...wrapRanges(node, ranges));
      }
    });

    return createdMatches;
  }

  function highlightStemMatches(query) {
    const queryStems = getQueryStems(query);

    if (queryStems.length === 0) {
      return [];
    }

    const createdMatches = [];

    getSearchableTextNodes().forEach(node => {
      const originalText = node.nodeValue;
      const ranges = [];
      let match;

      WORD_PATTERN.lastIndex = 0;

      let firstMatchFound = false;
      while ((match = WORD_PATTERN.exec(originalText)) !== null) {
        const wordStem = stemWord(match[0]);

        if (wordStem && queryStems.includes(wordStem)) {
          ranges.push({
            start: match.index,
            end: match.index + match[0].length
          });
          firstMatchFound = true;
          break;
        }
      }

      if (ranges.length === 0) {
        return;
      }

      createdMatches.push(...wrapRanges(node, ranges));
    });

    return createdMatches;
  }

  // ---- Item ز: proximity search ---------------------------------------
  // Finds text nodes where every word of the query occurs within
  // `maxDistance` words of each other, in any order - not necessarily
  // forming the exact typed phrase. Highlights the whole span from the
  // first to the last of those words as one match, mirroring the
  // "first match per node" pattern the other two highlighters use.
  function highlightProximityMatches(query, maxDistance) {
    const queryWords = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(normalize)
      .filter(Boolean);

    if (queryWords.length < 2) {
      // Nothing to be "near" another word - fall back to a normal
      // literal search so a single-word query still works as expected.
      return highlightLiteralMatches(query);
    }

    const createdMatches = [];

    getSearchableTextNodes().forEach(node => {
      const originalText = node.nodeValue;

      const tokens = [];
      WORD_PATTERN.lastIndex = 0;

      let match;
      while ((match = WORD_PATTERN.exec(originalText)) !== null) {
        tokens.push({
          normalized: normalize(match[0]),
          start: match.index,
          end: match.index + match[0].length
        });
      }

      if (tokens.length === 0) {
        return;
      }

      let bestSpan = null;

      for (let i = 0; i < tokens.length; i++) {
        const remainingWords = new Set(queryWords);
        let lastTokenIndex = -1;

        for (let j = i; j < tokens.length && j - i <= maxDistance + queryWords.length - 1; j++) {
          if (remainingWords.has(tokens[j].normalized)) {
            remainingWords.delete(tokens[j].normalized);
            lastTokenIndex = j;
          }

          if (remainingWords.size === 0) {
            break;
          }
        }

        if (remainingWords.size === 0) {
          const wordsBetween = lastTokenIndex - i - (queryWords.length - 1);

          if (wordsBetween <= maxDistance) {
            bestSpan = { start: tokens[i].start, end: tokens[lastTokenIndex].end };
            break;
          }
        }
      }

      if (bestSpan) {
        createdMatches.push(...wrapRanges(node, [bestSpan]));
      }
    });

    return createdMatches;
  }

  function highlightMatches(query) {
    if (!query.trim()) {
      return [];
    }

    if (proximitySearchEnabled) {
      return highlightProximityMatches(query, proximityDistance);
    }

    return isRootSearchEnabled() ?
      highlightStemMatches(query) :
      highlightLiteralMatches(query);
  }

  function updateButtons() {
    const previousButton = document.getElementById("inPageSearchPrevious");
    const nextButton = document.getElementById("inPageSearchNext");

    const enabled = matches.length > 0;

    previousButton.disabled = !enabled;
    nextButton.disabled = !enabled;
  }

  // The derivatives row (inline chips of found derivatives) should
  // only take up space when it actually has something to show -
  // otherwise it collapses so it doesn't leave blank space under
  // the search row.
  function updateStatusRowSpacing() {
    const row = document.querySelector(".in-page-status-row");
    const derivatives = document.getElementById("inPageDerivativesBlock");

    if (!row) {
      return;
    }

    const hasContent = !!(derivatives && derivatives.innerHTML.trim());

    row.classList.toggle("has-content", hasContent);
  }

  function updateStatus() {
    const status = document.getElementById("inPageSearchStatus");

    if (!document.getElementById("inPageSearchInput").value.trim()) {
      status.textContent = "";
      updateStatusRowSpacing();
      return;
    }

    if (matches.length === 0) {
      status.textContent = "عبارتی پیدا نشد.";
      updateStatusRowSpacing();
      return;
    }

    status.textContent =
      `نتیجهٔ ${currentMatch + 1} از ${matches.length}`;
    updateStatusRowSpacing();
  }

  // ---- Results panel (Word-style "find" side list) -----------------

  const SNIPPET_BLOCK_TAGS = new Set([
    "P", "LI", "DIV", "TD", "TH", "BLOCKQUOTE",
    "H1", "H2", "H3", "H4", "H5", "H6",
    "DD", "DT", "FIGCAPTION", "SECTION", "ARTICLE"
  ]);

  const SNIPPET_SENTENCE_ENDERS = /[.!?؟۔]/;
  const SNIPPET_MAX_LENGTH = 240;

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function getSnippetContainer(mark) {
    let el = mark.parentElement;

    while (el && el !== document.body) {
      if (SNIPPET_BLOCK_TAGS.has(el.tagName)) {
        return el;
      }

      el = el.parentElement;
    }

    return mark.parentElement || document.body;
  }

  function getTextOffsetBefore(container, node) {
    const range = document.createRange();

    range.selectNodeContents(container);
    range.setEndBefore(node);

    return range.toString().length;
  }

  function getSnippetBounds(mark) {
    const container = getSnippetContainer(mark);
    const rawText = container.textContent;
    const startOffset = getTextOffsetBefore(container, mark);
    const endOffset = startOffset + mark.textContent.length;

    let sentenceStart = startOffset;

    while (
      sentenceStart > 0 &&
      !SNIPPET_SENTENCE_ENDERS.test(rawText[sentenceStart - 1])
    ) {
      sentenceStart--;
    }

    let sentenceEnd = endOffset;

    while (
      sentenceEnd < rawText.length &&
      !SNIPPET_SENTENCE_ENDERS.test(rawText[sentenceEnd - 1])
    ) {
      sentenceEnd++;
    }

    if (sentenceEnd - sentenceStart > SNIPPET_MAX_LENGTH) {
      const half = Math.floor(SNIPPET_MAX_LENGTH / 2);

      sentenceStart = Math.max(sentenceStart, startOffset - half);
      sentenceEnd = Math.min(sentenceEnd, endOffset + half);
    }

    return { rawText, startOffset, endOffset, sentenceStart, sentenceEnd };
  }

  function buildSnippetHtml(mark) {
    const {
      rawText, startOffset, endOffset, sentenceStart, sentenceEnd
    } = getSnippetBounds(mark);

    const before = rawText
      .slice(sentenceStart, startOffset)
      .replace(/\s+/g, " ")
      .trim();

    const matchedText = rawText.slice(startOffset, endOffset);

    const after = rawText
      .slice(endOffset, sentenceEnd)
      .replace(/\s+/g, " ")
      .trim();

    const prefix = sentenceStart > 0 ? "…" : "";
    const suffix = sentenceEnd < rawText.length ? "…" : "";

    return (
      `${prefix}${escapeHtml(before)} ` +
      `<mark>${escapeHtml(matchedText)}</mark> ` +
      `${escapeHtml(after)}${suffix}`
    ).replace(/\s+/g, " ").trim();
  }

  function getSnippetPlainText(mark) {
    const { rawText, sentenceStart, sentenceEnd } = getSnippetBounds(mark);

    const prefix = sentenceStart > 0 ? "…" : "";
    const suffix = sentenceEnd < rawText.length ? "…" : "";

    return (
      prefix +
      rawText.slice(sentenceStart, sentenceEnd).replace(/\s+/g, " ").trim() +
      suffix
    );
  }

  // A bare fragmentText alone doesn't identify WHICH occurrence of that
  // text was selected (the same word can appear many times on the
  // page), so we count occurrences the same way index.htm's
  // nextOccurrenceIndex() does: how many earlier matches (in top-to-
  // bottom `matches` order) share this mark's normalized text,
  // including the mark itself. This mirrors findMatchIndexForFragment's
  // counting further down so the two sides agree on numbering.
  function computeMatchOccurrenceIndex(mark) {
    const targetText = getMatchFragmentText(mark);
    let count = 0;

    for (let i = 0; i < matches.length; i++) {
      if (getMatchFragmentText(matches[i]) === targetText) {
        count++;

        if (matches[i] === mark) {
          return count;
        }
      }
    }

    return count > 0 ? count : 1;
  }

  // Item 3: builds a direct link back to a specific match - a
  // URL to this page with a browser text-fragment (#:~:text=...) for
  // browsers that support native jump/highlight, PLUS "q"/"root"/
  // "frag"/"occ" query params (mirroring index.htm's buildResultUrl) so
  // that on a fresh load applyIncomingQueryFromUrl() actually runs the
  // search and then calls showMatch() on the exact occurrence that was
  // selected. Without "q" that function bails out immediately, and
  // without "frag"/"occ" the browser's own native text-fragment
  // handling always jumps to the FIRST occurrence of the text on the
  // page - not necessarily the one the user picked.
  function buildMatchUrl(mark) {
    const base = location.origin + location.pathname;
    const fragmentText = mark.textContent.trim();

    if (!fragmentText) {
      return base;
    }

    const input = document.getElementById("inPageSearchInput");
    const query = input ? input.value.trim() : "";
    const occurrenceIndex = computeMatchOccurrenceIndex(mark);

    const params = new URLSearchParams({
      q: query,
      frag: fragmentText,
      occ: String(occurrenceIndex)
    });

    if (isRootSearchEnabled()) {
      params.set("root", "1");
    }

    return `${base}?${params.toString()}#:~:text=${encodeURIComponent(fragmentText)}`;
  }

  // ---- Results archive (item 7) -------------------------------------
  // Saved results persist in localStorage under one shared key so
  // items saved from any book page (and from the site-wide search on
  // index.htm, which uses the same key/shape) show up together.
  const ARCHIVE_STORAGE_KEY = "milaniSearchResultsArchive";

  function loadArchive() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ARCHIVE_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveArchive(items) {
    try {
      localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(items));
    } catch (error) {
      // Storage unavailable or full - archive just won't persist.
    }
  }

  function addSelectedToArchive() {
    const selected = [...selectedMatchIndexes]
      .sort((a, b) => a - b)
      .map(index => matches[index])
      .filter(Boolean);

    if (selected.length === 0) {
      return;
    }

    const title = getPageTitle();
    const archive = loadArchive();

    selected.forEach(mark => {
      archive.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: title,
        text: getSnippetPlainText(mark),
        url: buildMatchUrl(mark),
        savedAt: new Date().toISOString()
      });
    });

    saveArchive(archive);
    renderArchivePanel();

    const button = document.getElementById("inPageMenuAddToArchive");

    if (button) {
      const originalHtml = button.innerHTML;
      button.innerHTML = "<span>به آرشیو افزوده شد!</span>";
      setTimeout(() => { button.innerHTML = originalHtml; }, 1500);
    }
  }

  function removeFromArchive(id) {
    saveArchive(loadArchive().filter(item => item.id !== id));
    renderArchivePanel();
  }

  function clearArchive() {
    saveArchive([]);
    renderArchivePanel();
  }

  function renderArchivePanel() {
    const panel = document.getElementById("inPageArchivePanel");

    if (!panel) {
      return;
    }

    const items = loadArchive().slice().reverse();

    const listHtml = items.length === 0 ?
      `<p class="archive-empty">هنوز نتیجه‌ای در آرشیو ذخیره نشده است.</p>` :
      items.map(item => `
        <div class="archive-item">
          <div class="archive-item-title">${escapeHtml(item.title || "")}</div>
          <p class="archive-item-text">"${escapeHtml(item.text || "")}"</p>
          <div class="archive-item-actions">
            <a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener">
              بازکردن
            </a>
            <button type="button" data-archive-id="${escapeHtml(item.id)}">
              حذف
            </button>
          </div>
        </div>
      `).join("");

    panel.innerHTML = `
      <div class="archive-header">
        <span>آرشیو نتایج (${items.length})</span>
        <div class="archive-header-actions">
          <button type="button" id="inPageArchiveClear">پاک‌کردن همه</button>
          <button type="button" id="inPageArchiveClose">بستن</button>
        </div>
      </div>
      ${listHtml}
    `;

    const clearButton = panel.querySelector("#inPageArchiveClear");
    if (clearButton) {
      clearButton.addEventListener("click", clearArchive);
    }

    const closeButton = panel.querySelector("#inPageArchiveClose");
    if (closeButton) {
      closeButton.addEventListener("click", closeArchivePanel);
    }

    panel.querySelectorAll("[data-archive-id]").forEach(button => {
      button.addEventListener("click", () => {
        removeFromArchive(button.dataset.archiveId);
      });
    });
  }

  function openArchivePanel() {
    renderArchivePanel();
    archiveOverlayElement.classList.add("open");
  }

  function closeArchivePanel() {
    archiveOverlayElement.classList.remove("open");
  }

  // ---- Item 4-الف: direct file export ---------------------------------
  // Reuses the exact same header + numbered-snippet text that
  // handleCopySelectedMatches builds for the clipboard, so the
  // downloaded file and the pasted text always agree.
  function buildExportPlainText(selected) {
    const pageTitle = getPageTitle();
    const divider = "─".repeat(32);
    const header = `📘 عنوان: ${pageTitle}\n${divider}`;

    const body = selected
      .map((mark, index) => {
        const snippet = getSnippetPlainText(mark);
        const url = buildMatchUrl(mark);
        return `${index + 1}. «${snippet}»\n   🔗 لینک منبع: ${url}`;
      })
      .join("\n\n");

    return `${header}\n\n${body}`;
  }

  function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getSelectedMatchesInOrder() {
    return [...selectedMatchIndexes]
      .sort((a, b) => a - b)
      .map(index => matches[index])
      .filter(Boolean);
  }

  function exportSelectedAsText() {
    const selected = getSelectedMatchesInOrder();

    if (selected.length === 0) {
      return;
    }

    const text = buildExportPlainText(selected);
    downloadTextFile(`${getPageTitle() || "نتایج-جستجو"}.txt`, text);
  }

  // No PDF library is loaded (avoids an external CDN dependency for a
  // single feature) - instead this opens a nicely-styled, print-ready
  // page in a new tab and triggers the browser's own print dialog,
  // where "Save as PDF" produces a real PDF using the browser's
  // built-in engine.
  function exportSelectedAsPdf() {
    const selected = getSelectedMatchesInOrder();

    if (selected.length === 0) {
      return;
    }

    const pageTitle = escapeHtml(getPageTitle());

    const itemsHtml = selected
      .map((mark, index) => {
        const snippet = escapeHtml(getSnippetPlainText(mark));
        const url = escapeHtml(buildMatchUrl(mark));

        return `
          <div class="export-item">
            <p class="export-snippet"><strong>${index + 1}.</strong>&nbsp;«${snippet}»</p>
            <p class="export-link">🔗 <a href="${url}">لینک منبع</a></p>
          </div>
        `;
      })
      .join("");

    const doc = `<!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
        <meta charset="utf-8">
        <title>${pageTitle}</title>
        <style>
          body {
            font-family: Tahoma, Arial, sans-serif;
            direction: rtl;
            text-align: right;
            color: #1f2937;
            margin: 24px;
          }
          .export-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 16px;
            margin-bottom: 18px;
            background: #eff6ff;
            border-right: 5px solid #2563eb;
            border-radius: 6px;
            font-size: 18px;
            font-weight: bold;
            color: #173b63;
          }
          .export-item {
            padding: 10px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .export-snippet {
            margin: 0 0 4px;
            font-size: 15px;
            line-height: 2;
          }
          .export-link {
            margin: 0;
            font-size: 12px;
          }
          .export-link a {
            color: #1d4ed8;
            text-decoration: none;
          }
          @media print {
            body { margin: 10mm; }
          }
        </style>
      </head>
      <body>
        <div class="export-header">📘 ${pageTitle}</div>
        ${itemsHtml}
        <script>window.onload = () => window.print();<\/script>
      </body>
      </html>`;

    const printWindow = window.open("", "_blank");

    if (!printWindow) {
      return;
    }

    printWindow.document.open();
    printWindow.document.write(doc);
    printWindow.document.close();
  }

  // ---- Item 3/4: the ⚙️ settings menu ---------------------------------
  // Everything that used to be spread across the results-panel header
  // buttons plus the new item-4 tools now lives in one place, opened
  // from the gear icon next to "مشاهده مشتقات" in the main bar.
  function renderSettingsMenu() {
    const menu = document.getElementById("inPageSettingsMenu");

    if (!menu) {
      return;
    }

    const selectedCount = selectedMatchIndexes.size;
    const hasMatches = matches.length > 0;
    const hasSelection = selectedCount > 0;

    menu.innerHTML = `
      <button type="button" class="in-page-settings-item" id="inPageMenuSelectAll" ${hasMatches ? "" : "disabled"}>
        <span>انتخاب همه</span>
      </button>
      <button type="button" class="in-page-settings-item" id="inPageMenuClearSelection" ${hasSelection ? "" : "disabled"}>
        <span>حذف انتخاب</span>
      </button>
      <button type="button" class="in-page-settings-item" id="inPageMenuRemoveSelected" ${hasSelection ? "" : "disabled"}>
        <span>حذف موارد انتخاب‌شده</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>

      <div class="in-page-settings-separator"></div>

      <button type="button" class="in-page-settings-item" id="inPageMenuOpenArchive">
        <span>آرشیو</span>
      </button>
      <button type="button" class="in-page-settings-item" id="inPageMenuAddToArchive" ${hasSelection ? "" : "disabled"}>
        <span>افزودن به آرشیو</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>

      <div class="in-page-settings-separator"></div>

      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuCopySelected"
        title="با پیست‌کردن، لینک منبع هم همراه متن اضافه می‌شود"
        ${hasSelection ? "" : "disabled"}>
        <span>کپی موارد انتخاب‌شده</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>
      <button type="button" class="in-page-settings-item" id="inPageMenuExportText" ${hasSelection ? "" : "disabled"}>
        <span>دریافت به‌صورت متن</span>
      </button>
      <button type="button" class="in-page-settings-item" id="inPageMenuExportPdf" ${hasSelection ? "" : "disabled"}>
        <span>دریافت به‌صورت PDF</span>
      </button>

      <div class="in-page-settings-separator"></div>

      <div class="in-page-settings-section-label">مرتب‌سازی نتایج</div>
      <label class="in-page-settings-radio">
        <input type="radio" name="inPageSortMode" value="position" ${resultsSortMode === "position" ? "checked" : ""}>
        بر اساس محل وقوع
      </label>
      <label class="in-page-settings-radio">
        <input type="radio" name="inPageSortMode" value="frequency" ${resultsSortMode === "frequency" ? "checked" : ""}>
        پرتکرارترین
      </label>

      <div class="in-page-settings-separator"></div>

      <div class="in-page-settings-section-label">جست‌وجوی پیشرفته</div>
      <label class="in-page-settings-checkbox">
        <input type="checkbox" id="inPageMenuProximityToggle" ${proximitySearchEnabled ? "checked" : ""}>
        جست‌وجوی مجاورتی (حداکثر فاصله:
        <input
          type="number"
          id="inPageMenuProximityDistance"
          class="in-page-settings-proximity-distance"
          min="1"
          max="30"
          value="${proximityDistance}">
        کلمه)
      </label>
    `;

    const bind = (id, handler) => {
      const el = menu.querySelector(`#${id}`);
      if (el) el.addEventListener("click", handler);
    };

    bind("inPageMenuSelectAll", () => {
      selectAllVisibleMatches();
      closeSettingsMenu();
    });
    bind("inPageMenuClearSelection", () => {
      clearMatchSelection();
      closeSettingsMenu();
    });
    bind("inPageMenuRemoveSelected", () => {
      removeSelectedMatches();
      closeSettingsMenu();
    });
    bind("inPageMenuOpenArchive", () => {
      openArchivePanel();
      closeSettingsMenu();
    });
    bind("inPageMenuAddToArchive", () => {
      addSelectedToArchive();
    });
    bind("inPageMenuCopySelected", () => {
      handleCopySelectedMatches();
    });
    bind("inPageMenuExportText", () => {
      exportSelectedAsText();
      closeSettingsMenu();
    });
    bind("inPageMenuExportPdf", () => {
      exportSelectedAsPdf();
      closeSettingsMenu();
    });

    menu.querySelectorAll('input[name="inPageSortMode"]').forEach(radio => {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          resultsSortMode = radio.value;
          renderResultsPanel();
        }
      });
    });

    const proximityToggle = menu.querySelector("#inPageMenuProximityToggle");
    const proximityDistanceInput = menu.querySelector("#inPageMenuProximityDistance");

    if (proximityToggle) {
      proximityToggle.addEventListener("change", () => {
        proximitySearchEnabled = proximityToggle.checked;

        const input = document.getElementById("inPageSearchInput");
        if (input && input.value.trim()) {
          performSearch();
        }
      });
    }

    if (proximityDistanceInput) {
      proximityDistanceInput.addEventListener("click", event => {
        event.stopPropagation();
      });

      proximityDistanceInput.addEventListener("change", () => {
        const parsed = parseInt(proximityDistanceInput.value, 10);
        proximityDistance = Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
        proximityDistanceInput.value = proximityDistance;

        const input = document.getElementById("inPageSearchInput");
        if (proximitySearchEnabled && input && input.value.trim()) {
          performSearch();
        }
      });
    }

    // Content just got rebuilt (badges/rows can appear or disappear),
    // so if the menu is currently open, re-measure and reposition it
    // rather than leaving a stale max-height/direction in place.
    if (menu.classList.contains("is-open")) {
      positionSettingsMenu();
    }
  }

  // Recomputed every time the menu is open and the viewport/scroll
  // position might have changed, so the menu always fits the real
  // space around the gear button instead of a fixed 70vh guess.
  let settingsMenuReflowHandler = null;

  function positionSettingsMenu() {
    const menu = document.getElementById("inPageSettingsMenu");
    const gear = document.getElementById("inPageSettingsGear");

    if (!menu || !gear || !menu.classList.contains("is-open")) {
      return;
    }

    const GAP = 6; // matches the old "100% + 6px" offset
    const EDGE_MARGIN = 8; // breathing room from the viewport edge
    const MIN_USABLE = 200; // below this, "below" counts as not enough room

    const gearRect = gear.getBoundingClientRect();
    const spaceBelow = window.innerHeight - gearRect.bottom - GAP - EDGE_MARGIN;
    const spaceAbove = gearRect.top - GAP - EDGE_MARGIN;

    // Default to opening downward. Only flip upward when there isn't
    // reasonable room below AND opening upward would actually give
    // more room.
    const openUpward = spaceBelow < MIN_USABLE && spaceAbove > spaceBelow;

    // Since the menu is position:fixed, its coordinates are relative
    // to the viewport, not to the gear's own offset parent, so they
    // have to be set explicitly here rather than via a CSS anchor.
    menu.style.left = gearRect.left + "px";

    if (openUpward) {
      menu.style.top = "auto";
      menu.style.bottom = (window.innerHeight - gearRect.top + GAP) + "px";
    } else {
      menu.style.top = (gearRect.bottom + GAP) + "px";
      menu.style.bottom = "auto";
    }

    // Set max-height to the real space on the side the menu opens
    // toward — never a fixed percentage of the viewport. This is a
    // ceiling only: overflow-y:auto means the menu still shrinks to
    // fit its actual content whenever that's shorter than this, so
    // it never adds artificial scrolling on a normal-size screen.
    const available = Math.max(openUpward ? spaceAbove : spaceBelow, MIN_USABLE);
    menu.style.maxHeight = available + "px";
  }


  function openSettingsMenu() {
    const menu = document.getElementById("inPageSettingsMenu");
    const gear = document.getElementById("inPageSettingsGear");

    if (!menu) {
      return;
    }

    renderSettingsMenu();
    menu.classList.add("is-open");
    positionSettingsMenu();

    if (gear) {
      gear.setAttribute("aria-expanded", "true");
    }

    if (!settingsMenuReflowHandler) {
      settingsMenuReflowHandler = () => positionSettingsMenu();
      window.addEventListener("resize", settingsMenuReflowHandler);
      window.addEventListener("scroll", settingsMenuReflowHandler, true);
    }
  }

  function closeSettingsMenu() {
    const menu = document.getElementById("inPageSettingsMenu");
    const gear = document.getElementById("inPageSettingsGear");

    if (menu) {
      menu.classList.remove("is-open");
      menu.style.maxHeight = "";
      menu.style.left = "";
      menu.style.top = "";
      menu.style.bottom = "";
    }

    if (gear) {
      gear.setAttribute("aria-expanded", "false");
    }

    if (settingsMenuReflowHandler) {
      window.removeEventListener("resize", settingsMenuReflowHandler);
      window.removeEventListener("scroll", settingsMenuReflowHandler, true);
      settingsMenuReflowHandler = null;
    }
  }

  function toggleSettingsMenu() {
    const menu = document.getElementById("inPageSettingsMenu");

    if (menu && menu.classList.contains("is-open")) {
      closeSettingsMenu();
    } else {
      openSettingsMenu();
    }
  }

  // ---- Derivative keys (visual grouping, item 2/3) ------------------
  // Two surface forms that look identical to the reader must be one
  // entry in the derivatives block, even if they differ technically
  // (e.g. with/without a diacritic). So the grouping key strips
  // diacritics, ZWNJ/ZWJ, and normalises letter variants.
  const VISUAL_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
  const VISUAL_INVISIBLE = /[\u200C-\u200F]/g;

  function getVisualWordKey(word) {
    return (word || "")
      .replace(VISUAL_DIACRITICS, "")
      .replace(VISUAL_INVISIBLE, "")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[ۀة]/g, "ه")
      .replace(/[أإآ]/g, "ا")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ی")
      .toLowerCase()
      .trim();
  }

  function getVisualWordLabel(word) {
    return (word || "")
      .replace(VISUAL_DIACRITICS, "")
      .replace(VISUAL_INVISIBLE, "")
      .trim();
  }

  function getMatchVisualKey(mark) {
    return getVisualWordKey(mark.textContent);
  }

  function isMatchVisible(index) {
    if (!isRootSearchEnabled() || activeDerivativeKeys.size === 0) {
      return true;
    }

    const mark = matches[index];
    return mark ? activeDerivativeKeys.has(getMatchVisualKey(mark)) : false;
  }

  function renderDerivativesBlock() {
    const block = document.getElementById("inPageDerivativesBlock");

    if (!block) {
      return;
    }

    if (!isRootSearchEnabled() || !isDerivativesViewEnabled() || matches.length === 0) {
      block.innerHTML = "";
      block.classList.remove("is-visible");
      updateStatusRowSpacing();
      return;
    }

    const grouped = new Map();

    matches.forEach(mark => {
      const key = getMatchVisualKey(mark);

      if (!key) {
        return;
      }

      if (!grouped.has(key)) {
        grouped.set(key, {
          key: key,
          label: getVisualWordLabel(mark.textContent),
          count: 0
        });
      }

      grouped.get(key).count += 1;
    });

    if (grouped.size === 0) {
      block.innerHTML = "";
      block.classList.remove("is-visible");
      updateStatusRowSpacing();
      return;
    }

    const derivatives = [...grouped.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "fa")
    );

    block.innerHTML =
      `<span class="in-page-derivatives-inline-label">مشتقات یافت‌شده (${derivatives.length}):</span>` +
      derivatives.map(d => {
        const active = activeDerivativeKeys.has(d.key) ? " is-active" : "";
        return (
          `<span class="in-page-derivatives-item${active}" data-deriv-key="${escapeHtml(d.key)}" role="button" tabindex="0">` +
            `${escapeHtml(d.label)} <span class="deriv-count">(${d.count})</span>` +
          `</span>`
        );
      }).join("");

    block.classList.add("is-visible");
    updateStatusRowSpacing();

    block.querySelectorAll(".in-page-derivatives-item").forEach(item => {
      const toggle = () => {
        const key = item.dataset.derivKey;

        if (activeDerivativeKeys.has(key)) {
          activeDerivativeKeys.delete(key);
        } else {
          activeDerivativeKeys.add(key);
        }

        renderDerivativesBlock();
        renderResultsPanel();
      };

      item.addEventListener("click", toggle);
      item.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
  }

  // Item ب: frequency counts per visual surface-form, reused from the
  // same grouping the derivatives block already computes (see
  // getMatchVisualKey). Kept separate from that block so "پرتکرارترین"
  // sorting works even when root search / the derivatives view is off.
  function getMatchFrequencyCounts() {
    const counts = new Map();

    matches.forEach(mark => {
      const key = getMatchVisualKey(mark);

      if (!key) {
        return;
      }

      counts.set(key, (counts.get(key) || 0) + 1);
    });

    return counts;
  }

  function sortVisibleMatches(visibleMatches) {
    if (resultsSortMode !== "frequency") {
      return visibleMatches;
    }

    const counts = getMatchFrequencyCounts();

    return visibleMatches
      .slice()
      .sort((a, b) => {
        const freqA = counts.get(getMatchVisualKey(a.mark)) || 0;
        const freqB = counts.get(getMatchVisualKey(b.mark)) || 0;

        if (freqB !== freqA) {
          return freqB - freqA;
        }

        return a.index - b.index;
      });
  }

  function selectAllVisibleMatches() {
    matches.forEach((mark, index) => {
      if (isMatchVisible(index)) {
        selectedMatchIndexes.add(index);
      }
    });
    renderResultsPanel();
  }

  function clearMatchSelection() {
    selectedMatchIndexes.clear();
    renderResultsPanel();
  }

  function renderResultsPanel() {
    if (!resultsPanelElement) {
      return;
    }

    if (matches.length === 0) {
      resultsPanelElement.innerHTML = "";
      resultsPanelElement.classList.remove("has-results");
      document.body.classList.remove("in-page-search-results-open");
      selectedMatchIndexes.clear();
      renderDerivativesBlock();
      renderSettingsMenu();
      reserveScrollOffsetForStickyBox();
      return;
    }

    const visibleMatches = sortVisibleMatches(
      matches
        .map((mark, index) => ({ mark, index }))
        .filter(item => isMatchVisible(item.index))
    );

    // Item 5: each result shows its ordinal position among the
    // document's matches (index + 1), independent of the current
    // sort/filter, so a reader can always tell "این نتیجهٔ چندم است"
    // regardless of how the list is currently ordered.
    const items = visibleMatches
      .map(({ mark, index }) => {
        const snippetHtml = buildSnippetHtml(mark);
        const activeClass = index === currentMatch ? " active" : "";
        const checkedAttr = selectedMatchIndexes.has(index) ? "checked" : "";

        return (
          `<div class="in-page-search-result-item${activeClass}" data-index="${index}">` +
            `<span class="in-page-result-number">${index + 1}</span>` +
            `<input type="checkbox" class="in-page-result-checkbox" data-index="${index}" ${checkedAttr} aria-label="انتخاب این نتیجه">` +
            `<button type="button" class="in-page-search-result-jump" data-index="${index}">` +
              snippetHtml +
            `</button>` +
          `</div>`
        );
      })
      .join("");

    const filteredNote = activeDerivativeKeys.size > 0
      ? ` (${visibleMatches.length} از ${matches.length})`
      : "";

    // Item 3: this header used to carry six action buttons - now it's
    // just the count and a close button; every action lives in the
    // ⚙️ menu in the main top bar instead (see renderSettingsMenu).
    resultsPanelElement.innerHTML = `
      <div class="in-page-search-results-header">
        <span>${matches.length} نتیجه${filteredNote}</span>
        <button type="button" class="in-page-search-results-close" aria-label="بستن فهرست نتایج">×</button>
      </div>
      ${items}
    `;

    resultsPanelElement.classList.add("has-results");
    document.body.classList.add("in-page-search-results-open");

    resultsPanelElement
      .querySelectorAll(".in-page-search-result-jump")
      .forEach(button => {
        button.addEventListener("click", () => {
          showMatch(parseInt(button.dataset.index, 10));
        });
      });

    resultsPanelElement
      .querySelectorAll(".in-page-result-checkbox")
      .forEach(checkbox => {
        checkbox.addEventListener("change", () => {
          const index = parseInt(checkbox.dataset.index, 10);

          if (checkbox.checked) {
            selectedMatchIndexes.add(index);
          } else {
            selectedMatchIndexes.delete(index);
          }

          updateCopySelectedButton();
        });
      });

    const closeButton = resultsPanelElement.querySelector(
      ".in-page-search-results-close"
    );

    if (closeButton) {
      closeButton.addEventListener("click", () => {
        resultsPanelElement.classList.remove("has-results");
        document.body.classList.remove("in-page-search-results-open");
        reserveScrollOffsetForStickyBox();
      });
    }

    updateCopySelectedButton();
    renderSettingsMenu();
    reserveScrollOffsetForStickyBox();
  }

  function removeSelectedMatches() {
    const indexes = [...selectedMatchIndexes].sort((a, b) => a - b);

    if (indexes.length === 0) {
      return;
    }

    indexes.forEach(index => {
      const mark = matches[index];

      if (!mark || !mark.parentNode) {
        return;
      }

      const parent = mark.parentNode;
      parent.replaceChild(
        document.createTextNode(mark.textContent),
        mark
      );
      parent.normalize();
    });

    matches = Array.from(
      document.querySelectorAll("mark.in-page-search-match")
    );

    currentMatch = matches.length > 0 ? 0 : -1;

    if (matches[0]) {
      matches[0].classList.add("current-match");
    }

    selectedMatchIndexes.clear();

    if (isRootSearchEnabled()) {
      renderDerivativesBlock();
    }

    renderResultsPanel();
    updateButtons();
    updateStatus();
  }

  // Item 3: the per-item enable/disable + counters that used to live
  // on the results-panel header buttons now apply to the ⚙️ menu
  // items instead, so any change in selection just repaints that
  // menu rather than the whole results list.
  function updateCopySelectedButton() {
    renderSettingsMenu();
  }

  async function handleCopySelectedMatches() {
    const button = document.getElementById("inPageMenuCopySelected");

    const selected = [...selectedMatchIndexes]
      .sort((a, b) => a - b)
      .map(index => matches[index])
      .filter(Boolean);

    if (selected.length === 0) {
      return;
    }

    // Item 2: the file's own title is shown once, in a clearly
    // separated header line, rather than repeated per snippet (all
    // selected matches necessarily come from this same page).
    // Item 3: each snippet gets its own reference link right under
    // it, so a pasted result can be traced back to its exact spot.
    // The link itself is kept short and clickable: in plain-text
    // targets the raw URL still appears (there's no way around that
    // in plain text), but anywhere rich/HTML paste is supported, it
    // collapses to a short "لینک منبع" hyperlink instead.
    // Item 4: the header used to be the title sandwiched between two
    // triple-dash runs ("——— عنوان: X ———"), which just reads as
    // stray punctuation once pasted. Plain text gets a book icon plus
    // a full-width divider line instead; rich/HTML targets (Word,
    // Gmail, ...) get an actual colored, bordered header block - a
    // <table> cell rather than a styled <div>, since Word's paste
    // filter keeps table backgrounds/borders far more reliably than
    // div/box CSS.
    const pageTitle = getPageTitle();
    const divider = "─".repeat(32);
    const header = `📘 عنوان: ${pageTitle}\n${divider}`;

    const textBody = selected
      .map((mark, index) => {
        const snippet = getSnippetPlainText(mark);
        const url = buildMatchUrl(mark);
        return `${index + 1}. «${snippet}»\n   🔗 لینک منبع: ${url}`;
      })
      .join("\n\n");

    const text = `${header}\n\n${textBody}`;

    // Item 2: Word only gets the bidi ordering of the quotes/numbers
    // right when the paragraph's own direction is LTR (its paste
    // filter decides run order from the paragraph mark, not from the
    // Unicode bidi algorithm the way Telegram's renderer does) - so
    // every paragraph below carries dir="ltr" explicitly, while
    // text-align:right keeps it visually right-aligned everywhere,
    // Telegram included, since the actual text runs are still RTL
    // Persian/Arabic and lay out right-to-left regardless of the
    // container's dir. Please double-check both destinations after
    // this change - Word's HTML-paste bidi handling is notoriously
    // inconsistent across versions.
    const htmlBody = selected
      .map((mark, index) => {
        const snippet = escapeHtml(getSnippetPlainText(mark));
        const url = escapeHtml(buildMatchUrl(mark));
        return (
          `<p dir="ltr" style="margin:0 0 3px;font-family:Tahoma,Arial,sans-serif;` +
          `font-size:14px;line-height:1.9;color:#1f2937;text-align:right;">` +
          `<strong>${index + 1}.</strong>\u00a0«${snippet}»</p>` +
          `<p dir="ltr" style="margin:0 0 14px;font-family:Tahoma,Arial,sans-serif;` +
          `font-size:12px;text-align:right;">🔗 ` +
          `<a href="${url}" style="color:#1d4ed8;text-decoration:none;">` +
          `لینک منبع</a></p>`
        );
      })
      .join("");

    const html =
      `<table dir="ltr" role="presentation" style="width:100%;border-collapse:collapse;` +
      `margin:0 0 12px;"><tr><td style="padding:9px 14px;background:#eff6ff;` +
      `border-right:4px solid #2563eb;font-family:Tahoma,Arial,sans-serif;` +
      `font-size:14px;font-weight:bold;color:#173b63;text-align:right;">` +
      `📘\u00a0${escapeHtml(pageTitle)}</td></tr></table>` +
      htmlBody;

    const ok = await copyRichTextToClipboard(text, html);

    if (button) {
      button.innerHTML = `<span>${ok ? "کپی شد!" : "خطا در کپی"}</span>`;
      setTimeout(updateCopySelectedButton, 1500);
    }
  }

  function updateResultsPanelActiveState() {
    if (!resultsPanelElement) {
      return;
    }

    resultsPanelElement
      .querySelectorAll(".in-page-search-result-item")
      .forEach((item, index) => {
        item.classList.toggle("active", index === currentMatch);
      });

    const activeItem = resultsPanelElement.querySelector(
      ".in-page-search-result-item.active"
    );

    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function showMatch(index) {
    if (matches.length === 0) {
      return;
    }

    const selected = matches[index];
    if (!selected || !document.contains(selected)) {
      return;
    }

    matches.forEach(match => {
      match.classList.remove("current-match");
    });

    currentMatch = index;
    selected.classList.add("current-match");

    selected.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });

    updateResultsPanelActiveState();
    updateStatus();
  }

  // ---- Voice input (item 1) ------------------------------------------
  // Mirrors the site-wide search's voice-typing button (index.htm) so
  // the same "speak your query" option exists in this file's own
  // in-page search box, not just on the main search page.
  let inPageVoiceRecognition = null;

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function toggleInPageVoiceInput() {
    const Ctor = getSpeechRecognitionCtor();
    const button = document.getElementById("inPageVoiceInput");
    const input = document.getElementById("inPageSearchInput");

    if (!Ctor) {
      if (button) {
        button.title = "پشتیبانی نمی‌شود";
        button.setAttribute("aria-label", "جست‌وجوی صوتی - پشتیبانی نمی‌شود");
      }
      return;
    }

    if (inPageVoiceRecognition) {
      inPageVoiceRecognition.stop();
      return;
    }

    inPageVoiceRecognition = new Ctor();
    inPageVoiceRecognition.lang = "fa-IR";
    inPageVoiceRecognition.interimResults = false;
    inPageVoiceRecognition.maxAlternatives = 1;

    inPageVoiceRecognition.addEventListener("start", () => {
      if (button) {
        button.classList.add("is-listening");
        button.title = "در حال شنیدن…";
        button.setAttribute("aria-label", "در حال شنیدن…");
      }
    });

    inPageVoiceRecognition.addEventListener("result", event => {
      const transcript = event.results[0][0].transcript;
      input.value = transcript;
      performSearch();
      pushSearchHistory(transcript);
      closeSearchHistoryDropdown();
    });

    inPageVoiceRecognition.addEventListener("end", () => {
      if (button) {
        button.classList.remove("is-listening");
        button.title = "جست‌وجوی صوتی";
        button.setAttribute("aria-label", "جست‌وجوی صوتی");
      }
      inPageVoiceRecognition = null;
    });

    inPageVoiceRecognition.start();
  }

  function performSearch() {
    const input = document.getElementById("inPageSearchInput");
    const query = input.value.trim();

    activeDerivativeKeys.clear();
    removeHighlights();

    if (!query) {
      updateButtons();
      updateStatus();
      renderResultsPanel();
      return;
    }

    matches = highlightMatches(query);
    renderResultsPanel();
    renderDerivativesBlock();

    if (matches.length > 0) {
      showMatch(0);
    } else {
      updateStatus();
    }

    updateButtons();
  }

  function clearSearch() {
    const input = document.getElementById("inPageSearchInput");

    input.value = "";
    activeDerivativeKeys.clear();
    removeHighlights();
    updateButtons();
    updateStatus();
    renderResultsPanel();
    openSearchHistoryDropdown();
  }

  // Item 3: "رفتن به عبارت یافت‌شده" on the main site search links here
  // with a target string identifying ONE specific occurrence: the bare
  // matched text, exactly as built by index.htm's buildFragmentText.
  // getMatchFragmentText() below rebuilds that same bare string for
  // each highlighted match here, so the one the link actually pointed
  // at can be found and jumped to.
  //
  // That target string is read from the "frag" query-string param,
  // NOT from the "#:~:text=" hash. Chrome/Edge strip the text-fragment
  // directive out of the URL before a destination page's own scripts
  // run (it's consumed internally for the browser's native jump/
  // highlight, then removed via history.replaceState), so
  // location.hash never actually contains it by the time this script
  // runs - reading it from there always missed and silently fell back
  // to match #1. The query-string copy survives navigation intact.
  // The old hash-based read is kept as a fallback for browsers that
  // don't implement text fragments (and so never strip the hash).
  function getTextFragmentFromHash() {
    const fromQuery = new URLSearchParams(location.search).get("frag");

    if (fromQuery) {
      return fromQuery;
    }

    const marker = "#:~:text=";
    const hash = location.hash || "";
    const index = hash.indexOf(marker);

    if (index === -1) {
      return null;
    }

    const raw = hash.slice(index + marker.length);

    try {
      return decodeURIComponent(raw);
    } catch (error) {
      return raw;
    }
  }

  function getMatchFragmentText(mark) {
    // Must mirror index.htm's buildFragmentText exactly: that function
    // sends ONLY the matched text (no trailing words) as the "frag"
    // param, so this side has to build the same bare string or the
    // comparison in findMatchIndexForFragment never lines up and the
    // link silently falls back to match #1.
    const matchText = mark.textContent.replace(/\s+/g, " ").trim();

    return normalize(matchText);
  }

  // The bare fragmentText alone is often NOT unique: if a search word
  // appears in several different paragraphs of the same book, every one
  // of those results shares the exact same fragmentText (just the word
  // itself), so text-matching alone can't tell them apart - it always
  // finds whichever occurrence comes first in the document. index.htm
  // also sends a 1-based "occ" query param: how many times this exact
  // fragmentText had already appeared earlier in the document, counted
  // in the same top-to-bottom order this page's own `matches` array is
  // built in. Using it here picks out the SAME occurrence the result
  // link actually pointed at.
  function getOccurrenceFromUrl() {
    const raw = new URLSearchParams(location.search).get("occ");
    const parsed = parseInt(raw, 10);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  function findMatchIndexForFragment(fragmentText, occurrenceIndex) {
    if (!fragmentText) {
      return -1;
    }

    const normalizedFragment = normalize(fragmentText);
    const wantedOccurrence = occurrenceIndex > 0 ? occurrenceIndex : 1;
    let seen = 0;

    for (let i = 0; i < matches.length; i++) {
      if (getMatchFragmentText(matches[i]) === normalizedFragment) {
        seen++;

        if (seen === wantedOccurrence) {
          return i;
        }
      }
    }

    // Fewer matching occurrences here than the "occ" the link expected
    // (page content drifted, etc.) - fall back to the last one found
    // rather than missing entirely.
    return seen > 0 ? matches.findIndex(
      mark => getMatchFragmentText(mark) === normalizedFragment
    ) : -1;
  }

  function applyIncomingQueryFromUrl() {
    const params = new URLSearchParams(location.search);
    const incomingQuery = params.get("q");

    if (!incomingQuery) {
      return;
    }

    const input = document.getElementById("inPageSearchInput");
    const rootToggle = document.getElementById("inPageSearchRoot");

    if (!input) {
      return;
    }

    input.value = incomingQuery;

    if (rootToggle && params.get("root") === "1") {
      rootToggle.checked = true;
      updateDerivativesToggleVisibility();
    }

    performSearch();

    // Land on the exact occurrence the link pointed at, if it can be
    // found among this file's matches; otherwise leave performSearch's
    // default of match #1.
    const targetIndex = findMatchIndexForFragment(
      getTextFragmentFromHash(),
      getOccurrenceFromUrl()
    );

    if (targetIndex !== -1) {
      // تأخیر کوتاه برای اطمینان از تکمیل رندر و جلوگیری از تداخل با اسکرول مرورگر
      setTimeout(() => showMatch(targetIndex), 0);
    }
  }

  function initialize() {
    // Item 5: make the browser tab (and the window/history entry)
    // show the Persian/Arabic title of this book instead of falling
    // back to the raw URL, which is what a page with no <title> text
    // shows in the tab.
    document.title = getPageTitle();

    createSearchBox();

    const input = document.getElementById("inPageSearchInput");
    const previousButton = document.getElementById("inPageSearchPrevious");
    const nextButton = document.getElementById("inPageSearchNext");

    let searchTimer;

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);

      if (input.value.trim()) {
        closeSearchHistoryDropdown();
      } else {
        openSearchHistoryDropdown();
      }

      searchTimer = setTimeout(performSearch, 250);
    });

    // Item 1: previously-searched words, shown as a real dropdown
    // (last 5, from localStorage) instead of relying on the browser's
    // own single-suggestion autocomplete.
    input.addEventListener("focus", () => {
      cancelScheduledHistoryClose();
      openSearchHistoryDropdown();
    });
    input.addEventListener("mouseenter", () => {
      cancelScheduledHistoryClose();
      openSearchHistoryDropdown();
    });
    input.addEventListener("mouseleave", scheduleHistoryClose);

    // The dropdown itself may be positioned away from the input (see
    // positionSearchHistoryDropdown()), so it needs its own hover
    // tracking too: entering it cancels any pending close from the
    // input's mouseleave, and leaving it re-schedules one.
    const historyDropdown = document.getElementById("inPageSearchHistory");

    if (historyDropdown) {
      historyDropdown.addEventListener("mouseenter", cancelScheduledHistoryClose);
      historyDropdown.addEventListener("mouseleave", scheduleHistoryClose);
    }

    // Item 1 (extended): تا اینجا فقط با زدن Enter در تاریخچه ذخیره
    // می‌شد. اگر کاربر بعد از تایپ، بدون زدن Enter، فقط موس/فوکوس را
    // جای دیگری ببرد (blur)، همان مقدار تایپ‌شده را هم در تاریخچه
    // ذخیره می‌کنیم تا در مراجعه بعدی در لیست «جست‌وجوهای اخیر» دیده
    // شود. عمداً performSearch() را اینجا دوباره صدا نمی‌زنیم: خود آن
    // تابع همیشه با showMatch(0) به نتیجه‌ی اول برمی‌گردد، و اگر بعد
    // از Enter (که به نتیجه‌ی بعدی می‌رود) این رویداد blur هم اجرا شود
    // -مثلاً در موبایل که زدن Enter کیبورد را می‌بندد و خودش باعث blur
    // می‌شود- ناوبری Enter را از بین می‌برد. جست‌وجوی واقعی همان لحظه‌ی
    // تایپ توسط رویداد "input" (با تاخیر ۲۵۰ میلی‌ثانیه) قبلاً انجام
    // شده؛ اینجا فقط تاریخچه را به‌روز می‌کنیم.
    input.addEventListener("blur", () => {
      closeSearchHistoryDropdown();

      if (input.value.trim()) {
        pushSearchHistory(input.value);
      }
    });

    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        closeSearchHistoryDropdown();

        if (input.value.trim()) {
          pushSearchHistory(input.value);
        }

        if (event.shiftKey) {
          showMatch(currentMatch - 1);
        } else {
          showMatch(currentMatch + 1);
        }
      }

      if (event.key === "Escape") {
        closeSearchHistoryDropdown();
        clearSearch();
      }
    });

    previousButton.addEventListener("click", () => {
      showMatch(currentMatch - 1);
    });

    nextButton.addEventListener("click", () => {
      showMatch(currentMatch + 1);
    });

    const voiceButton = document.getElementById("inPageVoiceInput");
    if (voiceButton) {
      voiceButton.addEventListener("click", toggleInPageVoiceInput);
    }

    const rootToggle = document.getElementById("inPageSearchRoot");
    const showDerivativesToggle = document.getElementById("inPageShowDerivatives");

    rootToggle.addEventListener("change", () => {
      activeDerivativeKeys.clear();
      updateDerivativesToggleVisibility();

      if (!rootToggle.checked && showDerivativesToggle) {
        showDerivativesToggle.checked = false;
      }

      if (input.value.trim()) {
        performSearch();
      } else {
        renderResultsPanel();
        renderDerivativesBlock();
      }
    });

    if (showDerivativesToggle) {
      showDerivativesToggle.addEventListener("change", () => {
        if (!showDerivativesToggle.checked) {
          activeDerivativeKeys.clear();
          renderResultsPanel();
        }

        renderDerivativesBlock();
      });
    }

    updateDerivativesToggleVisibility();

    // Item 3: the ⚙️ menu replaces the old standalone "آرشیو" button
    // and the results-panel action-button row.
    const settingsGear = document.getElementById("inPageSettingsGear");

    if (settingsGear) {
      settingsGear.addEventListener("click", event => {
        event.stopPropagation();
        toggleSettingsMenu();
      });
    }

    document.addEventListener("click", event => {
      const menu = document.getElementById("inPageSettingsMenu");
      const gear = document.getElementById("inPageSettingsGear");

      if (
        menu &&
        menu.classList.contains("is-open") &&
        !menu.contains(event.target) &&
        event.target !== gear
      ) {
        closeSettingsMenu();
      }

      const history = document.getElementById("inPageSearchHistory");

      if (
        history &&
        history.classList.contains("is-open") &&
        !history.contains(event.target) &&
        event.target !== input
      ) {
        closeSearchHistoryDropdown();
      }
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeSettingsMenu();
      }
    });

    document.addEventListener("keydown", event => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");

      if (
        (isMac && event.metaKey && event.key.toLowerCase() === "f") ||
        (!isMac && event.ctrlKey && event.key.toLowerCase() === "f")
      ) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });

    applyIncomingQueryFromUrl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
