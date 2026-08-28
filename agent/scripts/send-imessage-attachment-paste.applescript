-- AppleScript's own `send (POSIX file ...) to buddy` command has been
-- confirmed (via live testing) to hang indefinitely mid-upload on this
-- machine regardless of file format (PNG and HEIC both stuck), while
-- manually dragging the exact same file into the compose window and hitting
-- send delivers instantly. Drag-and-drop and clipboard-paste both attach a
-- file the same way under the hood, so this automates the paste instead:
-- put a real file reference on the clipboard (the same thing Finder's Cmd-C
-- does), bring the right conversation to the front via the imessage: URL
-- scheme (handled by the caller before this script runs), then paste and
-- send via keystrokes. Requires the same Accessibility permission already
-- granted for FaceTime window-title reading (System Events driving another
-- app's UI).
on run argv
    set targetHandle to item 1 of argv
    set filePath to item 2 of argv

    tell application "Finder" to set the clipboard to (POSIX file filePath as alias)
    delay 0.5

    tell application "Messages" to activate
    delay 1

    tell application "System Events"
        tell process "Messages"
            set frontmost to true
            keystroke "v" using {command down}
            delay 2
            keystroke return
        end tell
    end tell
end run
