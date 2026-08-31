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
  let bookmarksOverlayElement = null;
  let selectionBookmarkButtonElement = null;
  let selectionTagPopoverElement = null;
  let bookmarkIndicatorPopoverElement = null;
  const selectedMatchIndexes = new Set();
  const activeDerivativeKeys = new Set();

  // Item ط: bookmarks (free-form tags), on either a live text
  // selection anywhere on the page or a batch of selected search
  // results. "selection" mode stores the exact selected text pending
  // save; "matches" mode saves one bookmark per currently
  // selectedMatchIndexes entry. bookmarkFilterTags narrows the
  // bookmarks panel list to bookmarks carrying ANY of the selected
  // tags (empty set = show all); several tags can be active at once
  // so the user can view a few subgroups side by side.
  let pendingBookmarkMode = null;
  let pendingSelectionText = "";
  const bookmarkFilterTags = new Set();

  // Item ط (نشانگر متن): the small in-text marker rendered right after
  // any already-bookmarked passage on the page (see
  // renderBookmarkIndicators), and the hover/click popover it opens -
  // pendingIndicatorBookmarkId tracks which bookmark that popover is
  // currently showing, and the hover-close timer mirrors the same
  // hover-intent pattern used for the search-history dropdown above.
  let pendingIndicatorBookmarkId = null;
  let bookmarkIndicatorHoverCloseTimer = null;

  // Item ب: results-panel ordering. "position" keeps the original
  // top-to-bottom document order; "frequency" puts the most-repeated
  // surface form first (see getResultsSortComparator).
  let resultsSortMode = "position";

  // Item ز: proximity search state. When enabled, the query's words
  // no longer need to be adjacent - they just need to occur within
  // proximityDistance words of each other (see highlightProximityMatches).
  let proximitySearchEnabled = false;
  let proximityDistance = 5;

  // Item ح: text/footnote search scope. Word's export marks every
  // footnote paragraph with class="MsoFootnoteText" (see div[id^=ftn]
  // blocks at the end of the document body), so that class is what
  // tells a text node apart from the main body. Both start enabled -
  // the default is to search everywhere - and toggling one off never
  // leaves both off (see the checkbox handlers in renderSettingsMenu).
  let searchInMainText = true;
  let searchInFootnotes = true;

  function isFootnoteTextNode(node) {
    return !!(node.parentElement && node.parentElement.closest(".MsoFootnoteText"));
  }

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

  // Item 1 (hover-intent): the dropdown is a few pixels below the
  // input (position:fixed with a small GAP), so a mouse moving from
  // the input straight down onto the dropdown briefly crosses that
  // gap. Closing on the input's mouseleave immediately, or trusting
  // relatedTarget to already point at the dropdown, both fire before
  // the pointer actually lands on it. Instead, leaving the input (or
  // the dropdown) only *schedules* a close a moment later; entering
  // the other one cancels that pending close, so the two elements
  // behave as one continuous hover target and the dropdown never
  // flickers shut while the mouse is still travelling toward it.
  let searchHistoryHoverCloseTimer = null;

  function cancelSearchHistoryHoverClose() {
    if (searchHistoryHoverCloseTimer) {
      clearTimeout(searchHistoryHoverCloseTimer);
      searchHistoryHoverCloseTimer = null;
    }
  }

  function scheduleSearchHistoryHoverClose() {
    cancelSearchHistoryHoverClose();

    searchHistoryHoverCloseTimer = setTimeout(() => {
      searchHistoryHoverCloseTimer = null;

      const input = document.getElementById("inPageSearchInput");

      if (document.activeElement !== input) {
        closeSearchHistoryDropdown();
      }
    }, 200);
  }

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
    cancelSearchHistoryHoverClose();

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

  function closeSearchHistoryDropdown() {
    cancelSearchHistoryHoverClose();

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

        <div class="in-page-search-input-wrap">
          <input
            id="inPageSearchInput"
            name="siteSearch"
            type="search"
            title="کادر جست‌وجو: عبارت مورد نظر را برای یافتن در متن این صفحه اینجا بنویسید"
            placeholder="برای جست‌وجو، کلمه یا عبارت مورد نظر را بنویسید."
            aria-label="جست‌وجو در متن این صفحه"
            autocomplete="off">

          <div id="inPageSearchHistory" class="in-page-search-history"></div>
        </div>

        <button
          id="inPageSearchPrevious"
          type="button"
          disabled
          title="رفتن به نتیجه قبلی"
          aria-label="رفتن به نتیجه قبلی">
          ▶
        </button>

        <button
          id="inPageSearchNext"
          type="button"
          disabled
          title="رفتن به نتیجه بعدی"
          aria-label="رفتن به نتیجه بعدی">
          ◀
        </button>

        <button
          id="inPageVoiceInput"
          type="button"
          class="in-page-voice-input-button"
          title="جست‌وجو با صدا (به‌جای تایپ، عبارت را با میکروفون بگویید)"
          aria-label="جست‌وجوی صوتی">
          🎤
        </button>

        <label
          class="in-page-search-root-label"
          for="inPageSearchRoot"
          title="جست‌وجوی ریشه‌ای: کلمات هم‌خانواده و مشتقات همان ریشه را هم پیدا می‌کند، نه فقط عبارت دقیق تایپ‌شده">
          <input id="inPageSearchRoot" type="checkbox">
          ریشه‌ای
        </label>

        <label
          id="inPageShowDerivativesLabel"
          class="in-page-search-derivatives-toggle-label"
          for="inPageShowDerivatives"
          title="نمایش فهرست کلمات مشتق‌شده‌ای که در جست‌وجوی ریشه‌ای پیدا شده‌اند"
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

    // Item ط: bookmarks panel, same overlay/dialog pattern as the
    // archive above.
    const bookmarksOverlay = document.createElement("div");
    bookmarksOverlay.id = "inPageBookmarksOverlay";
    bookmarksOverlay.innerHTML = `<div id="inPageBookmarksPanel" role="dialog" aria-label="نشانه‌ها"></div>`;
    document.body.insertBefore(bookmarksOverlay, archiveOverlay.nextSibling);
    bookmarksOverlayElement = bookmarksOverlay;

    bookmarksOverlay.addEventListener("click", event => {
      if (event.target === bookmarksOverlay) {
        closeBookmarksPanel();
      }
    });

    // Item ط: the small floating "🔖 نشانه‌گذاری" button that appears
    // near any text the user selects on the page (outside the search
    // UI itself), plus the tag-input popover it opens. Both are
    // position:fixed and repositioned in JS right before they're
    // shown - see showSelectionBookmarkButton/showTagPopoverAt below.
    const selectionBookmarkButton = document.createElement("button");
    selectionBookmarkButton.type = "button";
    selectionBookmarkButton.id = "inPageSelectionBookmarkButton";
    selectionBookmarkButton.className = "in-page-selection-bookmark-button";
    selectionBookmarkButton.textContent = "🔖 نشانه‌گذاری";
    document.body.appendChild(selectionBookmarkButton);
    selectionBookmarkButtonElement = selectionBookmarkButton;

    selectionBookmarkButton.addEventListener("click", event => {
      event.stopPropagation();
      handleSelectionBookmarkButtonClick();
    });

    const selectionTagPopover = document.createElement("div");
    selectionTagPopover.id = "inPageSelectionTagPopover";
    selectionTagPopover.className = "in-page-selection-tag-popover";
    selectionTagPopover.innerHTML = `
      <input
        type="text"
        id="inPageSelectionTagInput"
        placeholder="برچسب (اختیاری، با کاما جدا کنید)">
      <div class="in-page-selection-tag-popover-actions">
        <button type="button" id="inPageSelectionTagSave">ذخیره</button>
        <button type="button" id="inPageSelectionTagCancel">انصراف</button>
      </div>
    `;
    document.body.appendChild(selectionTagPopover);
    selectionTagPopoverElement = selectionTagPopover;

    selectionTagPopover.addEventListener("click", event => {
      event.stopPropagation();
    });

    selectionTagPopover.querySelector("#inPageSelectionTagSave")
      .addEventListener("click", handleTagPopoverSave);
    selectionTagPopover.querySelector("#inPageSelectionTagCancel")
      .addEventListener("click", () => hideTagPopover(false));

    selectionTagPopover.querySelector("#inPageSelectionTagInput")
      .addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          handleTagPopoverSave();
        } else if (event.key === "Escape") {
          hideTagPopover(false);
        }
      });

    // Item ط (نشانگر متن): the small popover a bookmark-indicator dot
    // opens on hover/click - shows the bookmarked text plus its tags,
    // and lets the user remove that one bookmark right from the page.
    // See renderBookmarkIndicators/showBookmarkIndicatorPopover below.
    const bookmarkIndicatorPopover = document.createElement("div");
    bookmarkIndicatorPopover.id = "inPageBookmarkIndicatorPopover";
    bookmarkIndicatorPopover.className = "in-page-bookmark-indicator-popover";
    bookmarkIndicatorPopover.innerHTML = `
      <p class="in-page-bookmark-indicator-popover-text"></p>
      <p class="in-page-bookmark-indicator-popover-tags"></p>
      <div class="in-page-selection-tag-popover-actions">
        <button type="button" id="inPageBookmarkIndicatorRemove">حذف نشانه</button>
        <button type="button" id="inPageBookmarkIndicatorClose">بستن</button>
      </div>
    `;
    document.body.appendChild(bookmarkIndicatorPopover);
    bookmarkIndicatorPopoverElement = bookmarkIndicatorPopover;

    bookmarkIndicatorPopover.addEventListener("click", event => {
      event.stopPropagation();
    });

    bookmarkIndicatorPopover.addEventListener("mouseenter", cancelBookmarkIndicatorHoverClose);
    bookmarkIndicatorPopover.addEventListener("mouseleave", scheduleBookmarkIndicatorHoverClose);

    bookmarkIndicatorPopover.querySelector("#inPageBookmarkIndicatorRemove")
      .addEventListener("click", () => {
        if (pendingIndicatorBookmarkId) {
          removeBookmark(pendingIndicatorBookmarkId);
        }

        hideBookmarkIndicatorPopover();
      });

    bookmarkIndicatorPopover.querySelector("#inPageBookmarkIndicatorClose")
      .addEventListener("click", () => hideBookmarkIndicatorPopover());

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
        font-size: 0.7rem;
        font-weight: bold;
        white-space: nowrap;
      }

      .in-page-search-history-item {
        flex: 0 0 auto;
        box-sizing: border-box;
        padding: 4px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        background: #f8fafc;
        color: #173b63;
        font: inherit;
        font-size: 0.7rem;
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

      /* The number badge and the selection checkbox used to sit
         side-by-side, each taking their own slice of horizontal
         width away from the snippet text. Stacking them in one
         narrow column (number on top, checkbox below) instead keeps
         that combined width down to a single item's worth. */
      .in-page-result-marker {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
        padding-top: 2px;
      }

      .in-page-result-checkbox {
        margin: 0;
        flex-shrink: 0;
        cursor: pointer;
      }

      /* Item 5: small ordinal badge next to each result. */
      .in-page-result-number {
        flex-shrink: 0;
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

      /* Item ط: bookmarks panel reuses .archive-header / .archive-item
         etc. above (#inPageBookmarksPanel instead of
         #inPageArchivePanel) so the two panels look identical; only
         the tag chips/pills below are bookmark-specific. */
      #inPageBookmarksOverlay {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 10001;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.45);
      }

      #inPageBookmarksOverlay.open {
        display: flex;
      }

      #inPageBookmarksPanel {
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

      .bookmark-tag-filter {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 10px 16px;
        border-bottom: 1px solid #eef2f7;
      }

      .bookmark-tag-chip {
        border: 1px solid #c4b5fd;
        border-radius: 999px;
        background: #f5f3ff;
        color: #6d28d9;
        font: inherit;
        font-size: 0.72rem;
        padding: 3px 10px;
        cursor: pointer;
      }

      .bookmark-tag-chip:hover {
        background: #ede9fe;
      }

      .bookmark-tag-chip.is-active {
        background: #6d28d9;
        border-color: #6d28d9;
        color: #ffffff;
      }

      /* Item ط (چینش کتاب/برچسب): سرتیترهای گروه‌بندی سلسله‌مراتبی -
         عنوان کتاب با شماره‌ی اصلی (۱، ۲...) و زیرش عنوان برچسب با
         شماره‌ی فرعی (۱.۱، ۱.۲...) - که جای تکرار عنوان/برچسب روی تک‌تک
         نشانه‌ها را می‌گیرند (رجوع کنید به buildBookmarkGroups). */
      .bookmark-group-book {
        margin: 14px 16px 6px;
        padding-bottom: 4px;
        border-bottom: 2px solid #173b63;
        color: #173b63;
        font-size: 0.9rem;
        font-weight: bold;
      }

      .bookmark-group-book:first-child {
        margin-top: 4px;
      }

      .bookmark-group-tag {
        margin: 8px 16px 4px;
        color: #6d28d9;
        font-size: 0.8rem;
        font-weight: bold;
      }

      /* Item ط: floating "add bookmark" affordance for an arbitrary
         text selection. Both start hidden and are shown/positioned
         from JS right before use (see showSelectionBookmarkButton and
         showTagPopoverAt). */
      .in-page-selection-bookmark-button {
        display: none;
        position: fixed;
        z-index: 10002;
        border: none;
        border-radius: 999px;
        background: #173b63;
        color: #ffffff;
        font: inherit;
        font-size: 0.78rem;
        padding: 6px 14px;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.3);
        cursor: pointer;
      }

      .in-page-selection-bookmark-button.is-open {
        display: block;
      }

      .in-page-selection-bookmark-button:hover {
        background: #0f2a47;
      }

      .in-page-selection-tag-popover {
        display: none;
        position: fixed;
        z-index: 10002;
        flex-direction: column;
        gap: 8px;
        width: 260px;
        background: #ffffff;
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.25);
        padding: 10px;
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
      }

      .in-page-selection-tag-popover.is-open {
        display: flex;
      }

      .in-page-selection-tag-popover input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 6px 8px;
        font: inherit;
        font-size: 0.82rem;
      }

      .in-page-selection-tag-popover-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .in-page-selection-tag-popover-actions button {
        border: 1px solid #93c5fd;
        border-radius: 6px;
        background: #eff6ff;
        color: #1d4ed8;
        font: inherit;
        font-size: 0.78rem;
        padding: 5px 12px;
        cursor: pointer;
      }

      .in-page-selection-tag-popover-actions button:hover {
        background: #dbeafe;
      }

      .in-page-selection-tag-popover-actions #inPageSelectionTagCancel {
        border-color: #cbd5e1;
        background: #f8fafc;
        color: #475569;
      }

      .in-page-selection-tag-popover-actions #inPageSelectionTagCancel:hover {
        background: #eef2f7;
      }

      /* Item ط (نشانگر متن): a deliberately understated marker - a
         small dot, not the same "🔖" glyph used for the floating
         add-bookmark button - so an already-bookmarked passage reads
         as bookmarked without shouting over the surrounding text. */
      .in-page-bookmark-indicator {
        display: inline-block;
        width: 5px;
        height: 5px;
        margin: 0 3px;
        border-radius: 50%;
        background: #173b63;
        opacity: 0.32;
        cursor: pointer;
        vertical-align: middle;
        transition: opacity 0.15s ease, transform 0.15s ease;
      }

      .in-page-bookmark-indicator:hover {
        opacity: 0.85;
        transform: scale(1.4);
      }

      .in-page-bookmark-indicator-popover {
        display: none;
        position: fixed;
        z-index: 10002;
        flex-direction: column;
        gap: 6px;
        width: 240px;
        background: #ffffff;
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.25);
        padding: 10px;
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
        font-size: 0.78rem;
      }

      .in-page-bookmark-indicator-popover.is-open {
        display: flex;
      }

      .in-page-bookmark-indicator-popover-text {
        margin: 0;
        max-height: 80px;
        overflow-y: auto;
        color: #334155;
        line-height: 1.5;
      }

      .in-page-bookmark-indicator-popover-tags {
        margin: 0;
        color: #6d28d9;
        font-size: 0.72rem;
      }

      .in-page-bookmark-indicator-popover-tags:empty {
        display: none;
      }

      /* Item ط (لینک داخل صفحه): the brief flash used to draw the eye
         to a bookmark's spot when the target link is on the SAME page
         (see scrollToLiteralText) - fades out on its own rather than
         staying as a permanent highlight like a real search match. */
      mark.in-page-bookmark-flash {
        padding: 1px 2px;
        border-radius: 2px;
        background: #bbf7d0;
        outline: 2px solid #16a34a;
        transition: background 1.3s ease, outline-color 1.3s ease;
      }

      mark.in-page-bookmark-flash.is-fading {
        background: transparent;
        outline-color: transparent;
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
        node.parentElement.closest("#inPageSearchResults") ||
        node.parentElement.closest("#inPageSelectionTagPopover") ||
        node.parentElement.closest("#inPageBookmarkIndicatorPopover") ||
        node.parentElement.closest(".in-page-bookmark-indicator")
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

          const inFootnote = isFootnoteTextNode(node);

          if (inFootnote && !searchInFootnotes) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!inFootnote && !searchInMainText) {
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

  // ---- Item 8: full paragraph for copy/export -------------------------
  // The results panel only ever shows a short, sentence-scoped snippet
  // (getSnippetPlainText above) - good for scanning many results at
  // once. Copying/exporting is a different job though: for note-taking
  // ("فیش‌برداری") a short fragment loses context, so the clipboard copy
  // and the text/Word/PDF exports all use the FULL paragraph the match
  // lives in instead - the results panel itself is untouched.
  //
  // "Full paragraph" reuses the exact same container that
  // getSnippetContainer() finds for the short snippet (nearest P/LI/
  // DIV/... ancestor).

  // ~200-250 Persian/Arabic words. A hard cap so one huge, tag-less
  // block of text (rare, but possible) can't produce an unreasonably
  // long paste/export; when it's hit, the excerpt is trimmed evenly
  // around the match(es) rather than around the start of the block.
  const PARAGRAPH_EXPORT_MAX_LENGTH = 1500;

  function getMatchOffsetsInContainer(mark, container) {
    const start = getTextOffsetBefore(container, mark);
    return { start, end: start + mark.textContent.length };
  }

  // Groups the given marks by their enclosing paragraph element,
  // preserving each mark's own top-to-bottom order. Several selected
  // occurrences that happen to live in the same paragraph collapse
  // into ONE group - so that paragraph is produced (and highlighted)
  // only once, instead of being pasted once per occurrence.
  function groupMatchesByParagraph(selectedMarks) {
    const groups = [];
    const containerToGroup = new Map();

    selectedMarks.forEach(mark => {
      const container = getSnippetContainer(mark);
      let group = containerToGroup.get(container);

      if (!group) {
        group = { container, marks: [] };
        containerToGroup.set(container, group);
        groups.push(group);
      }

      group.marks.push(mark);
    });

    return groups;
  }

  // Resolves a group's mark offsets into: the raw paragraph text, the
  // (possibly trimmed) slice of it to actually use, and the merged
  // highlight spans within that slice. Spans are merged first so
  // overlapping/adjacent matches (e.g. from proximity search) can't
  // produce broken/nested highlight markup.
  function buildParagraphExcerpt(group) {
    const { container, marks } = group;
    const rawText = container.textContent || "";

    const spans = marks
      .map(mark => getMatchOffsetsInContainer(mark, container))
      .sort((a, b) => a.start - b.start);

    const mergedSpans = [];

    spans.forEach(span => {
      const last = mergedSpans[mergedSpans.length - 1];

      if (last && span.start <= last.end) {
        last.end = Math.max(last.end, span.end);
      } else {
        mergedSpans.push({ ...span });
      }
    });

    let sliceStart = 0;
    let sliceEnd = rawText.length;

    if (rawText.length > PARAGRAPH_EXPORT_MAX_LENGTH) {
      const spanStart = mergedSpans[0].start;
      const spanEnd = mergedSpans[mergedSpans.length - 1].end;
      const spanLength = spanEnd - spanStart;
      const padding = Math.max(0, Math.floor((PARAGRAPH_EXPORT_MAX_LENGTH - spanLength) / 2));

      sliceStart = Math.max(0, spanStart - padding);
      sliceEnd = Math.min(rawText.length, spanEnd + padding);
    }

    return {
      rawText,
      sliceStart,
      sliceEnd,
      spans: mergedSpans,
      truncatedBefore: sliceStart > 0,
      truncatedAfter: sliceEnd < rawText.length
    };
  }

  // Plain-text targets have no bold/color, so the matched term(s) are
  // marked with a plain, unambiguous **term** wrapper instead - kept
  // deliberately simple rather than markdown-flavored, since this is
  // read as-is (a .txt file, a plain-text paste), not rendered.
  function buildParagraphPlainText(excerpt) {
    const { rawText, sliceStart, sliceEnd, spans, truncatedBefore, truncatedAfter } = excerpt;

    let result = "";
    let cursor = sliceStart;

    spans.forEach(span => {
      const start = Math.max(span.start, sliceStart);
      const end = Math.min(span.end, sliceEnd);

      if (end <= cursor || start >= sliceEnd) {
        return;
      }

      result += rawText.slice(cursor, start);
      result += `**${rawText.slice(start, end)}**`;
      cursor = end;
    });

    result += rawText.slice(cursor, sliceEnd);

    const prefix = truncatedBefore ? "…" : "";
    const suffix = truncatedAfter ? "…" : "";

    return (prefix + result + suffix).replace(/\s+/g, " ").trim();
  }

  // Rich/HTML targets (clipboard rich-paste, the Word export, the PDF
  // export) get an actual colored highlight instead - visually the
  // same idea as the <mark> this tool uses to highlight matches on the
  // page itself, but built as a <span> with an explicit
  // background-color rather than a real <mark> element: Word's HTML
  // importer doesn't reliably keep styling on an unrecognized HTML5
  // tag like <mark>, so it can silently drop the color. mso-highlight
  // is Word's own "text highlight" property (what Word itself writes
  // when you use its highlighter), included alongside background-color
  // so Word picks it up as a native highlight rather than plain
  // shading. -webkit-print-color-adjust/print-color-adjust is for the
  // PDF path: browsers skip background colors when printing/"Save as
  // PDF" by default unless a rule forces them to keep it.
  function buildParagraphHtml(excerpt) {
    const { rawText, sliceStart, sliceEnd, spans, truncatedBefore, truncatedAfter } = excerpt;

    let result = "";
    let cursor = sliceStart;

    spans.forEach(span => {
      const start = Math.max(span.start, sliceStart);
      const end = Math.min(span.end, sliceEnd);

      if (end <= cursor || start >= sliceEnd) {
        return;
      }

      result += escapeHtml(rawText.slice(cursor, start));
      result +=
        `<span style="background-color:#fde047;mso-highlight:yellow;color:#111827;` +
        `padding:0 1px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">` +
        `${escapeHtml(rawText.slice(start, end))}</span>`;
      cursor = end;
    });

    result += escapeHtml(rawText.slice(cursor, sliceEnd));

    const prefix = truncatedBefore ? "…" : "";
    const suffix = truncatedAfter ? "…" : "";

    return (prefix + result + suffix).replace(/\s+/g, " ").trim();
  }

  // Single entry point every copy/export path below uses: one entry
  // per unique paragraph (already deduplicated + highlighted), in the
  // same top-to-bottom order the matches were found in.
  function buildParagraphEntries(selectedMarks) {
    return groupMatchesByParagraph(selectedMarks).map(group => {
      const excerpt = buildParagraphExcerpt(group);

      return {
        plainText: buildParagraphPlainText(excerpt),
        html: buildParagraphHtml(excerpt),
        url: buildMatchUrl(group.marks[0])
      };
    });
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

  // ---- Item ط: bookmarks (free-form tags) ------------------------------
  // Same localStorage pattern as the archive above, but under its own
  // key/shape (a bookmark isn't tied to a search match - it can be any
  // selected text - and it carries a "tags" array). Shared across book
  // pages the same way ARCHIVE_STORAGE_KEY is.
  const BOOKMARKS_STORAGE_KEY = "milaniBookmarks";
  const BOOKMARK_URL_FRAGMENT_MAX_LENGTH = 200;

  function loadBookmarks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(BOOKMARKS_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveBookmarks(items) {
    try {
      localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(items));
    } catch (error) {
      // Storage unavailable or full - bookmarks just won't persist.
    }
  }

  // Splits on Latin/Persian commas, trims, drops empties, and
  // deduplicates - "قانون, قانون ،مثال" -> ["قانون", "مثال"].
  function parseTagsInput(raw) {
    return Array.from(new Set(
      (raw || "")
        .split(/[،,]+/)
        .map(tag => tag.trim())
        .filter(Boolean)
    ));
  }

  function getAllBookmarkTags(bookmarks) {
    const tags = new Set();
    bookmarks.forEach(item => (item.tags || []).forEach(tag => tags.add(tag)));
    return Array.from(tags).sort((a, b) => a.localeCompare(b, "fa"));
  }

  // A bookmarked selection has no <mark> element to build a
  // text-fragment URL from the way buildMatchUrl does for search
  // results, so this builds the same kind of #:~:text= link directly
  // from the raw selected string - literal text, not normalized,
  // matching buildMatchUrl's own convention. Long selections are
  // capped for the URL only (the full text is still stored and shown
  // in the panel); the capped prefix is still a literal substring of
  // the real page text, so the browser's native text-fragment match
  // still finds it.
  function buildSelectionBookmarkUrl(text) {
    const base = location.origin + location.pathname;
    const trimmed = (text || "").trim();

    if (!trimmed) {
      return base;
    }

    const fragment = trimmed.length > BOOKMARK_URL_FRAGMENT_MAX_LENGTH ?
      trimmed.slice(0, BOOKMARK_URL_FRAGMENT_MAX_LENGTH) :
      trimmed;

    return `${base}#:~:text=${encodeURIComponent(fragment)}`;
  }

  function addBookmark({ text, url, tags }) {
    const trimmedText = (text || "").trim();

    if (!trimmedText) {
      return;
    }

    const bookmarks = loadBookmarks();

    bookmarks.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: getPageTitle(),
      text: trimmedText,
      url: url || (location.origin + location.pathname),
      tags: Array.isArray(tags) ? tags : [],
      savedAt: new Date().toISOString()
    });

    saveBookmarks(bookmarks);
    renderBookmarksPanel();
    renderBookmarkIndicators();
  }

  function removeBookmark(id) {
    saveBookmarks(loadBookmarks().filter(item => item.id !== id));
    renderBookmarksPanel();
    renderBookmarkIndicators();
  }

  function clearBookmarks() {
    saveBookmarks([]);
    bookmarkFilterTags.clear();
    renderBookmarksPanel();
    renderBookmarkIndicators();
  }

  // Item ط (چینش کتاب/برچسب): چون نشانه‌های چند کتاب/فایل مختلف در یک
  // localStorage مشترک ذخیره می‌شوند، بدون گروه‌بندی با هم قاطی
  // می‌شدند. اینجا نشانه‌ها اول زیر عنوان کتابشان (سطح ۱) و داخل هر
  // کتاب زیر عنوان برچسبشان (سطح ۲) دسته می‌شوند تا در renderBookmarksPanel
  // با شماره‌ی سلسله‌مراتبی «۱» / «۱.۱» نمایش داده شوند - صرف‌نظر از
  // ترتیب واقعی‌ای که کاربر نشانه‌ها را ذخیره کرده.
  const BOOKMARK_NO_TAG_LABEL = "بدون برچسب";

  function compareFa(a, b) {
    return (a || "").localeCompare(b || "", "fa");
  }

  // یک نشانه‌ی چندبرچسبی زیر هر یک از برچسب‌هایش تکرار می‌شود؛ نشانه‌ی
  // بدون برچسب زیر زیرگروه BOOKMARK_NO_TAG_LABEL می‌رود. وقتی فیلتر
  // برچسبیِ بالای پنل فعال است (restrictTags چند برچسب می‌تواند
  // هم‌زمان انتخاب شده باشد)، هر نشانه فقط زیر همان برچسب(های) انتخابی‌ که
  // خودش هم دارد قرار می‌گیرد - نه زیر بقیه‌ی برچسب‌های احتمالی‌اش که
  // انتخاب نشده‌اند - چون کاربر صریحاً نمایش را به آن برچسب‌ها محدود
  // کرده است.
  function buildBookmarkGroups(items, restrictTags) {
    const bookMap = new Map();
    const hasRestriction = restrictTags && restrictTags.size > 0;

    items.forEach(item => {
      const bookTitle = item.title || "";

      if (!bookMap.has(bookTitle)) {
        bookMap.set(bookTitle, new Map());
      }

      const tagMap = bookMap.get(bookTitle);
      const itemTags = (item.tags && item.tags.length) ? item.tags : [BOOKMARK_NO_TAG_LABEL];
      const tagsForGrouping = hasRestriction ?
        itemTags.filter(tag => restrictTags.has(tag)) :
        itemTags;

      tagsForGrouping.forEach(tag => {
        if (!tagMap.has(tag)) {
          tagMap.set(tag, []);
        }

        tagMap.get(tag).push(item);
      });
    });

    return bookMap;
  }

  // ترتیب برچسب‌ها داخل یک کتاب: الفبایی، با این استثنا که زیرگروه
  // «بدون برچسب» همیشه آخرین زیرگروه همان کتاب می‌ماند (فارغ از جایگاه
  // الفبایی‌اش).
  function sortedBookmarkTagKeys(tagMap) {
    const keys = Array.from(tagMap.keys());
    const hasNoTagGroup = keys.includes(BOOKMARK_NO_TAG_LABEL);
    const named = keys.filter(key => key !== BOOKMARK_NO_TAG_LABEL).sort(compareFa);

    return hasNoTagGroup ? named.concat([BOOKMARK_NO_TAG_LABEL]) : named;
  }

  function renderBookmarksPanel() {
    const panel = document.getElementById("inPageBookmarksPanel");

    if (!panel) {
      return;
    }

    const all = loadBookmarks().slice().reverse();
    const allTags = getAllBookmarkTags(all);

    // Stale filter entries (a tag got removed along with the last
    // bookmark that had it) - drop just those, keep the rest of the
    // selection intact.
    Array.from(bookmarkFilterTags).forEach(tag => {
      if (!allTags.includes(tag)) {
        bookmarkFilterTags.delete(tag);
      }
    });

    // Item ط (چند-انتخابی): وقتی چند برچسب هم‌زمان فعال است، نشانه‌ای
    // که هر یک از آن برچسب‌ها را داشته باشد نمایش داده می‌شود (اجتماع،
    // نه اشتراک) تا کاربر بتواند چند زیرمجموعه را با هم ببیند.
    const items = bookmarkFilterTags.size === 0 ?
      all :
      all.filter(item => (item.tags || []).some(tag => bookmarkFilterTags.has(tag)));

    const tagChipsHtml = allTags.length === 0 ? "" : `
      <div class="bookmark-tag-filter">
        ${allTags.map(tag => `
          <button
            type="button"
            class="bookmark-tag-chip${bookmarkFilterTags.has(tag) ? " is-active" : ""}"
            data-bookmark-filter-tag="${escapeHtml(tag)}">
            ${escapeHtml(tag)}
          </button>
        `).join("")}
      </div>
    `;

    // Item ط (چینش کتاب/برچسب): به‌جای تکرار عنوان کتاب و برچسب روی
    // تک‌تک نشانه‌ها، اول بر اساس عنوان کتاب (الفبایی، شماره‌ی اصلی
    // ۱، ۲...) و داخل هر کتاب بر اساس برچسب (الفبایی، شماره‌ی فرعی
    // ۱.۱، ۱.۲...) گروه‌بندی می‌شوند - مستقل از ترتیب/زمان ذخیره‌شدن
    // نشانه‌ها توسط کاربر.
    const groups = buildBookmarkGroups(items, bookmarkFilterTags);
    const bookTitles = Array.from(groups.keys()).sort(compareFa);

    const listHtml = items.length === 0 ?
      `<p class="archive-empty">${
        bookmarkFilterTags.size > 0 ? "نشانه‌ای با این برچسب‌ها یافت نشد." : "هنوز نشانه‌ای ذخیره نشده است."
      }</p>` :
      bookTitles.map((bookTitle, bookIndex) => {
        const mainNumber = bookIndex + 1;
        const tagMap = groups.get(bookTitle);
        const tagKeys = sortedBookmarkTagKeys(tagMap);

        const tagsHtml = tagKeys.map((tagLabel, tagIndex) => {
          const subNumber = `${mainNumber}.${tagIndex + 1}`;

          const itemsHtml = tagMap.get(tagLabel).map(item => `
            <div class="archive-item">
              <p class="archive-item-text">"${escapeHtml(item.text || "")}"</p>
              <div class="archive-item-actions">
                <a href="${escapeHtml(item.url || "#")}">
                  بازکردن
                </a>
                <button type="button" data-bookmark-id="${escapeHtml(item.id)}">
                  حذف
                </button>
              </div>
            </div>
          `).join("");

          return `
            <div class="bookmark-group-tag">${subNumber} - ${escapeHtml(tagLabel)}</div>
            ${itemsHtml}
          `;
        }).join("");

        return `
          <div class="bookmark-group-book">${mainNumber} - ${escapeHtml(bookTitle || "بدون عنوان")}</div>
          ${tagsHtml}
        `;
      }).join("");

    panel.innerHTML = `
      <div class="archive-header">
        <span>نشانه‌ها (${all.length})</span>
        <div class="archive-header-actions">
          <button type="button" id="inPageBookmarksClear">پاک‌کردن همه</button>
          <button type="button" id="inPageBookmarksClose">بستن</button>
        </div>
      </div>
      ${tagChipsHtml}
      ${listHtml}
    `;

    const clearButton = panel.querySelector("#inPageBookmarksClear");
    if (clearButton) {
      clearButton.addEventListener("click", clearBookmarks);
    }

    const closeButton = panel.querySelector("#inPageBookmarksClose");
    if (closeButton) {
      closeButton.addEventListener("click", closeBookmarksPanel);
    }

    panel.querySelectorAll("[data-bookmark-id]").forEach(button => {
      button.addEventListener("click", () => {
        removeBookmark(button.dataset.bookmarkId);
      });
    });

    // Item ط (چند-انتخابی): هر کلیک فقط همان یک برچسب را در مجموعه‌ی
    // فعال اضافه/حذف می‌کند - بدون پاک کردن بقیه‌ی برچسب‌های از قبل
    // انتخاب‌شده - تا کاربر بتواند با کلیک روی چند (یا همه‌ی) عنوان‌ها
    // زیرمجموعه‌هایشان را با هم ببیند.
    panel.querySelectorAll("[data-bookmark-filter-tag]").forEach(chip => {
      chip.addEventListener("click", () => {
        const tag = chip.dataset.bookmarkFilterTag;

        if (bookmarkFilterTags.has(tag)) {
          bookmarkFilterTags.delete(tag);
        } else {
          bookmarkFilterTags.add(tag);
        }

        renderBookmarksPanel();
      });
    });

    // Item ط (لینک داخل صفحه): وقتی لینک به همین فایل اشاره می‌کند،
    // پیمایش پیش‌فرض مرورگر جایگزین می‌شود چون یک لینک هم‌صفحه‌ای -
    // چه فقط hash فرق کند چه q/frag/occ هم داشته باشد - همیشه ناوبری
    // کامل (reload) ایجاد نمی‌کند و برچسب‌گذاری متنی خودکار مرورگر هم
    // روی ناوبری هم‌سندی اجرا نمی‌شود؛ برای فایل‌های دیگر رفتار
    // پیش‌فرض <a> دست‌نخورده می‌ماند.
    panel.querySelectorAll(".archive-item-actions a[href]").forEach(link => {
      link.addEventListener("click", event => {
        handleBookmarkLinkClick(event, link.getAttribute("href"));
      });
    });
  }

  function openBookmarksPanel() {
    renderBookmarksPanel();
    bookmarksOverlayElement.classList.add("open");
  }

  function closeBookmarksPanel() {
    bookmarksOverlayElement.classList.remove("open");
  }

  // ---- Item ط (لینک داخل صفحه): opening a bookmark link on the SAME
  // page ------------------------------------------------------------
  // A bookmark's stored url always points at this same page for
  // same-page bookmarks, so a plain <a href> click on it is often a
  // same-document navigation (only the hash - or nothing at all -
  // differs from the URL already loaded). Browsers don't reliably
  // re-run a fresh page load - or their own native #:~:text=
  // highlighting - for that case, so nothing visibly happens. This
  // detects that case and performs the equivalent of
  // applyIncomingQueryFromUrl() manually instead of letting the
  // default navigation (which only works for a genuinely different
  // file) happen.

  function extractTextFragmentFromHash(hash) {
    const marker = "#:~:text=";
    const value = hash || "";
    const index = value.indexOf(marker);

    if (index === -1) {
      return null;
    }

    const raw = value.slice(index + marker.length);

    try {
      return decodeURIComponent(raw);
    } catch (error) {
      return raw;
    }
  }

  // Finds the literal (whitespace-tolerant) occurrence of `text`
  // within a single searchable text node - the same one-node
  // simplification the rest of this file's own matching already
  // relies on (see highlightLiteralMatches/highlightProximityMatches).
  function findLiteralTextRange(text) {
    const target = (text || "").trim();

    if (!target) {
      return null;
    }

    const patternSource = target
      .split(/\s+/)
      .map(escapeRegExp)
      .join("\\s+");

    let pattern;

    try {
      pattern = new RegExp(patternSource);
    } catch (error) {
      return null;
    }

    const nodes = getSearchableTextNodes();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const match = pattern.exec(node.nodeValue);

      if (match) {
        return { node, start: match.index, end: match.index + match[0].length };
      }
    }

    return null;
  }

  function wrapSingleRange(node, start, end, className) {
    const originalText = node.nodeValue;
    const fragment = document.createDocumentFragment();

    if (start > 0) {
      fragment.appendChild(document.createTextNode(originalText.slice(0, start)));
    }

    const mark = document.createElement("mark");
    mark.className = className;
    mark.textContent = originalText.slice(start, end);
    fragment.appendChild(mark);

    if (end < originalText.length) {
      fragment.appendChild(document.createTextNode(originalText.slice(end)));
    }

    node.parentNode.replaceChild(fragment, node);

    return mark;
  }

  // Finds the bookmarked text on the page, scrolls it into view, and
  // gives it a brief, self-fading flash so the user's eye lands on it
  // - a temporary cue, unlike the permanent highlight a real search
  // match gets, since this text isn't necessarily part of any active
  // search.
  function scrollToLiteralText(text) {
    const found = findLiteralTextRange(text);

    if (!found) {
      return false;
    }

    const flashMark = wrapSingleRange(found.node, found.start, found.end, "in-page-bookmark-flash");

    flashMark.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

    setTimeout(() => flashMark.classList.add("is-fading"), 900);

    setTimeout(() => {
      const parent = flashMark.parentNode;

      if (parent) {
        parent.replaceChild(document.createTextNode(flashMark.textContent), flashMark);
        parent.normalize();
      }
    }, 2200);

    return true;
  }

  function navigateToSamePageBookmark(target) {
    const query = target.searchParams.get("q");

    if (!query) {
      // Item ط (نشانه‌ی یک انتخاب آزاد): no search query to run - just
      // a literal #:~:text= fragment to locate and scroll to.
      const literalText = extractTextFragmentFromHash(target.hash);

      if (literalText) {
        scrollToLiteralText(literalText);
      }

      return;
    }

    const input = document.getElementById("inPageSearchInput");
    const rootToggle = document.getElementById("inPageSearchRoot");

    if (input) {
      input.value = query;
    }

    if (rootToggle && target.searchParams.get("root") === "1") {
      rootToggle.checked = true;
      updateDerivativesToggleVisibility();
    }

    performSearch();

    const fragParam = target.searchParams.get("frag") || extractTextFragmentFromHash(target.hash);
    const occParam = parseInt(target.searchParams.get("occ"), 10);
    const targetIndex = findMatchIndexForFragment(
      fragParam,
      Number.isInteger(occParam) && occParam > 0 ? occParam : 1
    );

    if (targetIndex !== -1) {
      // Same short delay applyIncomingQueryFromUrl() uses, for the
      // same reason: let the just-triggered render settle first.
      setTimeout(() => showMatch(targetIndex), 0);
    }
  }

  function handleBookmarkLinkClick(event, rawUrl) {
    if (!rawUrl) {
      return;
    }

    let target;

    try {
      target = new URL(rawUrl, location.href);
    } catch (error) {
      return;
    }

    const isSamePage = target.origin === location.origin && target.pathname === location.pathname;

    if (!isSamePage) {
      // A different file - the browser's own normal navigation
      // already handles this correctly (real page load).
      return;
    }

    event.preventDefault();
    closeBookmarksPanel();
    navigateToSamePageBookmark(target);
  }

  // ---- Item ط (نشانگر متن): marking an already-bookmarked passage --
  // A subtle dot inserted right after any text on THIS page that has
  // a saved bookmark, so the reader can tell at a glance that a spot
  // was bookmarked - without it competing visually with the text
  // itself. Hovering (or tapping) it opens a small popover with the
  // saved text/tags and a way to remove that one bookmark.

  function getBookmarksForCurrentPage() {
    const base = location.origin + location.pathname;

    return loadBookmarks().filter(item => {
      try {
        const itemUrl = new URL(item.url || "", location.href);
        return itemUrl.origin + itemUrl.pathname === base;
      } catch (error) {
        return false;
      }
    });
  }

  function removeBookmarkIndicators() {
    document.querySelectorAll(".in-page-bookmark-indicator").forEach(el => el.remove());
  }

  function insertBookmarkIndicatorAfter(node, endOffset, bookmarkId) {
    const originalText = node.nodeValue;
    const beforeNode = document.createTextNode(originalText.slice(0, endOffset));
    const afterNode = document.createTextNode(originalText.slice(endOffset));

    const indicator = document.createElement("span");
    indicator.className = "in-page-bookmark-indicator";
    indicator.dataset.bookmarkIndicatorId = bookmarkId;
    indicator.setAttribute("role", "button");
    indicator.setAttribute("aria-label", "این بخش نشانه‌گذاری شده است");

    const parent = node.parentNode;
    parent.insertBefore(beforeNode, node);
    parent.insertBefore(indicator, node);
    parent.insertBefore(afterNode, node);
    parent.removeChild(node);

    return indicator;
  }

  function renderBookmarkIndicators() {
    removeBookmarkIndicators();

    getBookmarksForCurrentPage().forEach(item => {
      const found = findLiteralTextRange(item.text);

      if (!found) {
        return;
      }

      const indicator = insertBookmarkIndicatorAfter(found.node, found.end, item.id);

      indicator.addEventListener("mouseenter", () => showBookmarkIndicatorPopover(indicator, item));
      indicator.addEventListener("mouseleave", scheduleBookmarkIndicatorHoverClose);
      indicator.addEventListener("click", event => {
        event.stopPropagation();
        showBookmarkIndicatorPopover(indicator, item);
      });
    });
  }

  function cancelBookmarkIndicatorHoverClose() {
    if (bookmarkIndicatorHoverCloseTimer) {
      clearTimeout(bookmarkIndicatorHoverCloseTimer);
      bookmarkIndicatorHoverCloseTimer = null;
    }
  }

  function scheduleBookmarkIndicatorHoverClose() {
    cancelBookmarkIndicatorHoverClose();

    bookmarkIndicatorHoverCloseTimer = setTimeout(() => {
      bookmarkIndicatorHoverCloseTimer = null;
      hideBookmarkIndicatorPopover();
    }, 200);
  }

  function showBookmarkIndicatorPopover(indicatorEl, item) {
    if (!bookmarkIndicatorPopoverElement) {
      return;
    }

    cancelBookmarkIndicatorHoverClose();
    pendingIndicatorBookmarkId = item.id;

    const textEl = bookmarkIndicatorPopoverElement.querySelector(".in-page-bookmark-indicator-popover-text");
    const tagsEl = bookmarkIndicatorPopoverElement.querySelector(".in-page-bookmark-indicator-popover-tags");

    if (textEl) {
      textEl.textContent = item.text || "";
    }

    if (tagsEl) {
      tagsEl.textContent = (item.tags && item.tags.length) ? item.tags.join("، ") : "";
    }

    bookmarkIndicatorPopoverElement.classList.add("is-open");
    positionFloatingElementNearRect(bookmarkIndicatorPopoverElement, indicatorEl.getBoundingClientRect());
  }

  // Item 4-mirroring: closes the same way the search-history dropdown
  // does (moving the mouse away - see scheduleBookmarkIndicatorHoverClose
  // above), the same way the tag-input popover does (a click outside
  // it), AND now also on Escape (see the keydown listener in
  // setupSelectionBookmarking).
  function hideBookmarkIndicatorPopover() {
    if (!bookmarkIndicatorPopoverElement) {
      return;
    }

    bookmarkIndicatorPopoverElement.classList.remove("is-open");
    pendingIndicatorBookmarkId = null;
  }

  // ---- Item ط: bookmarking a live text selection ------------------------
  // Detects any non-empty selection made anywhere outside the search
  // UI/panels themselves, shows a small floating "🔖" button next to
  // it, and - on click - swaps that button for a tag-input popover at
  // the same spot. addSelectedToBookmarks (settings menu) reuses the
  // very same popover in "matches" mode - see pendingBookmarkMode.

  function isWithinAppInterface(el) {
    return !!(el && (
      el.closest("#inPageSearchBox") ||
      el.closest("#inPageSearchResults") ||
      el.closest("#inPageArchiveOverlay") ||
      el.closest("#inPageBookmarksOverlay") ||
      el.closest("#inPageSelectionBookmarkButton") ||
      el.closest("#inPageSelectionTagPopover") ||
      el.closest("#inPageBookmarkIndicatorPopover") ||
      el.closest(".in-page-bookmark-indicator")
    ));
  }

  function positionFloatingElementNearRect(el, rect) {
    const GAP = 8;
    const elRect = el.getBoundingClientRect();

    let left = rect.left + rect.width / 2 - elRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - elRect.width - 8));

    let top = rect.top - elRect.height - GAP;
    if (top < 8) {
      // No room above (selection starts near the top of the
      // viewport) - flip to just below the selection instead.
      top = rect.bottom + GAP;
    }

    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function hideSelectionBookmarkButton() {
    if (selectionBookmarkButtonElement) {
      selectionBookmarkButtonElement.classList.remove("is-open");
    }
  }

  function showSelectionBookmarkButton(rect) {
    if (!selectionBookmarkButtonElement) {
      return;
    }

    selectionBookmarkButtonElement.classList.add("is-open");
    positionFloatingElementNearRect(selectionBookmarkButtonElement, rect);
  }

  function handleSelectionBookmarkButtonClick() {
    if (!pendingSelectionText) {
      return;
    }

    const rect = selectionBookmarkButtonElement.getBoundingClientRect();
    pendingBookmarkMode = "selection";
    hideSelectionBookmarkButton();
    showTagPopoverAt(rect);
  }

  function addSelectedToBookmarks() {
    if (selectedMatchIndexes.size === 0) {
      return;
    }

    const gear = document.getElementById("inPageSettingsGear");
    pendingBookmarkMode = "matches";
    showTagPopoverAt(gear ? gear.getBoundingClientRect() : null);
  }

  function showTagPopoverAt(rect) {
    if (!selectionTagPopoverElement) {
      return;
    }

    const input = selectionTagPopoverElement.querySelector("#inPageSelectionTagInput");
    if (input) {
      input.value = "";
    }

    selectionTagPopoverElement.classList.add("is-open");

    if (rect) {
      positionFloatingElementNearRect(selectionTagPopoverElement, rect);
    } else {
      const popoverRect = selectionTagPopoverElement.getBoundingClientRect();
      selectionTagPopoverElement.style.left =
        Math.max(8, (window.innerWidth - popoverRect.width) / 2) + "px";
      selectionTagPopoverElement.style.top =
        Math.max(8, (window.innerHeight - popoverRect.height) / 2) + "px";
    }

    if (input) {
      input.focus();
    }
  }

  function hideTagPopover(showSavedFeedback) {
    if (!selectionTagPopoverElement) {
      return;
    }

    if (showSavedFeedback) {
      const originalHtml = selectionTagPopoverElement.innerHTML;

      selectionTagPopoverElement.innerHTML =
        `<div style="text-align:center;padding:6px 0;">نشانه ذخیره شد!</div>`;

      setTimeout(() => {
        selectionTagPopoverElement.classList.remove("is-open");
        selectionTagPopoverElement.innerHTML = originalHtml;

        selectionTagPopoverElement.querySelector("#inPageSelectionTagSave")
          .addEventListener("click", handleTagPopoverSave);
        selectionTagPopoverElement.querySelector("#inPageSelectionTagCancel")
          .addEventListener("click", () => hideTagPopover(false));

        selectionTagPopoverElement.querySelector("#inPageSelectionTagInput")
          .addEventListener("keydown", event => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleTagPopoverSave();
            } else if (event.key === "Escape") {
              hideTagPopover(false);
            }
          });
      }, 1200);
    } else {
      selectionTagPopoverElement.classList.remove("is-open");
    }

    pendingBookmarkMode = null;
    pendingSelectionText = "";

    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }
  }

  function handleTagPopoverSave() {
    const input = selectionTagPopoverElement.querySelector("#inPageSelectionTagInput");
    const tags = parseTagsInput(input ? input.value : "");

    if (pendingBookmarkMode === "selection") {
      addBookmark({
        text: pendingSelectionText,
        url: buildSelectionBookmarkUrl(pendingSelectionText),
        tags
      });
    } else if (pendingBookmarkMode === "matches") {
      [...selectedMatchIndexes]
        .sort((a, b) => a - b)
        .map(index => matches[index])
        .filter(Boolean)
        .forEach(mark => {
          addBookmark({
            text: getSnippetPlainText(mark),
            url: buildMatchUrl(mark),
            tags
          });
        });
    }

    hideTagPopover(true);
  }

  function handleDocumentSelectionChange() {
    // The popover stays open (and the button hidden) for as long as
    // the user is filling it in, even though clicking into its own
    // text input collapses/changes the page selection underneath it.
    if (
      selectionTagPopoverElement &&
      selectionTagPopoverElement.classList.contains("is-open")
    ) {
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection && !selection.isCollapsed ?
      selection.toString().trim() :
      "";

    if (
      !selectedText ||
      !selection.anchorNode ||
      isWithinAppInterface(
        selection.anchorNode.nodeType === Node.ELEMENT_NODE ?
          selection.anchorNode :
          selection.anchorNode.parentElement
      )
    ) {
      hideSelectionBookmarkButton();
      pendingSelectionText = "";
      return;
    }

    pendingSelectionText = selectedText;

    const range = selection.getRangeAt(0);
    showSelectionBookmarkButton(range.getBoundingClientRect());
  }

  function setupSelectionBookmarking() {
    let selectionChangeTimer = null;

    document.addEventListener("selectionchange", () => {
      clearTimeout(selectionChangeTimer);
      selectionChangeTimer = setTimeout(handleDocumentSelectionChange, 200);
    });

    document.addEventListener("click", event => {
      if (
        selectionBookmarkButtonElement &&
        selectionBookmarkButtonElement.classList.contains("is-open") &&
        !isWithinAppInterface(event.target)
      ) {
        hideSelectionBookmarkButton();
      }

      if (
        selectionTagPopoverElement &&
        selectionTagPopoverElement.classList.contains("is-open") &&
        event.target !== selectionTagPopoverElement &&
        !selectionTagPopoverElement.contains(event.target)
      ) {
        hideTagPopover(false);
      }

      // Item ط (نشانگر متن): موس روی نشانگر رفتن/برگشتن خودش بستن را با
      // تأخیر مدیریت می‌کند (scheduleBookmarkIndicatorHoverClose) - این
      // فقط برای کلیک روی جای دیگر صفحه است، مثلاً روی موبایل که
      // "hover" واقعی وجود ندارد.
      if (
        bookmarkIndicatorPopoverElement &&
        bookmarkIndicatorPopoverElement.classList.contains("is-open") &&
        !bookmarkIndicatorPopoverElement.contains(event.target) &&
        !(event.target.closest && event.target.closest(".in-page-bookmark-indicator"))
      ) {
        hideBookmarkIndicatorPopover();
      }
    });

    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") {
        return;
      }

      if (
        selectionTagPopoverElement &&
        selectionTagPopoverElement.classList.contains("is-open")
      ) {
        hideTagPopover(false);
      }

      // Item 4: بلوکی که با حرکت موس از صفحه کنار می‌رود (نشانگر متن
      // بالا)، با زدن Esc هم کنار برود.
      if (
        bookmarkIndicatorPopoverElement &&
        bookmarkIndicatorPopoverElement.classList.contains("is-open")
      ) {
        hideBookmarkIndicatorPopover();
      }
    });
  }

  // ---- Item 4-الف: direct file export ---------------------------------
  // Reuses the exact same header + numbered-snippet text that
  // handleCopySelectedMatches builds for the clipboard, so the
  // downloaded file and the pasted text always agree.
  function buildExportPlainText(selected) {
    const pageTitle = getPageTitle();
    const divider = "─".repeat(32);
    const header = `📘 عنوان: ${pageTitle}\n${divider}`;

    const body = buildParagraphEntries(selected)
      .map((entry, index) => `${index + 1}. «${entry.plainText}»\n   🔗 لینک منبع: ${entry.url}`)
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

  // No docx library is loaded (same reasoning as the PDF export below:
  // avoids an external CDN dependency for one feature) - instead this
  // downloads a .doc file that is really just HTML, with the couple of
  // Word-specific <!--[if gte mso 9]--> hints Word looks for before it
  // will open a ".doc" HTML file natively. The link markup is the same
  // short, clickable "لینک منبع" pattern handleCopySelectedMatches()
  // already puts on the clipboard for Word's rich-paste, so the
  // downloaded file and a pasted copy always match.
  function exportSelectedAsWord() {
    const selected = getSelectedMatchesInOrder();

    if (selected.length === 0) {
      return;
    }

    const pageTitle = escapeHtml(getPageTitle());

    const itemsHtml = buildParagraphEntries(selected)
      .map((entry, index) => (
        `<p dir="ltr" style="margin:0 0 3px;font-family:Tahoma,Arial,sans-serif;` +
        `font-size:14px;line-height:1.9;color:#1f2937;text-align:right;">` +
        `<strong>${index + 1}.</strong>\u00a0«${entry.html}»</p>` +
        `<p dir="ltr" style="margin:0 0 14px;font-family:Tahoma,Arial,sans-serif;` +
        `font-size:12px;text-align:right;">🔗 ` +
        `<a href="${escapeHtml(entry.url)}" style="color:#1d4ed8;text-decoration:none;">لینک منبع</a></p>`
      ))
      .join("");

    const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8">
        <title>${pageTitle}</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:DoNotOptimizeForBrowser/>
          </w:WordDocument>
        </xml>
        <![endif]-->
      </head>
      <body dir="rtl" style="font-family:Tahoma,Arial,sans-serif;">
        <table dir="ltr" role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 12px;">
          <tr>
            <td style="padding:9px 14px;background:#eff6ff;border-right:4px solid #2563eb;
              font-family:Tahoma,Arial,sans-serif;font-size:14px;font-weight:bold;
              color:#173b63;text-align:right;">📘&nbsp;${pageTitle}</td>
          </tr>
        </table>
        ${itemsHtml}
      </body>
    </html>`;

    downloadTextFile(
      `${getPageTitle() || "نتایج-جستجو"}.doc`,
      doc,
      "application/msword;charset=utf-8"
    );
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

    const itemsHtml = buildParagraphEntries(selected)
      .map((entry, index) => `
        <div class="export-item">
          <p class="export-snippet"><strong>${index + 1}.</strong>&nbsp;«${entry.html}»</p>
          <p class="export-link">🔗 <a href="${escapeHtml(entry.url)}">لینک منبع</a></p>
        </div>
      `)
      .join("");

    const doc = `<!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
        <meta charset="utf-8">
        <title>${pageTitle}</title>
        <style>
          * {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
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

    // Item ط/۴-الف (شمارنده): تعداد فعلی محتویات آرشیو و نشانه‌ها،
    // کنار عنوان همان دو گزینه در منو - مستقل از انتخاب فعلی کاربر در
    // نتایج جست‌وجو (همان چیزی که hasSelection/selectedCount بالا
    // نشان می‌دهند).
    const archiveCount = loadArchive().length;
    const bookmarksCount = loadBookmarks().length;

    menu.innerHTML = `
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuSelectAll"
        title="انتخاب همه‌ی نتایج فعلی جست‌وجو، برای کپی/آرشیو/خروجی گرفتن گروهی از آن‌ها"
        ${hasMatches ? "" : "disabled"}>
        <span>انتخاب همه</span>
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuClearSelection"
        title="برداشتن علامت انتخاب از تمام نتایجی که تاکنون انتخاب کرده‌اید"
        ${hasSelection ? "" : "disabled"}>
        <span>حذف انتخاب</span>
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuRemoveSelected"
        title="پاک‌کردن موارد انتخاب‌شده از فهرست نتایج (فقط از این فهرست، نه از متن صفحه)"
        ${hasSelection ? "" : "disabled"}>
        <span>حذف موارد انتخاب‌شده</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>

      <div class="in-page-settings-separator"></div>

      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuOpenArchive"
        title="باز کردن آرشیوی که پیش‌تر نتایج جست‌وجو را در آن ذخیره کرده‌اید">
        <span>آرشیو</span>
        ${archiveCount > 0 ? `<span class="in-page-settings-badge">${archiveCount}</span>` : ""}
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuAddToArchive"
        title="افزودن موارد انتخاب‌شده به آرشیو، برای مراجعه و استفاده بعدی"
        ${hasSelection ? "" : "disabled"}>
        <span>افزودن به آرشیو</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuOpenBookmarks"
        title="باز کردن نشانه‌هایی که تاکنون در متن یا نتایج جست‌وجو ذخیره کرده‌اید">
        <span>نشانه‌ها</span>
        ${bookmarksCount > 0 ? `<span class="in-page-settings-badge">${bookmarksCount}</span>` : ""}
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuAddToBookmarks"
        title="افزودن موارد انتخاب‌شده به نشانه‌ها همراه با برچسب دلخواه"
        ${hasSelection ? "" : "disabled"}>
        <span>افزودن نشانه به انتخاب‌شده‌ها</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>

      <div class="in-page-settings-separator"></div>

      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuCopySelected"
        title="کپی متن موارد انتخاب‌شده در حافظه؛ با پیست‌کردن، لینک منبع هم همراه متن اضافه می‌شود"
        ${hasSelection ? "" : "disabled"}>
        <span>کپی موارد انتخاب‌شده</span>
        ${hasSelection ? `<span class="in-page-settings-badge">${selectedCount}</span>` : ""}
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuExportText"
        title="دریافت موارد انتخاب‌شده به‌صورت یک فایل متنی ساده (txt.) قابل ذخیره"
        ${hasSelection ? "" : "disabled"}>
        <span>دریافت به‌صورت Text</span>
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuExportWord"
        title="دریافت موارد انتخاب‌شده به‌صورت یک فایل ورد (doc.) قابل ذخیره، با لینک منبعِ کوتاه و قابل کلیک"
        ${hasSelection ? "" : "disabled"}>
        <span>دریافت به‌صورت Word</span>
      </button>
      <button
        type="button"
        class="in-page-settings-item"
        id="inPageMenuExportPdf"
        title="دریافت موارد انتخاب‌شده به‌صورت یک فایل PDF قابل ذخیره، با لینک منبعِ کوتاه و قابل کلیک"
        ${hasSelection ? "" : "disabled"}>
        <span>دریافت به‌صورت PDF</span>
      </button>

      <div class="in-page-settings-separator"></div>

      <div class="in-page-settings-section-label">مرتب‌سازی نتایج</div>
      <label
        class="in-page-settings-radio"
        title="نتایج را به همان ترتیبی که در متن صفحه از بالا به پایین ظاهر شده‌اند نشان بده">
        <input type="radio" name="inPageSortMode" value="position" ${resultsSortMode === "position" ? "checked" : ""}>
        بر اساس محل وقوع
      </label>
      <label
        class="in-page-settings-radio"
        title="نتایجی را که بیشتر تکرار شده‌اند اول نشان بده">
        <input type="radio" name="inPageSortMode" value="frequency" ${resultsSortMode === "frequency" ? "checked" : ""}>
        پرتکرارترین
      </label>

      <div class="in-page-settings-separator"></div>

      <div class="in-page-settings-section-label">جست‌وجوی پیشرفته</div>
      <label
        class="in-page-settings-checkbox"
        title="کلمات عبارت جست‌وجو لازم نیست کنار هم بیایند؛ کافی است در فاصله‌ی مشخص‌شده از هم قرار داشته باشند">
        <input type="checkbox" id="inPageMenuProximityToggle" ${proximitySearchEnabled ? "checked" : ""}>
        جست‌وجوی مجاورتی (حداکثر فاصله:
        <input
          type="number"
          id="inPageMenuProximityDistance"
          class="in-page-settings-proximity-distance"
          min="1"
          max="30"
          title="حداکثر تعداد کلمات مجاز بین کلمات عبارت جست‌وجو"
          value="${proximityDistance}">
        کلمه)
      </label>
      <label
        class="in-page-settings-checkbox"
        title="جست‌وجو در متن اصلی صفحه انجام شود">
        <input type="checkbox" id="inPageMenuSearchMainText" ${searchInMainText ? "checked" : ""}>
        جست‌وجو در متن
      </label>
      <label
        class="in-page-settings-checkbox"
        title="جست‌وجو در پاورقی‌های صفحه هم انجام شود">
        <input type="checkbox" id="inPageMenuSearchFootnotes" ${searchInFootnotes ? "checked" : ""}>
        جست‌وجو در پاورقی
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
    bind("inPageMenuOpenBookmarks", () => {
      openBookmarksPanel();
      closeSettingsMenu();
    });
    bind("inPageMenuAddToBookmarks", () => {
      addSelectedToBookmarks();
      closeSettingsMenu();
    });
    bind("inPageMenuCopySelected", () => {
      handleCopySelectedMatches();
    });
    bind("inPageMenuExportText", () => {
      exportSelectedAsText();
      closeSettingsMenu();
    });
    bind("inPageMenuExportWord", () => {
      exportSelectedAsWord();
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

    // Item ح: text/footnote scope checkboxes. Unchecking one while the
    // other is already off would silently zero out every future
    // search, so that last checkbox is not allowed to uncheck itself -
    // it just snaps back on and nothing changes.
    const searchMainTextToggle = menu.querySelector("#inPageMenuSearchMainText");
    const searchFootnotesToggle = menu.querySelector("#inPageMenuSearchFootnotes");

    if (searchMainTextToggle) {
      searchMainTextToggle.addEventListener("change", () => {
        if (!searchMainTextToggle.checked && !searchInFootnotes) {
          searchMainTextToggle.checked = true;
          return;
        }

        searchInMainText = searchMainTextToggle.checked;

        const input = document.getElementById("inPageSearchInput");
        if (input && input.value.trim()) {
          performSearch();
        }
      });
    }

    if (searchFootnotesToggle) {
      searchFootnotesToggle.addEventListener("change", () => {
        if (!searchFootnotesToggle.checked && !searchInMainText) {
          searchFootnotesToggle.checked = true;
          return;
        }

        searchInFootnotes = searchFootnotesToggle.checked;

        const input = document.getElementById("inPageSearchInput");
        if (input && input.value.trim()) {
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
            `<div class="in-page-result-marker">` +
              `<span class="in-page-result-number">${index + 1}</span>` +
              `<input type="checkbox" class="in-page-result-checkbox" data-index="${index}" ${checkedAttr} aria-label="انتخاب این نتیجه">` +
            `</div>` +
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

    const selected = getSelectedMatchesInOrder();

    if (selected.length === 0) {
      return;
    }

    // Item 2: the file's own title is shown once, in a clearly
    // separated header line, rather than repeated per paragraph (all
    // selected matches necessarily come from this same page).
    // Item 3: each paragraph gets its own reference link right under
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
    // Item 8: what's pasted is now the FULL paragraph each selected
    // match lives in (deduplicated - several picks in one paragraph
    // still paste that paragraph only once), with every matched term
    // in it marked, rather than the short results-panel snippet - see
    // buildParagraphEntries above.
    const pageTitle = getPageTitle();
    const divider = "─".repeat(32);
    const header = `📘 عنوان: ${pageTitle}\n${divider}`;

    const entries = buildParagraphEntries(selected);

    const textBody = entries
      .map((entry, index) => `${index + 1}. «${entry.plainText}»\n   🔗 لینک منبع: ${entry.url}`)
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
    const htmlBody = entries
      .map((entry, index) => (
        `<p dir="ltr" style="margin:0 0 3px;font-family:Tahoma,Arial,sans-serif;` +
        `font-size:14px;line-height:1.9;color:#1f2937;text-align:right;">` +
        `<strong>${index + 1}.</strong>\u00a0«${entry.html}»</p>` +
        `<p dir="ltr" style="margin:0 0 14px;font-family:Tahoma,Arial,sans-serif;` +
        `font-size:12px;text-align:right;">🔗 ` +
        `<a href="${escapeHtml(entry.url)}" style="color:#1d4ed8;text-decoration:none;">` +
        `لینک منبع</a></p>`
      ))
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

    // Item ط (لینک داخل صفحه): shared with handleBookmarkLinkClick's
    // same-page path, which needs to parse an arbitrary link's hash
    // rather than location.hash - see extractTextFragmentFromHash.
    return extractTextFragmentFromHash(location.hash);
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
    setupSelectionBookmarking();
    renderBookmarkIndicators();

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
    input.addEventListener("focus", openSearchHistoryDropdown);
    input.addEventListener("mouseenter", openSearchHistoryDropdown);
    input.addEventListener("mouseleave", scheduleSearchHistoryHoverClose);

    const historyDropdown = document.getElementById("inPageSearchHistory");

    if (historyDropdown) {
      // Same hover-intent pair as the input, so moving the mouse from
      // the input onto the dropdown (or back) is treated as staying
      // inside one combined hover area instead of leaving it. No focus
      // or click on the input is required for any of this - hovering
      // the input opens the list, and the mousedown handler on each
      // item (see renderSearchHistoryDropdown) already lets it be
      // picked straight from a hover state.
      historyDropdown.addEventListener("mouseenter", cancelSearchHistoryHoverClose);
      historyDropdown.addEventListener("mouseleave", scheduleSearchHistoryHoverClose);
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
