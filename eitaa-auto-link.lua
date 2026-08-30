-- ============================================================================
-- اسکریپت خودکارسازی لینک برای ایتا (مک - Hammerspoon)
-- ============================================================================
-- نصب:
--   ۱. برنامهٔ Hammerspoon را نصب کنید (hammerspoon.org) و دسترسی
--      Accessibility را در تنظیمات سیستم به آن بدهید.
--   ۲. محتوای همین فایل را داخل ~/.hammerspoon/init.lua کپی کنید (یا با
--      require از یک فایل جدا در init.lua صدا بزنید) و Hammerspoon را
--      Reload کنید.
--
-- کاربرد:
--   ۱. در سایت، نتایج را انتخاب و روی «کپی خودکار برای ایتا» کلیک کنید.
--   ۲. به پنجرهٔ ایتا (وب یا دسکتاپ) بروید و نشانگر را داخل باکس پیام بگذارید.
--   ۳. کلید F9 را بزنید.
--   ۴. اسکریپت به‌جای شما تایپ می‌کند، متن «لینک منبع» را انتخاب می‌کند،
--      کلید لینک ایتا را می‌زند، آدرس را وارد و تأیید می‌کند - برای هر
--      نتیجهٔ انتخاب‌شده.
--
-- نکات:
--   - در حین اجرا دست به موس/کیبورد نزنید تا اسکریپت کار خودش را تمام کند.
--   - اگر ایتا روی مک به‌جای Ctrl+K از Cmd+K استفاده می‌کند، مقدار
--     LINK_HOTKEY_MODS را در پایین به {"cmd"} تغییر دهید.
--   - اگر ایتا دیرتر از حد انتظار باکس لینک را باز می‌کند، مقدار
--     LINK_POPUP_DELAY را زیاد کنید.
-- ============================================================================

-- ---- تنظیمات قابل تغییر ---------------------------------------------------
local LINK_HOTKEY_MODS = {"ctrl"}   -- اگر ایتا Cmd+K می‌خواهد: {"cmd"}
local LINK_HOTKEY_KEY  = "k"
local LINK_POPUP_DELAY = 0.4        -- ثانیه، مکث بعد از زدن کلید لینک
local LINK_CONFIRM_DELAY = 0.15     -- ثانیه، مکث بعد از تأیید لینک
local ITEM_GAP_LINES = 1            -- چند خط خالی بین هر نتیجه و نتیجهٔ بعدی

-- ---- ثابت‌های فرمت (باید دقیقاً با کد سایت یکی باشد) ----------------------
local MARKER = "###EITAA-AUTO-LINKS-V1###"
local FIELD_SEP = utf8.char(0xE000)
local ITEM_SEP = utf8.char(0xE001)
local LINK_LABEL = "لینک منبع"

local function splitOn(str, sep)
  local parts = {}
  local start = 1
  while true do
    local sIdx, eIdx = str:find(sep, start, true)
    if not sIdx then
      table.insert(parts, str:sub(start))
      break
    end
    table.insert(parts, str:sub(start, sIdx - 1))
    start = eIdx + 1
  end
  return parts
end

local function pasteEitaaLinks()
  local clip = hs.pasteboard.getContents()

  if not clip then
    hs.alert.show("کلیپ‌بورد خالی است.")
    return
  end

  local sIdx, eIdx = clip:find(MARKER, 1, true)
  if not sIdx then
    hs.alert.show("کلیپ‌بورد شامل داده‌ی مخصوص اسکریپت ایتا نیست.")
    return
  end

  local afterMarker = clip:sub(eIdx + 1)
  -- حذف اولین خط جدید بعد از مارکر (چه \n باشد چه \r\n)
  local body = (afterMarker:gsub("^\r?\n", ""))

  local items = splitOn(body, ITEM_SEP)

  for i, item in ipairs(items) do
    local fields = splitOn(item, FIELD_SEP)
    local title = fields[1] or ""
    local snippet = fields[2] or ""
    local url = fields[3] or ""

    if title ~= "" then
      hs.eventtap.keyStrokes("——— عنوان: " .. title .. " ———")
      hs.eventtap.keyStroke({}, "return")
    end

    if snippet ~= "" then
      hs.eventtap.keyStrokes('"' .. snippet .. '"')
      hs.eventtap.keyStroke({}, "return")
    end

    hs.eventtap.keyStrokes(LINK_LABEL)
    hs.eventtap.keyStroke({}, "home")
    hs.eventtap.keyStroke({"shift"}, "end")

    hs.eventtap.keyStroke(LINK_HOTKEY_MODS, LINK_HOTKEY_KEY)
    hs.timer.usleep(LINK_POPUP_DELAY * 1000000)

    hs.eventtap.keyStrokes(url)
    hs.eventtap.keyStroke({}, "return")
    hs.timer.usleep(LINK_CONFIRM_DELAY * 1000000)
    hs.eventtap.keyStroke({}, "end")

    if i < #items then
      for _ = 1, ITEM_GAP_LINES + 1 do
        hs.eventtap.keyStroke({}, "return")
      end
    end
  end
end

hs.hotkey.bind({}, "F9", pasteEitaaLinks)

hs.alert.show("اسکریپت خودکارسازی ایتا بارگذاری شد (F9)")
