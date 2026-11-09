# Run with Windows PowerShell 5.1: powershell -NoProfile -File scripts/testInstallWindows.ps1
# All writes stay inside one disposable fixture tree. No Adobe files are changed.
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $PSScriptRoot
$Tokens = $null; $ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ScriptDir 'installer\install.ps1'), [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Node in $Ast.FindAll({ param($N) $N -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($Node.Extent.Text))
}
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('TypeR-installer-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $TestRoot
$Interactive = $false
$msg_close = 'Photoshop must be closed.'
$msg_status_update = 'update {old} {new}'
$msg_status_current = 'current {new}'
$msg_status_newer = 'newer {old} {new}'
$script:CaseNumber = 0
$script:Passed = 0
$OriginalVerifier = ${function:Assert-TypeRInstalledFiles}
$OriginalSave = ${function:Save-TypeRTransaction}
function Assert-TypeRInstalledFiles([string]$Root, $Inventory) {
    & $OriginalVerifier $Root $Inventory
    if ($Root -eq $script:FailVerification) { throw 'Injected post-install verification failure' }
}
function Save-TypeRTransaction($Transaction, [string]$Journal) {
    if ($script:FailCommit -and $Transaction.State -eq 'committed') { throw 'Injected journal write failure' }
    & $OriginalSave $Transaction $Journal
}
function Get-TypeRPhotoshops { return $script:FixturePhotoshops }
function Get-Process {
    [CmdletBinding()] param([string]$Name)
    if ($script:PhotoshopRunning) { [PSCustomObject]@{ Name = 'Photoshop' } }
}
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
    $Message = $null
    try { & $Action } catch { $Message = $_.Exception.Message }
    Assert ($null -ne $Message) 'Expected an error, but the action succeeded.'
    Assert ($Message -like $Pattern) "Unexpected error: $Message (expected $Pattern)"
}
function Write-Text([string]$Path, [string]$Value) {
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}
function New-Plugin([string]$Root, [string]$Version = '3.0.0', [string]$Code = 'old') {
    Write-Text (Join-Path $Root 'manifest.json') ('{"id":"com.dryiceee.labelplus-nondum","version":"' + $Version + '","name":"TypeR","manifestVersion":5,"main":"index.html","host":{"app":"PS","minVersion":"26.0.0"}}')
    Write-Text (Join-Path $Root 'host.js') $Code
    Write-Text (Join-Path $Root 'index.html') '<html>TypeR</html>'
}
function New-Fixture {
    $script:CaseNumber++
    $script:Fixture = Join-Path $TestRoot ([string]$script:CaseNumber)
    $script:UxpRoot = Join-Path $Fixture 'Adobe UXP'
    $script:UxpPlugins = Join-Path $UxpRoot 'Plugins\External'
    $script:UxpRegistry = Join-Path $UxpRoot 'PluginsInfo\v1\PS.json'
    $script:FixturePhotoshops = @([PSCustomObject]@{ Name = 'Photoshop'; Version = '27.0'; Path = (Join-Path $Fixture 'Photoshop') })
    $script:PhotoshopRunning = $false
    $script:FailVerification = $null
    $script:FailCommit = $false
    $script:Direct = Join-Path $FixturePhotoshops[0].Path 'Plug-ins\TypeR'
    $script:Canonical = Join-Path $UxpPlugins 'com.dryiceee.labelplus-nondum_3.0.0'
    $script:Source = Join-Path $Fixture 'source'
    New-Plugin $Source '3.0.0' 'new code'
    $script:PackagePath = Join-Path $Fixture 'TypeR.ccx'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Source, $PackagePath)
}
function Test([string]$Name, [scriptblock]$Action) {
    New-Fixture
    & $Action
    $script:Passed++
    Write-Host "PASS $Name"
}
try {
    Test 'Recommendation remains available when Photoshop detection fails (develop fix)' {
        function Get-TypeRPhotoshops { throw 'Detection unavailable' }
        Update-TypeRRecommendation
        Assert ($script:Recommended -eq '' -and $script:PhotoshopList -eq '') 'Detection error prevented menu fallback'
    }
    Test 'Updater discovery includes direct copies and ignores incomplete external stages' {
        New-Plugin $Direct
        New-Plugin (Join-Path $UxpPlugins 'com.dryiceee.labelplus-nondum_3.0.0.installing')
        $Paths = @(Get-TypeRInstalledPluginPaths)
        Assert ($Paths.Count -eq 1 -and $Paths[0] -eq $Direct) 'Wrong installed plugin detection'
    }
    Test 'Installed versions come from the manifests, newest copy first' {
        New-Plugin $Direct '3.0.0'
        New-Plugin (Join-Path $UxpPlugins 'arbitrary-folder-name') '3.10.0'
        New-Plugin (Join-Path $UxpPlugins 'com.dryiceee.labelplus-nondum_3.9.0') '3.9.0'
        New-Plugin (Join-Path $UxpPlugins 'com.dryiceee.labelplus-nondum_4.0.0.installing') '4.0.0'
        Assert ((Get-TypeRPluginVersion) -eq '3.10.0') 'Wrong plugin version'
        $script:CepTarget = Join-Path $Fixture 'cep'
        Assert ((Get-TypeRLegacyVersion) -eq '') 'A missing Legacy has no version'
        Write-Text (Join-Path $CepTarget 'CSXS\manifest.xml') '<Extension Id="typer" Version="2.5.0" />'
        Assert ((Get-TypeRLegacyVersion) -eq '2.5.0') 'Wrong Legacy version'
    }
    Test 'An unreadable plugin manifest never stops the version display' {
        Write-Text (Join-Path $UxpPlugins 'broken\manifest.json') '{broken'
        Assert ((Get-TypeRPluginVersion) -eq '') 'Detection error escaped'
    }
    Test 'The menu says how an installed version compares with the archive' {
        $script:ExtVersion = '3.1.0'
        Assert ((Get-TypeRVersionStatus '') -eq '') 'Status for a version not installed'
        Assert ((Get-TypeRVersionStatus '3.0.9') -eq 'update 3.0.9 3.1.0') 'Older version'
        Assert ((Get-TypeRVersionStatus '3.1.0') -eq 'current 3.1.0') 'Same version'
        Assert ((Get-TypeRVersionStatus '3.10.0') -eq 'newer 3.10.0 3.1.0') 'Compared as text'
    }
    Test 'Fresh external install preserves other plugins and registry properties' {
        $Other = '{"schema":7,"plugins":[{"pluginId":"other","path":"other-path","extra":[1,2]}]}'
        Write-Text $UxpRegistry $Other
        Install-TypeRPluginManually $PackagePath
        Assert ((Get-Content -LiteralPath (Join-Path $Canonical 'host.js') -Raw) -eq 'new code') 'Missing new plugin'
        $Registry = Get-Content -LiteralPath $UxpRegistry -Raw | ConvertFrom-Json
        Assert ($Registry.schema -eq 7 -and $Registry.plugins.Count -eq 2 -and $Registry.plugins[0].extra.Count -eq 2) 'Other registry content changed'
        Assert ($Registry.plugins[1].versionString -eq '3.0.0') 'Version not registered'
        Assert ($Registry.plugins[1].path -ceq '$localPlugins\External\com.dryiceee.labelplus-nondum_3.0.0') 'Photoshop cannot resolve a Windows registration with forward slashes'
    }
    Test 'Same-version direct update replaces code, removes stale files, keeps backup' {
        New-Plugin $Direct
        Write-Text (Join-Path $Direct 'obsolete.js') 'stale'
        Install-TypeRPluginManually $PackagePath
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'new code') 'Old code was not replaced'
        Assert (-not (Test-Path -LiteralPath (Join-Path $Direct 'obsolete.js'))) 'Stale file survived'
        Assert (-not (Test-Path -LiteralPath $Canonical)) 'Created duplicate external install'
        $History = Get-ChildItem -LiteralPath (Join-Path $UxpRoot '.typer-installer') -Filter '*.json' | Select-Object -First 1
        $Record = Get-Content -LiteralPath $History.FullName -Raw | ConvertFrom-Json
        Assert ((Get-Content -LiteralPath (Join-Path $Record.Operations[0].Backup 'host.js') -Raw) -eq 'old') 'Backup missing'
    }
    Test 'All direct copies including nested vendor folders are updated' {
        New-Plugin $Direct
        $Nested = Join-Path $FixturePhotoshops[0].Path 'Plug-ins\Vendor\Other name'
        New-Plugin $Nested
        $SecondHost = Join-Path $Fixture 'Photoshop Beta'
        $script:FixturePhotoshops += [PSCustomObject]@{ Name = 'Beta'; Version = '28.0'; Path = $SecondHost }
        $Second = Join-Path $SecondHost 'Plug-ins\TypeR'
        New-Plugin $Second
        Install-TypeRPluginManually $PackagePath
        foreach ($Path in $Direct, $Nested, $Second) { Assert ((Get-Content -LiteralPath (Join-Path $Path 'host.js') -Raw) -eq 'new code') "Missed $Path" }
        Assert (-not @(Get-ChildItem -LiteralPath (Join-Path $FixturePhotoshops[0].Path 'Plug-ins') -Recurse -Directory -Filter '.typer-install-*').Count) 'Backup inside plugin search path'
    }
    Test 'Old external copies are retired and registry duplicates removed' {
        $Old = Join-Path $UxpPlugins 'arbitrary-folder-name'
        New-Plugin $Old '2.9.0'
        Write-Text $UxpRegistry '{"plugins":[{"pluginId":"com.dryiceee.labelplus-nondum","path":"$localPlugins/External/arbitrary-folder-name"},{"pluginId":"com.dryiceee.labelplus-nondum","path":"$localPlugins/External/missing"}]}'
        New-Plugin $Direct
        Install-TypeRPluginManually $PackagePath
        Assert (-not (Test-Path -LiteralPath $Old)) 'Old external copy still active'
        $Registry = Get-Content -LiteralPath $UxpRegistry -Raw | ConvertFrom-Json
        Assert (@($Registry.plugins).Count -eq 1) 'Duplicate registration'
        Assert (Test-Path -LiteralPath (Join-Path $Canonical 'host.js')) 'Canonical copy missing'
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'new code') 'Direct copy stale'
    }
    Test 'Bad registry stops before replacing existing files' {
        New-Plugin $Direct
        Write-Text $UxpRegistry '{broken'
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*'
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'old') 'Old code lost'
        Assert ((Get-Content -LiteralPath $UxpRegistry -Raw) -eq '{broken') 'Broken registry overwritten'
    }
    Test 'Verification failure restores every direct copy' {
        New-Plugin $Direct
        $Second = Join-Path $FixturePhotoshops[0].Path 'Plug-ins\TypeR-second'
        New-Plugin $Second '3.0.0' 'old second'
        $script:FailVerification = $Second
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Injected post-install*'
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'old') 'First copy not restored'
        Assert ((Get-Content -LiteralPath (Join-Path $Second 'host.js') -Raw) -eq 'old second') 'Second copy not restored'
        Assert (-not (Test-Path -LiteralPath (Join-Path $UxpRoot '.typer-installer\pending.json'))) 'Recovery journal not cleared'
    }
    Test 'Registry write followed by commit failure restores registry bytes and plugin' {
        New-Plugin $Canonical
        $Before = '{"unknown":true,"plugins":[{"pluginId":"com.dryiceee.labelplus-nondum","path":"$localPlugins/External/com.dryiceee.labelplus-nondum_3.0.0"}]}' + "`r`n"
        Write-Text $UxpRegistry $Before
        $script:FailCommit = $true
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Injected journal write*'
        Assert ((Get-Content -LiteralPath $UxpRegistry -Raw) -ceq $Before) 'Registry bytes changed'
        Assert ((Get-Content -LiteralPath (Join-Path $Canonical 'host.js') -Raw) -eq 'old') 'External copy not restored'
    }
    Test 'Fresh install commit failure removes new registration and new plugin' {
        $script:FailCommit = $true
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Injected journal write*'
        Assert (-not (Test-Path -LiteralPath $Canonical)) 'Failed fresh plugin remains'
        Assert (-not (Test-Path -LiteralPath $UxpRegistry)) 'Failed fresh registry remains'
    }
    Test 'Read-only registry failure restores plugin without rewriting unchanged registry' {
        New-Plugin $Canonical
        $Before = '{"plugins":[{"pluginId":"com.dryiceee.labelplus-nondum","path":"$localPlugins/External/com.dryiceee.labelplus-nondum_3.0.0"}]}'
        Write-Text $UxpRegistry $Before
        [IO.File]::SetAttributes($UxpRegistry, [IO.FileAttributes]::ReadOnly)
        try {
            Expect-Failure { Install-TypeRPluginManually $PackagePath } '*'
            Assert ((Get-Content -LiteralPath (Join-Path $Canonical 'host.js') -Raw) -eq 'old') 'Plugin not restored after registry access error'
            Assert ((Get-Content -LiteralPath $UxpRegistry -Raw) -ceq $Before) 'Read-only registry changed'
            Assert (-not (Test-Path -LiteralPath (Join-Path $UxpRoot '.typer-installer\pending.json'))) 'Spurious incomplete recovery'
        } finally { [IO.File]::SetAttributes($UxpRegistry, [IO.FileAttributes]::Normal) }
    }
    Test 'Locked plugin file causes a safe error and restores already replaced copies' {
        New-Plugin $Direct
        $Second = Join-Path $FixturePhotoshops[0].Path 'Plug-ins\TypeR-second'
        New-Plugin $Second '3.0.0' 'old second'
        $Lock = [IO.File]::Open((Join-Path $Second 'host.js'), 'Open', 'Read', 'None')
        try { Expect-Failure { Install-TypeRPluginManually $PackagePath } '*' } finally { $Lock.Dispose() }
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'old') 'First copy not restored after file lock'
        Assert ((Get-Content -LiteralPath (Join-Path $Second 'host.js') -Raw) -eq 'old second') 'Locked copy changed'
    }
    Test 'Empty registry is restored as an existing empty file' {
        Write-Text $UxpRegistry ''
        $script:FailCommit = $true
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Injected journal write*'
        Assert ((Test-Path -LiteralPath $UxpRegistry) -and (Get-Item -LiteralPath $UxpRegistry).Length -eq 0) 'Empty original registry lost'
    }
    Test 'Concurrent installer lock prevents changes' {
        $Control = Join-Path $UxpRoot '.typer-installer'
        $null = New-Item -ItemType Directory -Path $Control -Force
        $Lock = [IO.File]::Open((Join-Path $Control 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        try { Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Another TypeR installation*' } finally { $Lock.Dispose() }
        Assert (-not (Test-Path -LiteralPath $Canonical)) 'Plugin changed under lock'
    }
    Test 'Open Photoshop blocks installation before writing installer state' {
        $script:PhotoshopRunning = $true
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Photoshop must be closed*'
        Assert (-not (Test-Path -LiteralPath $UxpRoot)) 'Wrote state while Photoshop open'
    }
    Test 'Incompatible Photoshop rejects UXP' {
        $script:FixturePhotoshops[0].Version = '25.0'
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*No compatible Photoshop*'
        Assert (-not (Test-Path -LiteralPath $Canonical)) 'Incompatible plugin installed'
    }
    Test 'Photoshop 26.0 meets a 26.0.0 minimum version' {
        $script:FixturePhotoshops[0].Version = '26.0'
        Install-TypeRPluginManually $PackagePath
        Assert (Test-Path -LiteralPath (Join-Path $Canonical 'host.js')) 'Equivalent version was rejected'
    }
    Test 'Unrelated plugin at target is preserved' {
        New-Plugin $Canonical
        $File = Join-Path $Canonical 'manifest.json'
        Write-Text $File ((Get-Content -LiteralPath $File -Raw).Replace('com.dryiceee.labelplus-nondum', 'another.plugin'))
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*belongs to another plugin*'
        Assert ((Get-Content -LiteralPath $File -Raw) -match 'another.plugin') 'Unrelated plugin lost'
    }
    Test 'Archive path traversal is rejected before extraction' {
        $Zip = [IO.Compression.ZipFile]::Open($PackagePath, 'Update')
        try { $null = $Zip.CreateEntry('../escape.txt') } finally { $Zip.Dispose() }
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Unsafe*package path*'
        Assert (-not (Test-Path -LiteralPath (Join-Path $Fixture 'escape.txt'))) 'Archive escaped'
    }
    Test 'Case-insensitive archive collisions are rejected' {
        $Zip = [IO.Compression.ZipFile]::Open($PackagePath, 'Update')
        try { $null = $Zip.CreateEntry('HOST.js') } finally { $Zip.Dispose() }
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*duplicate package path*'
    }
    Test 'Incomplete package cannot replace old plugin' {
        New-Plugin $Direct
        $Zip = [IO.Compression.ZipFile]::Open($PackagePath, 'Update')
        try { $Zip.GetEntry('host.js').Delete() } finally { $Zip.Dispose() }
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*Incomplete TypeR package*'
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'old') 'Old plugin changed'
    }
    Test 'Interrupted swap is recovered from durable journal on next launch' {
        New-Plugin $Direct
        $Control = Join-Path $UxpRoot '.typer-installer'
        $null = New-Item -ItemType Directory -Path $Control -Force
        $Id = [Guid]::NewGuid().ToString('N')
        $Workspace = Get-TypeRWorkspace $Direct $Id
        $null = New-Item -ItemType Directory -Path $Workspace
        $Operation = [PSCustomObject]@{ Index = 0; Target = $Direct; Workspace = $Workspace; Backup = (Join-Path $Workspace 'backup-0'); Stage = (Join-Path $Workspace 'stage-0'); HadTarget = $true; Pending = $true; Retire = $false }
        $Before = '{"plugins":[],"retained":42}'
        Write-Text $UxpRegistry $Before
        $After = '{"plugins":[]}'
        $Record = [PSCustomObject]@{ Id = $Id; State = 'preparing'; Operations = @($Operation); RegistryPath = $UxpRegistry; RegistryBefore = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Before)); RegistryAfter = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($After)); RegistryExisted = $true; RegistryPending = $true }
        Save-TypeRTransaction $Record (Join-Path $Control 'pending.json')
        [IO.Directory]::Move($Direct, $Operation.Backup)
        New-Plugin $Direct '3.0.0' 'interrupted code'
        Write-Text $UxpRegistry $After
        Write-Text $PackagePath 'bad zip'
        Expect-Failure { Install-TypeRPluginManually $PackagePath } '*'
        Assert ((Get-Content -LiteralPath (Join-Path $Direct 'host.js') -Raw) -eq 'old') 'Interrupted swap not recovered'
        Assert ((Get-Content -LiteralPath $UxpRegistry -Raw) -ceq $Before) 'Interrupted registry not recovered'
        Assert (-not (Test-Path -LiteralPath (Join-Path $Control 'pending.json'))) 'Recovery journal left behind'
    }
    $RealPackage = Join-Path $ScriptDir 'Releases\UXP-Windows.ccx'
    if (Test-Path -LiteralPath $RealPackage) {
      Test 'Real distributed CCX extracts and verifies all packaged files' {
        $Root = Join-Path $Fixture 'real-package'
        $Payload = Expand-TypeRPackage $RealPackage $Root
        Assert-TypeRInstalledFiles $Root $Payload.Inventory
        Assert ($Payload.Inventory.Count -gt 40) 'Real package not fully checked'
      }
    } else {
        Write-Host 'SKIP real CCX verification: run npm run package:uxp to generate the release artifact.'
    }
    Write-Host "$Passed tests passed."
} finally {
    $Full = [IO.Path]::GetFullPath($TestRoot)
    $TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $Full.StartsWith($TempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $Full) -notlike 'TypeR-installer-tests-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $Full -Recurse -Force
}
