Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Web

function Read-Docx($path) {
    $dir = [System.IO.Path]::Combine($env:TEMP, [System.Guid]::NewGuid().ToString())
    [System.IO.Compression.ZipFile]::ExtractToDirectory($path, $dir)
    $xml = Get-Content (Join-Path $dir 'word/document.xml') -Raw
    $xml = $xml -replace '</w:p>', "`n"
    $text = [System.Text.RegularExpressions.Regex]::Replace($xml, '<[^>]+>', '')
    $decoded = [System.Web.HttpUtility]::HtmlDecode($text)
    Remove-Item $dir -Recurse -Force
    return $decoded
}

$base = 'c:\Users\USER\Desktop\pharma marketplace\bussiness analysis'
(Read-Docx (Join-Path $base 'problem statement.docx')) | Out-File -FilePath (Join-Path $base 'problem_statement.txt') -Encoding utf8
(Read-Docx (Join-Path $base 'project vision.docx')) | Out-File -FilePath (Join-Path $base 'project_vision.txt') -Encoding utf8
Write-Output 'DONE'
