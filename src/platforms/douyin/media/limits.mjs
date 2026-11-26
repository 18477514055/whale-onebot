export const PCM_BYTES = 2 * 16000 * 2;
export const refuse = reason => Object.assign(new Error(reason), {reason});

// Bound the caller's wait even for an adapter that forgets to observe abort.
export async function bounded(parent, ms, fn) {
  if (!Number.isInteger(ms) || ms < 1 || ms > 30000) throw refuse('INVALID_LIMIT');
  const ctl = new AbortController();
  const cancel = () => ctl.abort(refuse('CANCELLED'));
  if (parent?.aborted) cancel(); else parent?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(() => ctl.abort(refuse('TIMEOUT')), ms);
  let stop;
  try {
    ctl.signal.throwIfAborted();
    const aborted = new Promise((_, reject) => {
      stop = () => reject(ctl.signal.reason);
      ctl.signal.addEventListener('abort', stop, {once:true});
    });
    return await Promise.race([aborted, fn(ctl.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    if (stop) ctl.signal.removeEventListener('abort', stop);
  }
}

export function packWav(pcm) {
  if (pcm.length !== PCM_BYTES) throw refuse('INSUFFICIENT_AV');
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + PCM_BYTES, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(PCM_BYTES, 40);
  return Buffer.concat([h, pcm]);
}
