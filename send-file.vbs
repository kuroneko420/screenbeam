' screenbeam - Power Automate Desktop sender
'
' For locked-down environments where browser file uploads and command
' prompt are disabled. This script reads a file at the OS level via
' ADODB.Stream, base64-encodes it, injects it into sender.html, and
' opens the result in the default browser. The browser never opens a
' file picker; the file is already embedded in the page.
'
' Setup in Power Automate Desktop (3 actions):
'
'   Action 1: "Display select file dialog"
'     - Dialog title: Select file to transfer
'     - File filter: All files (*.*)|*.*
'     - Store result in: %SelectedFile%
'
'   Action 2: "Set variable"
'     - Set %SenderPath% to the location of sender.html
'       e.g. C:\Users\YourName\Desktop\sender.html
'
'   Action 3: "Run VBScript"
'     - Paste this entire script into the code box.
'     - PAD substitutes %SelectedFile% and %SenderPath% with their
'       values before running. No command line arguments needed.
'
' You can also run this from cscript if command prompt is available:
'   cscript send-file.vbs "C:\path\to\file.pdf" "C:\path\to\sender.html"

Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")

' When run from PAD, these %variables% are replaced before execution.
' When run from cscript, they stay as literal strings and we fall
' through to WScript.Arguments instead.
Dim filePath
Dim senderPath

If InStr("%SelectedFile%", "%") = 0 Then
  filePath = "%SelectedFile%"
  senderPath = "%SenderPath%"
Else
  filePath = WScript.Arguments(0)
  If WScript.Arguments.Count > 1 Then
    senderPath = WScript.Arguments(1)
  Else
    senderPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "sender.html")
    If Not fso.FileExists(senderPath) Then
      senderPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "dist\sender.html")
    End If
  End If
End If

If Not fso.FileExists(filePath) Then
  WScript.Echo "File not found: " & filePath
  WScript.Quit 1
End If

If Not fso.FileExists(senderPath) Then
  WScript.Echo "sender.html not found at: " & senderPath
  WScript.Quit 1
End If

Dim fileName
fileName = fso.GetFileName(filePath)

' Read file as binary via ADODB.Stream
Dim stream
Set stream = CreateObject("ADODB.Stream")
stream.Type = 1
stream.Open
stream.LoadFromFile filePath
Dim fileBytes
fileBytes = stream.Read
stream.Close

' Base64 encode via MSXML DOM node
Dim xml
Set xml = CreateObject("MSXML2.DOMDocument.6.0")
Dim node
Set node = xml.createElement("b64")
node.DataType = "bin.base64"
node.NodeTypedValue = fileBytes
Dim b64
b64 = Replace(Replace(node.Text, vbCr, ""), vbLf, "")

' Read sender.html
Dim htmlFile
Set htmlFile = fso.OpenTextFile(senderPath, 1)
Dim html
html = htmlFile.ReadAll
htmlFile.Close

' Inject the file payload as a JS global before </body>.
' The sender checks for window.__SCREENBEAM__ on startup and
' skips the file picker if it exists.
Dim injection
injection = "<script>window.__SCREENBEAM__={data:""" & b64 & """,filename:""" & fileName & """};</script>"
html = Replace(html, "</body>", injection & vbCrLf & "</body>")

' Write to temp folder and open in default browser
Dim tempPath
tempPath = fso.BuildPath(fso.GetSpecialFolder(2), "screenbeam-send.html")
Dim outFile
Set outFile = fso.CreateTextFile(tempPath, True)
outFile.Write html
outFile.Close

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run tempPath
