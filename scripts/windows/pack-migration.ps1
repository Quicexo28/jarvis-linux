param(
    [string]$JarvisDesktopPath = 'C:\proyectos\jarvis-desktop',
    [string]$VaultPath         = 'C:\proyectos\jarvis-desktop\Jarvis-Vault',
    [string]$OutputZip         = ([Environment]::GetFolderPath('Desktop') + '\jarvis-migration.zip')
)

$ErrorActionPreference = 'Stop'

Write-Host '[pack-migration] Empacando migracion Jarvis Linux...' -ForegroundColor Cyan

if (-not (Test-Path $JarvisDesktopPath)) {
    Write-Error ('No se encuentra jarvis-desktop en ' + $JarvisDesktopPath)
    exit 1
}

$DataDir       = Join-Path $JarvisDesktopPath 'backend\data'
$PortableVault = Join-Path $DataDir 'jarvis-portable.enc'
$RemindersFile = Join-Path $DataDir 'reminders.json'

if (-not (Test-Path $PortableVault)) {
    Write-Error 'No existe jarvis-portable.enc. Ejecuta primero: node backend/scripts/make-portable.js'
    exit 1
}

$TmpDir = Join-Path $env:TEMP ('jarvis-migration-' + (Get-Random))
New-Item -ItemType Directory -Force $TmpDir | Out-Null

try {
    Copy-Item $PortableVault (Join-Path $TmpDir 'jarvis-portable.enc')
    Write-Host '  [ok] jarvis-portable.enc'

    if (Test-Path $RemindersFile) {
        Copy-Item $RemindersFile (Join-Path $TmpDir 'reminders.json')
        Write-Host '  [ok] reminders.json'
    } else {
        Write-Host '  [skip] reminders.json no existe'
    }

    if (Test-Path $VaultPath) {
        $VaultDest = Join-Path $TmpDir 'Jarvis-Vault'
        Copy-Item -Recurse -Force $VaultPath $VaultDest
        $n = (Get-ChildItem $VaultDest -Recurse -File).Count
        Write-Host ('  [ok] Jarvis-Vault copiado - ' + $n + ' archivos')
    } else {
        Write-Host ('  [warn] Jarvis-Vault no encontrado en ' + $VaultPath)
    }

    if (Test-Path $OutputZip) { Remove-Item $OutputZip -Force }
    Compress-Archive -Path ($TmpDir + '\*') -DestinationPath $OutputZip
    $SizeMB = [math]::Round((Get-Item $OutputZip).Length / 1MB, 1)

    Write-Host ''
    Write-Host ('[pack-migration] Bundle listo: ' + $OutputZip + ' - ' + $SizeMB + ' MB') -ForegroundColor Green
    Write-Host ''
    Write-Host 'Pasos siguientes:' -ForegroundColor Yellow
    Write-Host '  1. Transfiere el zip al PC Linux (SCP, USB, Syncthing, etc.)'
    Write-Host '  2. En el PC Linux:'
    Write-Host '       git clone https://github.com/Quicexo28/jarvis-linux ~/jarvis-linux'
    Write-Host '       cd ~/jarvis-linux'
    Write-Host '       bash scripts/linux/install.sh'
    Write-Host '       bash scripts/linux/setup-from-migration.sh ~/jarvis-migration.zip'

} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
