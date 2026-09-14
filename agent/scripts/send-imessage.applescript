-- Forcing iMessage exclusively (the original behavior) meant a recipient
-- who isn't iMessage-reachable always failed outright through the CRM,
-- even on a Mac mini that does have SMS relay available via "Text Message
-- Forwarding" from a paired iPhone -- confirmed via live testing that
-- composing the exact same message manually in Messages.app on this same
-- Mac correctly falls back to SMS and delivers fine. Messages.app's own UI
-- does this automatically; this mirrors that instead of hardcoding one
-- service.
on run argv
    set targetHandle to item 1 of argv
    set messageBody to item 2 of argv

    tell application "Messages"
        set sentOk to false

        try
            set imessageService to 1st service whose service type = iMessage
            send messageBody to buddy targetHandle of imessageService
            set sentOk to true
        end try

        if not sentOk then
            set smsService to 1st service whose service type = SMS
            send messageBody to buddy targetHandle of smsService
        end if
    end tell
end run
