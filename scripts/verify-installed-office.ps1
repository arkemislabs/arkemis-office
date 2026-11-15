param([string]$FixtureDirectory=(Join-Path $PSScriptRoot '..\artifacts\office'),[ValidateSet('all','word','excel','powerpoint')][string]$Only='all')
$ErrorActionPreference='Stop'
$fixtureRoot=(Resolve-Path -LiteralPath $FixtureDirectory).Path
$report=[ordered]@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');word=$null;excel=$null;powerpoint=$null}
# Only generated fixtures are opened. Never attach to or save user documents.
if($Only -in @('all','word')){
Write-Output 'Starting generated DOCX validation in Word'
$word=$null;$document=$null
try {
 $word=New-Object -ComObject Word.Application
 $word.Visible=$false;$word.DisplayAlerts=0;$word.AutomationSecurity=3
 $document=$word.Documents.Open((Join-Path $fixtureRoot 'quill.docx'),$false,$true,$false)
 $text=$document.Content.Text
 if($text -notmatch 'This document was written by Quill'){throw 'Word text mismatch'}
 $document.ExportAsFixedFormat((Join-Path $fixtureRoot 'word-render.pdf'),17)
 $report.word=@{version=$word.Version;opened=$true;paragraphs=$document.Paragraphs.Count;text=$text;pdf='word-render.pdf'}
} catch {$report.word=@{error=$_.Exception.Message}} finally {if($document){$document.Close(0)};if($word){$word.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)}}
}
if($Only -in @('all','excel')){
Write-Output 'Starting generated XLSX validation in Excel'
$excel=$null;$workbook=$null
try {
 $excel=New-Object -ComObject Excel.Application
 $excel.Visible=$false;$excel.DisplayAlerts=$false;$excel.AutomationSecurity=3
 $workbook=$excel.Workbooks.Open((Join-Path $fixtureRoot 'grid.xlsx'),0,$true)
 $excel.CalculateFullRebuild()
 $sheet=$workbook.Worksheets.Item(1)
 $values=@{};foreach($address in @('A3','A4','A5','A6')){$values[$address]=$sheet.Range($address).Value2}
 if($values.A3 -ne 42){throw 'Excel SUM mismatch'}
 $report.excel=@{version=$excel.Version;opened=$true;values=$values}
} catch {$report.excel=@{error=$_.Exception.Message}} finally {if($workbook){$workbook.Close($false)};if($excel){$excel.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)}}
}
if($Only -in @('all','powerpoint')){
Write-Output 'Starting generated PPTX validation in PowerPoint'
$powerpoint=$null;$presentation=$null
$existingPowerPoint=@(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
try {
 $powerpoint=New-Object -ComObject PowerPoint.Application
 $presentation=$powerpoint.Presentations.Open((Join-Path $fixtureRoot 'prism.pptx'),-1,0,0)
 $slide=$presentation.Slides.Item(1)
 $slide.Export((Join-Path $fixtureRoot 'powerpoint-slide.png'),'PNG',1280,720)
 $shape=$slide.Shapes.Item(1)
 if($shape.TextFrame.TextRange.Text -notmatch 'A new perspective'){throw 'PowerPoint text mismatch'}
 $report.powerpoint=@{version=$powerpoint.Version;opened=$true;slides=$presentation.Slides.Count;width=$presentation.PageSetup.SlideWidth;height=$presentation.PageSetup.SlideHeight;firstShape=@{left=$shape.Left;top=$shape.Top;width=$shape.Width;height=$shape.Height;fontSize=$shape.TextFrame.TextRange.Font.Size};render='powerpoint-slide.png'}
} catch {$report.powerpoint=@{error=$_.Exception.Message}} finally {if($presentation){$presentation.Close()};if($powerpoint){if(!$existingPowerPoint){$powerpoint.Quit()};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerpoint)}}
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $fixtureRoot "installed-$Only-report.json") -Encoding utf8
$report | ConvertTo-Json -Depth 6
if($report.word.error -or $report.excel.error -or $report.powerpoint.error){exit 1}
