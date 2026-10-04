<#
.SYNOPSIS
    Converts Markdown (.md) files into formatted Microsoft Word (.docx) documents
    using Word COM automation.

.DESCRIPTION
    Supports:
      - Headings: #, ##, ###, ####
      - Paragraphs
      - Bullet lists: "- " or "* "
      - Numbered lists: "1. "
      - Tables: GitHub-style pipe tables
      - Inline bold: **text**
      - Horizontal rule "---" => page break

.PARAMETER InputPath
    Folder containing .md files (default: .\markdown next to this script).

.PARAMETER OutputPath
    Folder to write .docx files (default: .\word next to this script).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Convert-MdToDocx.ps1
#>

param(
    [string]$InputPath,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $InputPath)  { $InputPath  = Join-Path $scriptDir "markdown" }
if (-not $OutputPath) { $OutputPath = Join-Path $scriptDir "word" }

if (-not (Test-Path $InputPath)) {
    Write-Error "Input folder not found: $InputPath"
    return
}
if (-not (Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath | Out-Null
}

# Word style name constants
$wdStyleNormal = "Normal"

function Add-InlineText {
    param($Range, [string]$Text)
    # Parse **bold** segments and apply formatting.
    $parts = [regex]::Split($Text, '(\*\*)')
    $bold = $false
    foreach ($p in $parts) {
        if ($p -eq '**') { $bold = -not $bold; continue }
        if ($p -eq '')   { continue }
        $start = $Range.End
        $Range.InsertAfter($p)
        $Range.Start = $start
        $Range.Font.Bold = if ($bold) { $true } else { $false }
        $Range.Start = $Range.End
    }
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0  # wdAlertsNone

try {
    $mdFiles = Get-ChildItem -Path $InputPath -Filter *.md | Sort-Object Name
    if (-not $mdFiles) { Write-Warning "No .md files found in $InputPath"; return }

    foreach ($file in $mdFiles) {
        Write-Host "Converting $($file.Name) ..."
        $lines = Get-Content -LiteralPath $file.FullName -Encoding UTF8
        $doc = $word.Documents.Add()
        $sel = $word.Selection

        $i = 0
        while ($i -lt $lines.Count) {
            $line = $lines[$i]
            $trim = $line.TrimEnd()

            # Blank line
            if ([string]::IsNullOrWhiteSpace($trim)) { $i++; continue }

            # Horizontal rule => page break
            if ($trim -match '^\s*---+\s*$') {
                $sel.InsertBreak(7)  # wdPageBreak
                $i++; continue
            }

            # Table block (line starts with | and next line is a separator)
            if ($trim -match '^\s*\|' -and ($i + 1) -lt $lines.Count -and $lines[$i+1] -match '^\s*\|?[\s:\-\|]+\|?\s*$') {
                $tableLines = @()
                while ($i -lt $lines.Count -and $lines[$i].TrimEnd() -match '^\s*\|') {
                    $tableLines += $lines[$i].Trim()
                    $i++
                }
                # Parse rows (skip separator row at index 1)
                $rows = @()
                for ($r = 0; $r -lt $tableLines.Count; $r++) {
                    if ($r -eq 1) { continue }
                    $cells = $tableLines[$r].Trim('|').Split('|') | ForEach-Object { $_.Trim() }
                    $rows += ,$cells
                }
                $numRows = $rows.Count
                $numCols = ($rows[0]).Count
                $range = $sel.Range
                $tbl = $doc.Tables.Add($range, $numRows, $numCols)
                $tbl.Borders.Enable = $true
                $tbl.Style = "Table Grid"
                for ($r = 0; $r -lt $numRows; $r++) {
                    for ($c = 0; $c -lt $numCols; $c++) {
                        $cellRange = $tbl.Cell($r+1, $c+1).Range
                        $val = if ($c -lt $rows[$r].Count) { $rows[$r][$c] } else { "" }
                        Add-InlineText -Range $cellRange -Text $val
                        if ($r -eq 0) { $tbl.Cell($r+1,$c+1).Range.Font.Bold = $true }
                    }
                }
                # Move selection past the table
                $sel.EndKey(6) | Out-Null  # wdStory
                $sel.TypeParagraph()
                continue
            }

            # Headings
            if ($trim -match '^(#{1,6})\s+(.*)$') {
                $level = $matches[1].Length
                $text  = $matches[2].Trim()
                if ($level -eq 1) { $sel.Style = $doc.Styles.Item("Title") }
                else { $sel.Style = $doc.Styles.Item("Heading " + ($level - 1)) }
                Add-InlineText -Range $sel.Range -Text $text
                $sel.Collapse(0) | Out-Null
                $sel.TypeParagraph()
                $sel.Style = $doc.Styles.Item($wdStyleNormal)
                $i++; continue
            }

            # Bullet list
            if ($trim -match '^\s*[-\*]\s+(.*)$') {
                $sel.Style = $doc.Styles.Item("List Bullet")
                Add-InlineText -Range $sel.Range -Text ($matches[1].Trim())
                $sel.Collapse(0) | Out-Null
                $sel.TypeParagraph()
                $sel.Style = $doc.Styles.Item($wdStyleNormal)
                $i++; continue
            }

            # Numbered list
            if ($trim -match '^\s*\d+\.\s+(.*)$') {
                $sel.Style = $doc.Styles.Item("List Number")
                Add-InlineText -Range $sel.Range -Text ($matches[1].Trim())
                $sel.Collapse(0) | Out-Null
                $sel.TypeParagraph()
                $sel.Style = $doc.Styles.Item($wdStyleNormal)
                $i++; continue
            }

            # Normal paragraph
            $sel.Style = $doc.Styles.Item($wdStyleNormal)
            Add-InlineText -Range $sel.Range -Text $trim
            $sel.TypeParagraph()
            $i++
        }

        $outFile = [string](Join-Path $OutputPath ($file.BaseName + ".docx"))
        # 16 = wdFormatDocumentDefault (.docx)
        $doc.SaveAs2($outFile, 16)
        $doc.Close()
        Write-Host "  -> $outFile"
    }
}
finally {
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

Write-Host "Done."
