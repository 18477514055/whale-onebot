// Original Windows implementation of the two observed host interfaces.
// Exported names are supplied by a generated .def; no QQ binary is modified.
// Exact Node executable/configuration/header checks must precede any load.
#include "node-host.h"

extern "C" void qq_magic_napi_register(napi_module* module) {
  napi_module_register(module);
}

namespace node {
bool IsEnvironmentStopping(v8::Isolate* isolate) {
  return onebot::nativehost::ConservativeStopping(isolate);
}
}  // namespace node
