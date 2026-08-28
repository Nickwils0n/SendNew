-- AppleScript's own `send (POSIX file ...) to buddy` command has been
-- confirmed (via live testing) to hang indefinitely mid-upload on this
-- machine regardless of file format (PNG and HEIC both stuck), while
-- manually dragging the exact same file into the compose window and hitting
-- send delivers instantly. Drag-and-drop and clipboard-paste both attach a
-- file the same way under the hood, so this automates that instead: bring
-- the right conversation to the front via the imessage: URL scheme
-- (handled by the caller before this script runs), then reveal and select
-- the file in Finder and issue a real Cmd-C, before pasting into Messages
-- and sending.
--
-- Confirmed via live testing that AppleScript's `set the clipboard to
-- (file as alias)` writes *something* to the pasteboard (clipboard info
-- shows a real file alias present) but Messages doesn't recognize it as
-- pasteable attachment content -- a genuine Finder Cmd-C puts multiple
-- richer data representations on the pasteboard that a bare alias write
-- doesn't. Driving Finder's actual copy command instead reproduces exactly
-- what your hands do during a manual drag-and-drop/copy-paste, which is the
-- one path proven to work end-to-end on this Mac. Requires the same
-- Accessibility permission already granted for FaceTime window-title
-- reading (System Events driving another app's UI).
on run argv
    set targetHandle to item 1 of argv
    set filePath to item 2 of argv
    set fileAlias to (POSIX file filePath) as alias

    tell application "Finder"
        activate
        reveal fileAlias
        select fileAlias
    end tell
    delay 0.5

    tell application "System Events"
        tell process "Finder"
            keystroke "c" using {command down}
        end tell
    end tell
    delay 0.5

    tell application "Messages" to activate
    delay 1

    tell application "System Events"
        tell process "Messages"
            set frontmost to true
            delay 0.3
            click menu item "Paste" of menu "Edit" of menu bar 1
            delay 2
            keystroke return
        end tell
    end tell
end run
