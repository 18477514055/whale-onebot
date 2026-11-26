param(
  [Parameter(Mandatory = $true)][string]$AndroidSdk,
  # ★ 默认值不能在 param 里写 "$PSScriptRoot/out"：PS 5.1 求值参数默认值时 $PSScriptRoot 还是空的，
  #   结果 OutDir 变成 "/out"，APK 落到**盘符根目录**（D:\out），看着像构建没产出。改到 body 里算。
  [string]$OutDir = '',
  [switch]$Release,
  # ★ 并排安装（不同包名 + 不同签名）用的可选参数；都不给 = 原来的行为一个字都不变。
  #   -ApplicationId：换 applicationId（清单 package 属性）。改了它，组件名必须全限定，
  #     否则 aapt 会把 ".MainActivity" 解析到新包名下的类，而 Java 类仍在 com.whaleonebot。
  #   -AppLabel：桌面名，方便和现役包肉眼区分。
  #   -KeyStore/-KeyAlias/-KeyPassEnv：换一把钥匙签名（口令只从环境变量取，不落盘、不打印）。
  [string]$ApplicationId = '',
  [string]$AppLabel = '',
  [string]$KeyStore = '',
  [string]$KeyAlias = '',
  [string]$KeyPassEnv = 'WHALE_RELEASE_KS_PASS',
  [string]$ApkName = ''
)

# Build WhaleOneBot APK: javac -> d8 -> aapt -> zipalign -> apksigner
# targetSdk MUST stay 28, otherwise Android 10+ forbids executing ELF from app data
# (proot/node would not start at all).

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }

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
foreach ($script in @('container-login.mjs', 'container-bot.mjs', 'container-watchdog.mjs', 'binding-host.mjs', 'bili-protocol-host.mjs')) {
  $src = Join-Path $PSScriptRoot $script
  if (-not (Test-Path $src)) { throw "missing: $src" }
  Copy-Item $src (Join-Path $assetsDir $script) -Force
  Write-Host ("[0/6] bundled {0} ({1} B)" -f $script, (Get-Item $src).Length)
}

# [layer: shell-android] 协议端胶水随 APK 分发（真源 = src/bridge/，assets 只是派生物）：
#   container-bot.mjs 会 import /qq-onebot/src/bridge/native-bridge.mjs（原生收发/看图/看视频/戳一戳全在那），
#   但这棵树以前不在任何发布产物里 —— 真机那份是手工塞进 rootfs 的，于是「改了 bridge 也发不出去」。
$bridgeSrc = Join-Path $PSScriptRoot '../src/bridge'
$bridgeDst = Join-Path $assetsDir 'bridge'
New-Item -ItemType Directory -Path $bridgeDst -Force | Out-Null
foreach ($n in @('error.mjs', 'native-bridge.mjs', 'qq-profile.mjs', 'rkey.mjs', 'web-cgi.mjs')) {
  $src = Join-Path $bridgeSrc $n
  if (-not (Test-Path $src)) { throw "missing: $src" }
  Copy-Item $src (Join-Path $bridgeDst $n) -Force
}
Write-Host ("[0/6] bundled src/bridge/ (5 files, native-bridge {0} B)" -f (Get-Item (Join-Path $bridgeSrc 'native-bridge.mjs')).Length)

# [layer: shell-android] Q14 全量同步 QQ 协议层 src/ 到 assets/qq-protocol/，消除「容器里 src/ 与仓库漂移」。
$protoSrcRoot = (Resolve-Path (Join-Path $PSScriptRoot '../src')).Path
$protoDstRoot = Join-Path $assetsDir 'qq-protocol'
if (Test-Path $protoDstRoot) { Remove-Item $protoDstRoot -Recurse -Force }
New-Item -ItemType Directory -Path $protoDstRoot -Force | Out-Null
$protoCount = 0
Get-ChildItem -Recurse -File -Filter *.mjs -Path $protoSrcRoot | Where-Object {
  $_.FullName -notmatch '\\src\\(platforms|native|ops)\\'
} | ForEach-Object {
  $rel = $_.FullName.Substring($protoSrcRoot.Length).TrimStart('\', '/')  # $protoSrcRoot 已规范化
  $dst = Join-Path $protoDstRoot $rel
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item $_.FullName $dst -Force
  $protoCount++
}
Write-Host ("[0/6] bundled src/ protocol tree ({0} files -> assets/qq-protocol)" -f $protoCount)

Copy-Item (Join-Path $PSScriptRoot '../src/platforms/bilibili/client.mjs') (Join-Path $assetsDir 'bili-client.mjs') -Force
Copy-Item (Join-Path $PSScriptRoot '../src/platforms/bilibili/authorized-client.mjs') (Join-Path $assetsDir 'authorized-client.mjs') -Force

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
# ★ 并排包（-ApplicationId）另生成一份清单：
#   ① 组件名 ".X" 是相对 manifest 的 package 解析的，换包名后必须写成全限定名，
#      否则 aapt 会写成 com.whaleonebot.<新包>.MainActivity —— 装上去点图标就闪退；
#   ② 清单里没有 provider/authorities，换包名不会撞 authority。
$manifestToUse = $manifest
$manifestText = Get-Content -Raw -Encoding UTF8 $manifest
$manifestPackage = [regex]::Match($manifestText, 'package="([^"]+)"').Groups[1].Value
if (-not $manifestPackage) { throw "manifest 里找不到 package 属性：$manifest" }
$manifestChanged = $false
if ($ApplicationId -and $ApplicationId -ne $manifestPackage) {
  $manifestText = $manifestText.Replace('android:name=".', ('android:name="' + $manifestPackage + '.'))
  $manifestText = $manifestText.Replace(('package="' + $manifestPackage + '"'), ('package="' + $ApplicationId + '"'))
  $manifestChanged = $true
  Write-Host ("       manifest package: {0} -> {1}（组件名已全限定）" -f $manifestPackage, $ApplicationId)
}
if ($AppLabel) {
  $manifestText = $manifestText -replace 'android:label="[^"]*"', ('android:label="' + $AppLabel + '"')
  $manifestChanged = $true
  Write-Host ("       manifest label: {0}" -f $AppLabel)
}
if ($Release) {
  $manifestText = $manifestText -replace '\s*android:debuggable="true"', ''
  $manifestChanged = $true
  Write-Host '       release manifest: debuggable stripped'
}
if ($manifestChanged) {
  $variantDir = Join-Path $work 'variant-manifest'
  New-Item -ItemType Directory -Path $variantDir -Force | Out-Null
  $manifestToUse = Join-Path $variantDir 'AndroidManifest.xml'
  Set-Content -Path $manifestToUse -Value $manifestText -Encoding UTF8 -NoNewline
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
  #   ★ 并排测（不同包名）时用另一把钥匙：-KeyStore/-KeyAlias/-KeyPassEnv，口令同样只走环境变量。
  $ks = if ($KeyStore) { $KeyStore } else { Join-Path $keyDir 'whale-release.p12' }
  $alias = if ($KeyAlias) { $KeyAlias } else { 'whale-release' }
  if (-not (Test-Path $ks)) { throw "release keystore 缺失：$ks（见 android/keys/RELEASE-KEYSTORE.txt）" }
  $ksPass = [Environment]::GetEnvironmentVariable($KeyPassEnv)
  if (-not $ksPass) { throw "缺少 $KeyPassEnv（口令见 android/keys/RELEASE-KEYSTORE.txt）" }
  $apk = if ($ApkName) { Join-Path $OutDir $ApkName } else { Join-Path $OutDir 'whale-onebot-release.apk' }
  Write-Host ("[6/6] apksigner (release, alias {0})" -f $alias)
  & (Join-Path $buildTools 'apksigner.bat') sign --ks $ks --ks-key-alias $alias --ks-pass ('env:' + $KeyPassEnv) --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out $apk $aligned
  if ($LASTEXITCODE -ne 0) { throw 'apksigner sign 失败' }
  & (Join-Path $buildTools 'apksigner.bat') verify --print-certs $apk | Select-Object -First 3
} else {
  $ks = if ($KeyStore) { $KeyStore } else { Join-Path $keyDir 'whale-debug.p12' }
  $alias = if ($KeyAlias) { $KeyAlias } else { 'whale' }
  if (-not (Test-Path $ks)) {
    Write-Host '[6/6] generate debug key (one time)'
    & keytool -genkeypair -storetype PKCS12 -keystore $ks -storepass whaleonebot `
      -alias whale -dname 'CN=WhaleOneBot Debug' -keyalg RSA -keysize 2048 -validity 3650
  }
  $apk = if ($ApkName) { Join-Path $OutDir $ApkName } else { Join-Path $OutDir 'whale-onebot-debug.apk' }
  Write-Host '[6/6] apksigner (debug)'
  & (Join-Path $buildTools 'apksigner.bat') sign --ks $ks --ks-key-alias $alias --ks-pass pass:whaleonebot --out $apk $aligned
  & (Join-Path $buildTools 'apksigner.bat') verify $apk
}

Write-Host ''
Write-Host "APK: $apk"
Write-Host ("size: {0:N1} MB" -f ((Get-Item $apk).Length / 1MB))
