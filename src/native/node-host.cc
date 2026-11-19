// Original host adapter for the two independently observed Linux imports.
// This library must only be loaded through an entry point that validates the
// exact Node executable, configuration, source/header pins and built artifacts.
#include "node-host.h"

extern "C" __attribute__((visibility("default")))
void qq_magic_napi_register(napi_module* module) {
  napi_module_register(module);
}

namespace node {
__attribute__((visibility("default")))
bool IsEnvironmentStopping(v8::Isolate* isolate) {
  return onebot::nativehost::ConservativeStopping(isolate);
}
}  // namespace node
