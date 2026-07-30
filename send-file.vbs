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
'     - Paste everything below the dashed line into the code box.
'     - PAD replaces %SelectedFile% and %SenderPath% with their
'       values before running.
'
' ---------------------------------------------------------------

Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")

Dim filePath
filePath = "%SelectedFile%"

Dim senderPath
senderPath = "%SenderPath%"

If Not fso.FileExists(filePath) Then
  MsgBox "File not found: " & filePath, vbCritical, "screenbeam"
  WScript.Quit 1
End If

If Not fso.FileExists(senderPath) Then
  MsgBox "sender.html not found at: " & senderPath, vbCritical, "screenbeam"
  WScript.Quit 1
End If

Dim fileName
fileName = fso.GetFileName(filePath)

Dim stream
Set stream = CreateObject("ADODB.Stream")
stream.Type = 1
stream.Open
stream.LoadFromFile filePath
Dim fileBytes
fileBytes = stream.Read
stream.Close

Dim xml
Set xml = CreateObject("MSXML2.DOMDocument.6.0")
Dim node
Set node = xml.createElement("b64")
node.DataType = "bin.base64"
node.NodeTypedValue = fileBytes
Dim b64
b64 = Replace(Replace(node.Text, vbCr, ""), vbLf, "")

Dim htmlFile
Set htmlFile = fso.OpenTextFile(senderPath, 1)
Dim html
html = htmlFile.ReadAll
htmlFile.Close

Dim injection
injection = "<script>window.__SCREENBEAM__={data:""" & b64 & """,filename:""" & fileName & """};</script>"
html = Replace(html, "<script>", injection & vbCrLf & "<script>", 1, 1)

Dim tempPath
tempPath = fso.BuildPath(fso.GetSpecialFolder(2), "screenbeam-send.html")
Dim outFile
Set outFile = fso.CreateTextFile(tempPath, True)
outFile.Write html
outFile.Close

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run tempPath
