on run argv
    set targetHandle to item 1 of argv
    set filePath to item 2 of argv

    tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy targetHandle of targetService
        send (POSIX file filePath) to targetBuddy
    end tell
end run
