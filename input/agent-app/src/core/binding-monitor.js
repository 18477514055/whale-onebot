// Identity, never merely socket readiness. The parent associates messages with its child handle.
export function monitorBinding(onebot) {
  let probing = false;
  const report = () => { if (process.connected) process.send({bindingState: onebot.dualVerified ? 'verified' : 'disconnected'}, () => {}); };
  const tick = async () => {
    report();
    if (!onebot.connected || probing) return;
    probing = true;
    try { await onebot.call('get_login_info', {}, 2500); } catch { /* guard revoked */ }
    finally { probing = false; report(); }
  };
  onebot.onBindingProofRevoked = report;
  onebot.onStatus(report);
  const timer = setInterval(tick, 5000); timer.unref();
}
