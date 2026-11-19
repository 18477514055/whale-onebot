param(
  [Parameter(Mandatory = $true)][string]$AndroidSdk,
  [string]$OutDir = "$PSScriptRoot/out",
  [switch]$Release
)

# Build WhaleOneBot APK: javac -> d8 -> aapt -> zipalign -> apksigner
# targetSdk MUST stay 28, otherwise Android 10+ forbids executing ELF from app data
# (proot/node would not start at all).

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$app        = Join-Path $PSScriptRoot 'app'
$srcDir     = Join-Path $app 'src'
$manifest   = Join-Path $app 'AndroidManifest.xml'
$assetsDir  = Join-Path $app 'assets'
$resDir     = Join-Path $app 'res'
$buildTools = Join-Path $AndroidSdk 'build-tools/36.0.0'
$platform   = Join-Path $AndroidSdk 'platforms/android-36/android.jar'

if (-not (Test-Path $assetsDir)) { throw "assets dir missing: $assetsDir" }
foreach ($f in @('proot','libtalloc.so.2','libandroid-shmem.so')) {
  if (-not (Test-Path (Join-Path $assetsDir $f))) { throw "assets/$f missing" }
}

# The container scripts ship as assets and are force-copied into the rootfs on every
# start, so changing the login / bot logic only needs an APK reinstall, not a 1.2GB rootfs repack.
foreach ($script in @('container-login.mjs', 'container-bot.mjs')) {
  $src = Join-Path $PSScriptRoot $script
  if (-not (Test-Path $src)) { throw "missing: $src" }
  Copy-Item $src (Join-Path $assetsDir $script) -Force
  Write-Host ("[0/6] bundled {0} ({1} B)" -f $script, (Get-Item $src).Length)
}

$work = Join-Path $PSScriptRoot ('.build-' + [guid]::NewGuid().ToString('N'))
$classes = Join-Path $work 'classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$sources = Get-ChildItem -Recurse -File -Filter *.java -Path $srcDir | ForEach-Object { $_.FullName }
Write-Host ("[1/6] javac {0} files" -f $sources.Count)
& javac --release 8 -encoding UTF-8 -classpath $platform -d $classes $sources
# ★ javac 有错误必须当场停：2026-11-19 出过事故 —— 一个字段漏声明，javac 报了 3 个错，
#   但脚本继续往下跑，d8 只打包了能编译的类（少 21 个，含 Ui），装上去就是**整屏白**；
#   运行时只报 NoClassDefFoundError，那种包一旦发出去极难查。宁可不产出，也不产出半成品。
if ($LASTEXITCODE -ne 0) {
  throw "javac 失败（上面有具体文件与行号）。没有产出 APK —— 修掉编译错误再构建。"
}

$classFiles = Get-ChildItem -Recurse -File -Filter *.class -Path $classes | ForEach-Object { $_.FullName }
Write-Host ("[2/6] d8 {0} classes" -f $classFiles.Count)
# ★ d8 的输入一律走"一个 jar"，不再逐个列 .class：
#   ① Windows 命令行 8191 字符限制 —— 218 个 .class 的相对路径也已经逼近上限，
#      cmd 会在 d8 之前就报 "The command line is too long."，d8 一个字都不产出；
#   ② 而脚本过去仍会继续打包签名，产出一个**没有 classes.dex 的 APK**（装上去必闪退）。
#   现在：先 jar 起来再交给 d8（一个参数），并把"没有 dex 就抛错"的守卫留着。
$classesJar = Join-Path $work 'classes.jar'
Push-Location $classes
try { & jar cf $classesJar . } finally { Pop-Location }
Write-Host ("       classes.jar {0} KB" -f [int]((Get-Item $classesJar).Length / 1024))
Push-Location $work
try {
  & (Join-Path $buildTools 'd8.bat') --min-api 28 --lib $platform --output $work $classesJar
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $work 'classes.dex'))) {
  throw "d8 produced no classes.dex - the APK would have no code and crash on launch."
}

# ★ release 包不能带 android:debuggable（run-as 调试要靠它，所以只在 release 时剥掉）
$manifestToUse = $manifest
if ($Release) {
  $releaseDir = Join-Path $work 'release-manifest'
  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
  $releaseManifest = Join-Path $releaseDir 'AndroidManifest.xml'
  $raw = Get-Content -Raw -Encoding UTF8 $manifest
  $raw = $raw -replace '\s*android:debuggable="true"', ''
  Set-Content -Path $releaseManifest -Value $raw -Encoding UTF8 -NoNewline
  $manifestToUse = $releaseManifest
  Write-Host '       release manifest: debuggable stripped'
}

Write-Host '[3/6] aapt package'
$unsigned = Join-Path $work 'unsigned.apk'
& (Join-Path $buildTools 'aapt.exe') package -M $manifestToUse -I $platform -S $resDir -A $assetsDir -F $unsigned

Write-Host '[4/6] add classes.dex'
Push-Location $work
try { & (Join-Path $buildTools 'aapt.exe') add $unsigned 'classes.dex' } finally { Pop-Location }

Write-Host '[5/6] zipalign'
$aligned = Join-Path $work 'aligned.apk'
& (Join-Path $buildTools 'zipalign.exe') -p -f 4 $unsigned $aligned

$keyDir = Join-Path $PSScriptRoot 'keys'
New-Item -ItemType Directory -Path $keyDir -Force | Out-Null

if ($Release) {
  # ★ 对外发布**只发 release 包**；本机测试继续用 debug 包。
  #   密钥只在本机：keystore 在 android/keys/（已 .gitignore），口令从环境变量取，不落盘、不打印。
  $ks = Join-Path $keyDir 'whale-release.p12'
  if (-not (Test-Path $ks)) { throw "release keystore 缺失：$ks（见 android/keys/RELEASE-KEYSTORE.txt）" }
  $ksPass = $env:WHALE_RELEASE_KS_PASS
  if (-not $ksPass) { throw '缺少 WHALE_RELEASE_KS_PASS（口令见 android/keys/RELEASE-KEYSTORE.txt）' }
  $apk = Join-Path $OutDir 'whale-onebot-release.apk'
  Write-Host '[6/6] apksigner (release)'
  & (Join-Path $buildTools 'apksigner.bat') sign --ks $ks --ks-key-alias whale-release --ks-pass "pass:$ksPass" --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out $apk $aligned
  if ($LASTEXITCODE -ne 0) { throw 'apksigner sign 失败' }
  & (Join-Path $buildTools 'apksigner.bat') verify --print-certs $apk | Select-Object -First 3
} else {
  $ks = Join-Path $keyDir 'whale-debug.p12'
  if (-not (Test-Path $ks)) {
    Write-Host '[6/6] generate debug key (one time)'
    & keytool -genkeypair -storetype PKCS12 -keystore $ks -storepass whaleonebot `
      -alias whale -dname 'CN=WhaleOneBot Debug' -keyalg RSA -keysize 2048 -validity 3650
  }
  $apk = Join-Path $OutDir 'whale-onebot-debug.apk'
  Write-Host '[6/6] apksigner (debug)'
  & (Join-Path $buildTools 'apksigner.bat') sign --ks $ks --ks-pass pass:whaleonebot --out $apk $aligned
  & (Join-Path $buildTools 'apksigner.bat') verify $apk
}

Write-Host ''
Write-Host "APK: $apk"
Write-Host ("size: {0:N1} MB" -f ((Get-Item $apk).Length / 1MB))
