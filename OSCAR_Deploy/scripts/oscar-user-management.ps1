# OSCAR User Management Helper
# Usage:
# 1) Edit the variables in the CONFIG section.
# 2) Run in PowerShell from oscar-server folder:
#    powershell -ExecutionPolicy Bypass -File .\oscar-user-management.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ===== CONFIG =====
$ServerBaseUrl = "http://localhost:3001"
$EnvFile = "oscar-server.env"

# Permanent administrator account to create (if it does not already exist)
# IMPORTANT: Passwords are NEVER stored in this file. They will be prompted
# securely at runtime when the script runs. This prevents credentials from
# leaking via source control.
$CreatePermanentAdmin = $false
$PermanentAdminEmail = "userid@xyz.org"
$PermanentAdminPassword = $null   # prompted at runtime via Read-Host -AsSecureString

# Optional certification user
$CreateCertificationUser = $false
$CertificationEmail = "certification@uic.org"
$CertificationPassword = $null    # prompted at runtime via Read-Host -AsSecureString

# Optional company user
$CreateCompanyUser = $false
$CompanyUserEmail = "company.user@partner.com"
$CompanyUserPassword = $null      # prompted at runtime via Read-Host -AsSecureString
$CompanyId = "PUT_COMPANY_UUID_HERE"

# Helper: prompt securely for a password and return plaintext (only used
# in-memory for the immediate API call; never written anywhere)
function Get-SecurePasswordPlain([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try   { return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Optional cleanup of temporary users
$DeleteTemporaryUsers = $true
$TemporaryEmailsToDelete = @(
  "bootstrap.test.1775370356@uic.local",
  "web.admin.1775371185@uic.local"
)
# ===== END CONFIG =====

if ($CreatePermanentAdmin) {
  if (-not (Test-Path $EnvFile) -and (Test-Path ".env")) {
    $EnvFile = ".env"
    Write-Warning "oscar-server.env not found, falling back to .env"
  }

  Write-Host "[1/7] Reading PLATFORM_BOOTSTRAP_TOKEN from $EnvFile..." -ForegroundColor Cyan
  $line = Select-String -Path $EnvFile -Pattern "^PLATFORM_BOOTSTRAP_TOKEN="
  if (-not $line) { throw "PLATFORM_BOOTSTRAP_TOKEN not found in $EnvFile" }
  $bootstrap = $line.Line.Split("=",2)[1].Trim()
  if (-not $bootstrap) { throw "PLATFORM_BOOTSTRAP_TOKEN is empty in $EnvFile" }

  $bootstrapHeaders = @{
    "x-platform-bootstrap-token" = $bootstrap
    "Content-Type" = "application/json"
  }

  if (-not $PermanentAdminPassword) {
    $PermanentAdminPassword = Get-SecurePasswordPlain "Enter password for new admin $PermanentAdminEmail (min 12 chars, upper/lower/digit)"
  }

  Write-Host "[2/7] Creating permanent administrator (if not existing)..." -ForegroundColor Cyan
  $createAdminBody = @{
    email = $PermanentAdminEmail
    password = $PermanentAdminPassword
    role = "administrator"
  } | ConvertTo-Json

  try {
    $createAdminResp = Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/v1/auth/bootstrap/platform-user" -Headers $bootstrapHeaders -Body $createAdminBody
    Write-Host "Administrator created: $($createAdminResp.user.email)" -ForegroundColor Green
  } catch {
    Write-Warning "Administrator creation skipped/failed (possibly already exists): $($_.Exception.Message)"
  }
} else {
  Write-Host "[1/7] Skipped bootstrap token read (CreatePermanentAdmin = false)." -ForegroundColor Yellow
  Write-Host "[2/7] Skipped permanent administrator creation." -ForegroundColor Yellow
}

Write-Host "[3/7] Logging in as permanent administrator..." -ForegroundColor Cyan
if (-not $PermanentAdminPassword) {
  $PermanentAdminPassword = Get-SecurePasswordPlain "Enter password for $PermanentAdminEmail"
}
$loginBody = @{
  email = $PermanentAdminEmail
  password = $PermanentAdminPassword
} | ConvertTo-Json

$loginResp = Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/v1/auth/login" -ContentType "application/json" -Body $loginBody
$adminToken = $loginResp.token
if (-not $adminToken) { throw "Admin login failed: no token returned" }

$adminHeaders = @{
  "Authorization" = "Bearer $adminToken"
  "Content-Type" = "application/json"
}

Write-Host "Admin login OK: $($loginResp.user.email) (role: $($loginResp.user.role))" -ForegroundColor Green

if ($CreateCertificationUser) {
  Write-Host "[4/7] Creating certification user..." -ForegroundColor Cyan
  if (-not $CertificationPassword) {
    $CertificationPassword = Get-SecurePasswordPlain "Enter password for new certification user $CertificationEmail"
  }
  $createCertBody = @{
    email = $CertificationEmail
    password = $CertificationPassword
    role = "certification_user"
  } | ConvertTo-Json

  try {
    $certResp = Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/v1/auth/users" -Headers $adminHeaders -Body $createCertBody
    Write-Host "Certification user created: $($certResp.user.email)" -ForegroundColor Green
  } catch {
    Write-Warning "Certification user create failed: $($_.Exception.Message)"
  }
} else {
  Write-Host "[4/7] Skipped certification user creation." -ForegroundColor Yellow
}

if ($CreateCompanyUser) {
  Write-Host "[5/7] Creating company user..." -ForegroundColor Cyan
  if ($CompanyId -eq "PUT_COMPANY_UUID_HERE") {
    throw "Set CompanyId in CONFIG before CreateCompanyUser = `$true"
  }
  if (-not $CompanyUserPassword) {
    $CompanyUserPassword = Get-SecurePasswordPlain "Enter password for new company user $CompanyUserEmail"
  }

  $createCompanyUserBody = @{
    email = $CompanyUserEmail
    password = $CompanyUserPassword
    role = "company_user"
    company_id = $CompanyId
  } | ConvertTo-Json

  try {
    $companyUserResp = Invoke-RestMethod -Method Post -Uri "$ServerBaseUrl/v1/auth/users" -Headers $adminHeaders -Body $createCompanyUserBody
    Write-Host "Company user created: $($companyUserResp.user.email) for company: $($companyUserResp.user.company_id)" -ForegroundColor Green
  } catch {
    Write-Warning "Company user create failed: $($_.Exception.Message)"
  }
} else {
  Write-Host "[5/7] Skipped company user creation." -ForegroundColor Yellow
}

Write-Host "[6/7] Generating new bootstrap token (recommended rotation)..." -ForegroundColor Cyan
$newBootstrap = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
Write-Host "New PLATFORM_BOOTSTRAP_TOKEN:" -ForegroundColor Green
Write-Host $newBootstrap -ForegroundColor Green
Write-Host "Update oscar-server.env, restart server, and keep this token secure." -ForegroundColor Yellow

if ($DeleteTemporaryUsers) {
  Write-Host "[7/7] Deleting temporary users..." -ForegroundColor Cyan
  if ($TemporaryEmailsToDelete.Count -gt 0) {
    $emailsJson = $TemporaryEmailsToDelete | ConvertTo-Json -Compress
    node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('./data/oscar.db'); const emails = JSON.parse(process.argv[1]); if (!Array.isArray(emails) || emails.length === 0) { console.log('Deleted users: 0'); process.exit(0); } const placeholders = emails.map(() => '?').join(','); const sql = 'DELETE FROM users WHERE email IN (' + placeholders + ')'; const r = db.prepare(sql).run(...emails); console.log('Deleted users:', r.changes);" "$emailsJson"
  }
} else {
  Write-Host "[7/7] Skipped temporary user deletion." -ForegroundColor Yellow
}

Write-Host "Done." -ForegroundColor Green
