Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\desk\order-pool"
WshShell.Run "node app.js", 0, False
