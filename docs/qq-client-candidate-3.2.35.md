# Linux QQ ARM64 3.2.35：候选校验记录（未准入）

此页不是安装源。已核对腾讯稳定版包体、包内版本和主程序架构，尚未验证受管环境能否启动、登录。不能据此替换工作中的客户端。

| 项目 | 值 |
|---|---|
| 官方稳定版候选 | `https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_arm64_01.deb` |
| 社区记录 SHA-256 | `5f93ea62347dd772c7be4115413c95d2a60d189f3dd81bc194834bd4d7343cf2` |
| 同一精确 URL 的另一种校验（BLAKE2b-512） | `8d09c561ba9348b4a0b79001726cb45c9b9f466552ac6dba73c86d83483450bcccf0b6c6cc7501de31bdb84129efa095c593ade062938817488659121b89d2d1` |

- [NUR 源文件快照](https://api.github.com/repos/lonerOrz/loneros-nur/git/blobs/f9a3c33746bb24e6299b9119e8d6744b8054b44d)：精确稳定链接，aarch64-linux；已将 SRI Base64 转为上面的十六进制摘要。
- [Arch 打包元数据快照](https://api.github.com/repos/awsl1414/aur-packages/git/blobs/ea16b419ccf984ad8eb51aac0c04d3f6593c8302)：同链接，aarch64 的 BLAKE2b 摘要；打包版本记为 `3.2.35_54395`。
- Flathub 当前清单中的 aarch64 URL 是另一条 `/beta/` 路径，其声明摘要与上面 SHA-256 相同、大小为 208717176 字节。该大小只能作为待核对值，不是本项目实测的稳定包长度。主线 nixpkgs 查询时仍是 3.2.34，不可混用。

本机经腾讯下载授权流程取得稳定链接（临时参数不落盘），对该链接发出 HEAD：`200`，`Content-Type: application/octet-stream`，`Content-Length: 208717176`。首次 GET 校验未成功。随后经正常授权重新获取，GET 200，实际接收 208717176 字节；对完整文件计算的两种摘要均与上表相符。

离线读取 `control.tar.xz`：`Package: linuxqq`、`Version: 3.2.35-54395`、`Architecture: arm64`、`Installed-Size: 657652`（KiB）。流式读取 `data.tar.xz` 中 `opt/QQ/qq` 的 ELF 文件头，确认为 64 位小端 AArch64，文件长度 198311352 字节。检查未运行维护脚本，也未启动客户端。下一步是在隔离受管环境验证依赖、启动和登录，而不是再次下载。若无法正常获取或任一校验不符，保留现有客户端；不切换为 beta、第三方镜像或自动导入这些社区记录。
