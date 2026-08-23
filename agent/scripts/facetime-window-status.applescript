-- Best-effort call-state signal: FaceTime has no scriptable dictionary or
-- public call-state API, so this reads the title of its frontmost window via
-- System Events (Accessibility). Not documented by Apple -- title text can
-- change between macOS versions or locales. Returns "NO_WINDOW" if FaceTime
-- has no open window (call ended/closed) or isn't running.
on run argv
    tell application "System Events"
        if not (exists process "FaceTime") then
            return "NOT_RUNNING"
        end if
        tell process "FaceTime"
            if (count of windows) = 0 then
                return "NO_WINDOW"
            end if
            return name of window 1
        end tell
    end tell
end run
