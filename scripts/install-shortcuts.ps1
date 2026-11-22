$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$newName = 'Pocket Scribe Desktop'
$oldName = 'KT Scribe'
$target = Join-Path $root "$newName.exe"
$oldTarget = Join-Path $root "$oldName.exe"
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Build $newName.exe before installing shortcuts."
}

$locations = @(
    [Environment]::GetFolderPath('DesktopDirectory'),
    [Environment]::GetFolderPath('Programs')
)
$windowsShell = New-Object -ComObject WScript.Shell
foreach ($location in $locations) {
    if ([string]::IsNullOrWhiteSpace($location) -or -not (Test-Path -LiteralPath $location -PathType Container)) {
        continue
    }

    $newPath = Join-Path $location "$newName.lnk"
    $legacyPath = Join-Path $location "$oldName.lnk"
    if ((Test-Path -LiteralPath $legacyPath -PathType Leaf) -and
        -not (Test-Path -LiteralPath $newPath)) {
        $legacy = $windowsShell.CreateShortcut($legacyPath)
        if ($legacy.TargetPath -eq $oldTarget) {
            Move-Item -LiteralPath $legacyPath -Destination $newPath
        }
    }

    $shortcut = $windowsShell.CreateShortcut($newPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = Join-Path $root 'pocket-scribe.ico'
    $shortcut.Description = 'Pocket Scribe Desktop'
    $shortcut.Save()
}
