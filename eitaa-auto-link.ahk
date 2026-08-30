; ============================================================================
; اسکریپت خودکارسازی لینک برای ایتا (ویندوز - AutoHotkey v2)
; ============================================================================
; کاربرد:
;   ۱. در سایت، نتایج را انتخاب و روی «کپی خودکار برای ایتا» کلیک کنید.
;   ۲. به پنجرهٔ ایتا (وب یا دسکتاپ) بروید و نشانگر را داخل باکس پیام بگذارید.
;   ۳. کلید ترکیبی Ctrl+Alt+V را بزنید.
;   ۴. اسکریپت به‌جای شما تایپ می‌کند، متن «لینک منبع» را انتخاب می‌کند،
;      Ctrl+K را می‌زند، آدرس را وارد و تأیید می‌کند - برای هر نتیجهٔ انتخاب‌شده.
;
; نکات:
;   - در حین اجرا دست به موس/کیبورد نزنید تا اسکریپت کار خودش را تمام کند.
;   - اگر Eitaa دیرتر از حد انتظار باکس لینک را باز می‌کند، مقدار
;     LINK_POPUP_DELAY_MS را زیاد کنید.
;   - نیازمند نصب AutoHotkey نسخهٔ ۲ است (نه نسخهٔ ۱).
; ============================================================================

#Requires AutoHotkey v2.0
#SingleInstance Force

; ---- تنظیمات قابل تغییر -----------------------------------------------
LINK_HOTKEY_MODS := "^"     ; "^" یعنی Ctrl. اگر ایتا از ترکیب دیگری استفاده
LINK_HOTKEY_KEY  := "k"     ; می‌کند (مثلاً Ctrl+Shift+K بنویسید "^+")، اینجا تغییر دهید.
LINK_POPUP_DELAY_MS := 400  ; مکث بعد از زدن Ctrl+K، قبل از تایپ آدرس
LINK_CONFIRM_DELAY_MS := 150 ; مکث بعد از تأیید لینک، قبل از رفتن به مورد بعدی
ITEM_GAP_LINES := 1         ; چند خط خالی بین هر نتیجه و نتیجهٔ بعدی

; ---- ثابت‌های فرمت (باید دقیقاً با کد سایت یکی باشد) --------------------
MARKER := "###EITAA-AUTO-LINKS-V1###"
FIELD_SEP := Chr(0xE000)
ITEM_SEP := Chr(0xE001)
LINK_LABEL := "لینک منبع"

^!v::PasteEitaaLinks()

PasteEitaaLinks() {
    global MARKER, FIELD_SEP, ITEM_SEP, LINK_LABEL
    global LINK_HOTKEY_MODS, LINK_HOTKEY_KEY
    global LINK_POPUP_DELAY_MS, LINK_CONFIRM_DELAY_MS, ITEM_GAP_LINES

    clip := A_Clipboard

    markerPos := InStr(clip, MARKER)
    if (!markerPos) {
        MsgBox(
            "کلیپ‌بورد شامل داده‌ی مخصوص اسکریپت ایتا نیست.`n"
            . "اول از سایت روی «کپی خودکار برای ایتا» کلیک کنید، بعد این کلید را بزنید.",
            "خطا", 48
        )
        return
    }

    afterMarker := SubStr(clip, markerPos + StrLen(MARKER))
    ; حذف اولین خط جدید بعد از مارکر (چه \n باشد چه \r\n)
    body := RegExReplace(afterMarker, "^\R", "")

    items := StrSplit(body, ITEM_SEP)

    loop items.Length {
        index := A_Index
        fields := StrSplit(items[index], FIELD_SEP)
        title   := fields.Length >= 1 ? fields[1] : ""
        snippet := fields.Length >= 2 ? fields[2] : ""
        url     := fields.Length >= 3 ? fields[3] : ""

        if (title != "") {
            SendText("——— عنوان: " . title . " ———")
            Send("{Enter}")
        }

        if (snippet != "") {
            SendText('"' . snippet . '"')
            Send("{Enter}")
        }

        SendText(LINK_LABEL)
        Send("{Home}")
        Send("+{End}")

        keyCombo := LINK_HOTKEY_MODS . LINK_HOTKEY_KEY
        Send(keyCombo)
        Sleep(LINK_POPUP_DELAY_MS)

        SendText(url)
        Send("{Enter}")
        Sleep(LINK_CONFIRM_DELAY_MS)
        Send("{End}")

        if (index < items.Length) {
            loop ITEM_GAP_LINES + 1 {
                Send("{Enter}")
            }
        }
    }
}
