# 构建与签名（本机 debug / 对外 release）

> 口径（用户 2026-11-19 定）：**本机测试继续用 debug 包，对外发布只发 release 包。**
> 两个包都从同一份源码、同一个 `android/build.ps1` 出，区别只在清单里的 `android:debuggable` 与签名密钥。

## 1. 本机测试：debug 包

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\android\build.ps1 `
  -AndroidSdk "C:\Users\24239\AppData\Local\Android\Sdk" `
  -OutDir D:\qq-onebot\android\out
# 产物：android/out/whale-onebot-debug.apk
```

- 签名用 `android/keys/whale-debug.p12`（口令是公开的调试口令，脚本里写死）。
- 清单里保留 `android:debuggable="true"` —— **必须保留**，否则 `adb shell run-as com.whaleonebot`
  就用不了，而读容器日志、改 rootfs、抓数据库全靠它。
- 这个包**不要发出去**。

## 2. 对外发布：release 包

```powershell
# 口令在 android/keys/RELEASE-KEYSTORE.txt（本机文件，不进 git）
$env:WHALE_RELEASE_KS_PASS = '<从那个文件里取的 storepass>'

powershell -NoProfile -ExecutionPolicy Bypass -File .\android\build.ps1 `
  -AndroidSdk "C:\Users\24239\AppData\Local\Android\Sdk" `
  -Release -OutDir D:\qq-onebot\android\out
# 产物：android/out/whale-onebot-release.apk
```

脚本在 `-Release` 时会做三件事：

1. 复制一份临时清单到 `release-manifest/AndroidManifest.xml`，**剥掉 `android:debuggable="true"`**；
2. 用 `android/keys/whale-release.p12`（alias `whale-release`）签名，口令只从环境变量读，**不落盘、不打印**；
3. 用 `apksigner verify --print-certs` 自检，并打印签名者 DN。

校验（我实际跑过的命令）：

```powershell
$bt = "C:\Users\24239\AppData\Local\Android\Sdk\build-tools\36.0.0"
& "$bt\aapt.exe" dump badging android\out\whale-onebot-release.apk | Select-String 'package:|debuggable'
& "$bt\apksigner.bat" verify --print-certs android\out\whale-onebot-release.apk
```

v1.0.1 实测：`versionCode=101 / versionName=1.0.1`，**没有 `application-debuggable`**，
签名 DN `CN=Whale OneBot, O=Whale OneBot, C=CN`，v3 签名通过（minSdk 28 ⇒ 不需要 v1/v2）。

## 3. ★ 两条必须记住的坑

- **换签名 = 必须卸载重装**：debug 包的签名者与 release 不同，直接覆盖安装会
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；卸载会**清掉 App 私有目录**（`bots.json`、运行端
  `config.json`、1.2 GB 的 rootfs、知识库与记忆库全在里面）。
  ⇒ 这台手机既然继续用 debug，就**不要**在它上面装 release 包；release 只发给别人。
- **keystore 丢了就没法升级**：`android/keys/` 已在 `.gitignore` 里，所以 keystore 和口令
  都只在本机。请把它们备份到密码管理器/离线介质 —— 丢了之后，已经装了 release 包的用户
  只能卸载重装（数据全丢）。
