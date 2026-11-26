/*
 * [layer: environment] 设备身份伪造 shim（LD_PRELOAD）
 *
 * 起因（2026-11-26）：QQ 安全中心把容器里的协议端判成「设备存在外挂或其他软件影响 QQ 正常使用」
 * 并主动下线，设备名直接显示为 **localhost** —— 那是 Android 内核的默认 hostname，
 * 真实 Linux 桌面绝不会叫这个名字。容器跑在 proot 里，`hostname`/`uname` 走的是 syscall，
 * 改 /etc/hostname 无效，proot 也只改 uname.release 不改 nodename，所以只能在这里拦。
 *
 * 用法：LD_PRELOAD=/opt/whale/native/libwhale-device.so node container-bot.mjs
 * 取值（任一为空则用默认）：WHALE_FAKE_HOSTNAME / WHALE_FAKE_KERNEL_RELEASE / WHALE_FAKE_KERNEL_VERSION
 */
#define _GNU_SOURCE
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/utsname.h>
#include <dlfcn.h>

#ifndef WHALE_FAKE_HOST
#define WHALE_FAKE_HOST "debian"
#endif
#ifndef WHALE_FAKE_REL
#define WHALE_FAKE_REL "6.1.0-28-arm64"
#endif
#ifndef WHALE_FAKE_VER
#define WHALE_FAKE_VER "#1 SMP PREEMPT_DYNAMIC Debian 6.1.119-1 (2024-11-22)"
#endif

static const char *pick(const char *env, const char *dflt) {
    const char *v = getenv(env);
    return (v && *v) ? v : dflt;
}

int gethostname(char *name, size_t len) {
    if (!name || !len) return -1;
    const char *h = pick("WHALE_FAKE_HOSTNAME", WHALE_FAKE_HOST);
    size_t n = strlen(h);
    if (n > len - 1) n = len - 1;
    memcpy(name, h, n);
    name[n] = '\0';
    return 0;
}

int uname(struct utsname *buf) {
    static int (*real)(struct utsname *) = 0;
    if (!real) real = (int (*)(struct utsname *)) dlsym(RTLD_NEXT, "uname");
    if (!real) return -1;
    int r = real(buf);
    if (r == 0 && buf) {
        const char *h = pick("WHALE_FAKE_HOSTNAME", WHALE_FAKE_HOST);
        const char *rel = pick("WHALE_FAKE_KERNEL_RELEASE", WHALE_FAKE_REL);
        const char *ver = pick("WHALE_FAKE_KERNEL_VERSION", WHALE_FAKE_VER);
        strncpy(buf->nodename, h, sizeof(buf->nodename) - 1);
        buf->nodename[sizeof(buf->nodename) - 1] = '\0';
        strncpy(buf->release, rel, sizeof(buf->release) - 1);
        buf->release[sizeof(buf->release) - 1] = '\0';
        strncpy(buf->version, ver, sizeof(buf->version) - 1);
        buf->version[sizeof(buf->version) - 1] = '\0';
    }
    return r;
}
