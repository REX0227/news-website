Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c node ""c:\projects\gecko\schedule_website_v0_1\backend\server.js"" >> ""c:\projects\gecko\schedule_website_v0_1\logs\server.log"" 2>&1", 0, False
