' screenbeam PAD helper
' Usage in Power Automate Desktop:
'   1. "Display select file dialog" -> store path in %FilePath%
'   2. "Run VBScript" with this script, input variable %FilePath%
'
' This reads the file, base64-encodes it, injects it into sender.html,
' and opens the result in the default browser.
'
' Expects sender.html in the same folder as this script.

Dim filePath
filePath = WScript.Arguments(0)

Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")

If Not fso.FileExists(filePath) Then
  WScript.Echo "File not found: " & filePath
  WScript.Quit 1
End If

Dim fileName
fileName = fso.GetFileName(filePath)

' Read file as binary
Dim stream
Set stream = CreateObject("ADODB.Stream")
stream.Type = 1 ' binary
stream.Open
stream.LoadFromFile filePath
Dim fileBytes
fileBytes = stream.Read
stream.Close

' Base64 encode
Dim xml
Set xml = CreateObject("MSXML2.DOMDocument.6.0")
Dim node
Set node = xml.createElement("b64")
node.DataType = "bin.base64"
node.NodeTypedValue = fileBytes
Dim b64
b64 = Replace(Replace(node.Text, vbCr, ""), vbLf, "")

' Read sender.html from same directory as this script
Dim scriptDir
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Dim senderPath
senderPath = fso.BuildPath(scriptDir, "sender.html")

If Not fso.FileExists(senderPath) Then
  ' Try dist subfolder
  senderPath = fso.BuildPath(scriptDir, "dist\sender.html")
End If

If Not fso.FileExists(senderPath) Then
  WScript.Echo "sender.html not found next to this script or in dist\"
  WScript.Quit 1
End If

Dim htmlFile
Set htmlFile = fso.OpenTextFile(senderPath, 1) ' read
Dim html
html = htmlFile.ReadAll
htmlFile.Close

' Inject payload before </body>
Dim injection
injection = "<script>window.__SCREENBEAM__={data:""" & b64 & """,filename:""" & Replace(fileName, """", "\""") & """};</script>"
html = Replace(html, "</body>", injection & vbCrLf & "</body>")

' Write temp HTML
Dim tempPath
tempPath = fso.BuildPath(fso.GetSpecialFolder(2), "screenbeam-send.html")
Dim outFile
Set outFile = fso.CreateTextFile(tempPath, True)
outFile.Write html
outFile.Close

' Open in default browser
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run tempPath
