param([string[]]$Files)
$failed = 0
foreach ($file in $Files) {
    $path = (Resolve-Path $file).Path
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $failed++
        Write-Host "FAIL $file"
        foreach ($e in $errors) { Write-Host ("  line " + $e.Extent.StartLineNumber + ": " + $e.Message) }
    }
    else {
        Write-Host "OK   $file"
    }
}
if ($failed -gt 0) { exit 1 }
