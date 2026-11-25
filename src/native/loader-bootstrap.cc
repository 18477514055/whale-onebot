// [layer: protocol] QQ 原生桥加载器（loader.node）：在运行期按自身所在目录解析同目录下的
// libonebot-node-host.so，彻底消除编译期硬编码的宿主机绝对路径（根治 P3 补偿层）。
// 优先级：1) 环境变量 WHALE_NODE_HOST_LIB（显式覆盖）；2) loader.node 同目录 libonebot-node-host.so。
#include <node_api.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

static bool resolve_sibling_provider(char* out, size_t cap) {
  const char* override_path = getenv("WHALE_NODE_HOST_LIB");
  if (override_path != nullptr && override_path[0] != '\0') {
    size_t len = strlen(override_path);
    if (len + 1 > cap) return false;
    memcpy(out, override_path, len + 1);
    return true;
  }

  Dl_info info;
  memset(&info, 0, sizeof(info));
  if (dladdr(reinterpret_cast<const void*>(&resolve_sibling_provider), &info) == 0 ||
      info.dli_fname == nullptr || info.dli_fname[0] == '\0') {
    return false;
  }

  const char* slash = strrchr(info.dli_fname, '/');
  static const char kSibling[] = "libonebot-node-host.so";
  const size_t sibling_len = sizeof(kSibling) - 1;
  if (slash == nullptr) {
    if (sibling_len + 3 > cap) return false;
    out[0] = '.';
    out[1] = '/';
    memcpy(out + 2, kSibling, sibling_len + 1);
    return true;
  }

  size_t dir_len = static_cast<size_t>(slash - info.dli_fname) + 1;
  if (dir_len + sibling_len + 1 > cap) return false;
  memcpy(out, info.dli_fname, dir_len);
  memcpy(out + dir_len, kSibling, sibling_len + 1);
  return true;
}

NAPI_MODULE_INIT() {
#ifdef LOCAL_PROVIDER
  const int flags = RTLD_NOW | RTLD_LOCAL;
#else
  const int flags = RTLD_NOW | RTLD_GLOBAL;
#endif
  char provider_path[4096];
  if (!resolve_sibling_provider(provider_path, sizeof(provider_path))) {
    napi_throw_error(env, "PROVIDER_PATH_RESOLVE_FAILED",
                     "Unable to resolve libonebot-node-host.so beside loader.node");
    return nullptr;
  }
  // Keep the provider alive until process exit; consumers retain its addresses.
  void* provider = dlopen(provider_path, flags);
  if (provider == nullptr) {
    napi_throw_error(env, "SYNTHETIC_PROVIDER_LOAD_FAILED", dlerror());
    return nullptr;
  }
  napi_value ready;
  if (napi_get_boolean(env, true, &ready) != napi_ok ||
      napi_set_named_property(env, exports, "providerLoaded", ready) != napi_ok) {
    return nullptr;
  }
  return exports;
}
