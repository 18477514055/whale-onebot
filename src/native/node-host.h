#ifndef ONEBOT_ORIGINAL_NODE_HOST_H
#define ONEBOT_ORIGINAL_NODE_HOST_H

// Exact-version Node internals. Never reconstruct Environment member offsets.
#include "env-inl.h"

namespace onebot::nativehost {
enum class StopState { running, stopping, unavailable };

inline StopState ReadStopping(v8::Isolate* isolate) {
  if (isolate == nullptr || isolate != v8::Isolate::GetCurrent())
    return StopState::unavailable;
  if (!isolate->InContext()) return StopState::unavailable;
  // Native libuv callbacks may run under Node's SealHandleScope rather than
  // inside a N-API callback scope. GetCurrentContext creates a Local handle.
  v8::HandleScope handles(isolate);
  node::Environment* environment =
      node::GetCurrentEnvironment(isolate->GetCurrentContext());
  if (environment == nullptr) return StopState::unavailable;
  return environment->is_stopping() ? StopState::stopping : StopState::running;
}

inline bool ConservativeStopping(v8::Isolate* isolate) {
  return ReadStopping(isolate) != StopState::running;
}
}  // namespace onebot::nativehost
#endif
