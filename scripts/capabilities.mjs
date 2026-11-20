import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS } from '../src/actions.mjs';
import { OneBotCore } from '../src/core.mjs';
import { qqOneBot11Profile } from '../src/bridge/qq-profile.mjs';
import { summarizeLiveRoundtripEvidence } from '../src/host/online-observation.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args = process.argv.slice(2);
const preview = args.at(-1) === '--preview';
if (preview) args.pop();
assert(args.length === 0 || (args.length === 2 && args[0] === '--live-evidence'),
  'Usage: capabilities.mjs [--live-evidence <project JSON file>] [--preview]');
const standard='send_private_msg send_group_msg send_msg delete_msg get_msg get_forward_msg send_like set_group_kick set_group_ban set_group_anonymous_ban set_group_whole_ban set_group_admin set_group_anonymous set_group_card set_group_name set_group_leave set_group_special_title set_friend_add_request set_group_add_request get_login_info get_stranger_info get_friend_list get_group_info get_group_list get_group_member_info get_group_member_list get_group_honor_info get_cookies get_csrf_token get_credentials get_record get_image can_send_image can_send_record get_status get_version_info set_restart clean_cache'.split(' ');
const source=fs.readFileSync(path.join(root,'src/bridge/native-bridge.mjs'),'utf8');
const mapped=[...new Set([...source.matchAll(/case '([a-z][a-z0-9_]+)'/g)].map(match=>match[1]))].sort();
const local=['get_status','get_version_info','can_send_image','can_send_record','get_supported_actions',...Object.keys(qqOneBot11Profile.localActions)];
const core = new OneBotCore();
const offline = await core.dispatch({ action: 'get_supported_actions' });
core.close();
if (offline.retcode !== 0 || !Array.isArray(offline.data)) throw new Error('Could not measure offline advertisement');
const all=[...new Set([...standard,...Object.keys(ACTIONS),...mapped])].sort();
const evidenceFile = path.resolve(root, args[1] ?? 'evidence/integrated-linux-three-path-live.json');
const liveEvidence = path.relative(root, evidenceFile).split(path.sep).join('/');
assert(!path.isAbsolute(liveEvidence) && /^(?:evidence|\.tmp)\/[A-Za-z0-9_.\/-]+\.json$/.test(liveEvidence) &&
  !liveEvidence.split('/').includes('..') && (preview || liveEvidence.startsWith('evidence/')), 'Evidence must be inside the project');
const evidenceStat = fs.lstatSync(evidenceFile);
assert(evidenceStat.isFile() && evidenceStat.nlink === 1 && evidenceStat.size <= 65536 && fs.realpathSync(evidenceFile) === evidenceFile,
  'Expected a bounded evidence file without links');
const saved = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
const exported = saved.command === 'verify_onebot_roundtrip' && saved.status === 'completed' ? saved.liveEvidence : saved;
const live = exported?.evidence;
const sample = live?.postRoundtripStatus;
assert(exported?.command === 'read_live_roundtrip_evidence' && exported.status === 'completed' &&
  (exported === saved || saved.roundtripResult?.seq === live?.roundtripResult?.seq) &&
  typeof live?.profile === 'string' && /^login-[a-f0-9]{20}$/.test(live.profile) &&
  typeof live.inputManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(live.inputManifestSha256) &&
  Number.isSafeInteger(live.roundtripResult?.seq) && live.roundtripResult.seq > 0 &&
  (sample === null || (sample?.roundtripSeq === live.roundtripResult.seq && sample.sessionGeneration === live.sessionGeneration &&
    Number.isSafeInteger(sample.seq) && sample.seq > live.roundtripResult.seq)),
  'Expected a completed live roundtrip evidence export');
const { transportCoverage: liveTransportCoverage, postRoundtripSessionVerified, threePathRoundtripVerified } = summarizeLiveRoundtripEvidence(live);
assert(liveTransportCoverage.http.businessActions.includes('send_group_msg'), 'Evidence does not establish a confirmed send');
const liveNotes = {
  send_group_msg: 'one fixed group text verified on isolated Linux QQ following OneBot restart and bridge reattachment',
  get_group_info: 'one isolated Linux QQ group read after the group reply, checking the group ID, name, and member counts',
  get_msg: 'the isolated Linux group reply was read by its returned OneBot message ID, verifying the group, sender, and exact text',
};
const matrix=all.map(action=>{
  const liveTransports = Object.keys(liveTransportCoverage).filter(name => liveTransportCoverage[name].businessActions.includes(action));
  return {action,onebot11Standard:standard.includes(action),registered:Object.hasOwn(ACTIONS,action),
  advertisedByOfflineService:offline.data.includes(action),
  layer:local.includes(action)?'local-protocol':mapped.includes(action)?'native-contract-adapter':'unimplemented',
  realQQVerified:liveTransports.length > 0,
  ...(liveTransports.length && { liveEvidence, liveTransport: liveTransports[0], liveTransports }),
  notes:(liveTransports.length && liveNotes[action]) || (['can_send_image','can_send_record'].includes(action)?'returns yes:false; no upload support':action==='set_group_leave'?'ordinary leave only; no local deletion requested; dismiss unsupported':action==='get_msg_emoji_likes'?'group reaction totals and bounded responder lists checked against the native total':action.endsWith('_forward_msg')&&mapped.includes(action)?'existing references from one source conversation; final send receipt required':action.startsWith('send_')&&mapped.includes(action)?'text/at/face/reply only; guildId correlation and final callback msgId required':'')};
});
const report={generatedAt:new Date().toISOString(),standardSource:'https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md',
  invocation:{asyncSuffix:true,rateLimitedSuffix:true,rateLimitDefaultMs:500,rateWaitDefaultMs:60000,
    webhookQuickOperations:true,quickOperationScope:'HTTP response translation; native action capability preflight; one-shot event epoch and deadline; atomic admission, not atomic execution',
    asyncQueue:'bounded in-memory only; cancelled on close or session invalidation; no replay or retry'},
  counts:{standardActions:standard.length,registryActions:Object.keys(ACTIONS).length,nativeMappedActions:mapped.length,
  advertisedByOfflineService:offline.data.length,
  standardMapped:matrix.filter(x=>x.onebot11Standard&&x.layer!=='unimplemented').length,
  realQQVerifiedActions:matrix.filter(x=>x.realQQVerified).length},
  liveEvidence, liveTransportCoverage, postRoundtripSessionVerified, threePathRoundtripVerified,
  caveat:'Action counts cover protocol handlers and bridge contracts. A verified action covers only the scenario in its evidence. Offline advertisement includes status and identity queries that can report unavailable.',matrix};
if (preview) console.log(JSON.stringify(report, null, 2));
else {
  fs.writeFileSync(path.join(root,'evidence/capabilities.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.counts));
}
