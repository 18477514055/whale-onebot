// Original preflight tooling only. No runtime, account or credential discovery.
export const FIXED = Object.freeze({
  qqVersion: '3.2.35-54395',
  qqArchiveSha256: '5f93ea62347dd772c7be4115413c95d2a60d189f3dd81bc194834bd4d7343cf2',
  nodeVersion: 'v24.20.0',
  nodeArchiveSha256: '5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7',
  nodeElfSha256: '23a5637c2470fde09fcc1acc77c1b92e04e3d7e3e6e80ff7df6f5831958d1477',
  wrapperSha256: '2ec220b7569cbdcfee11e628bd0268c80c6c8ef0c6bbd33cceffe148fd2743e7',
  nodePath: '.tools/node-v24.20.0-linux-arm64/bin/node',
  wrapperPath: '.tools/qq-linux-arm64-inspection-NGwyZl/wrapper.node',
  packageWrapperMember: 'opt/QQ/resources/app/wrapper.node',
  providerPath: '.tmp/native-host-arm64-0wfTF4/libonebot-node-host.so',
  providerSha256: 'e27fe84e0c418e1083779276468b313f740c1cac764165e7136014eb3337a593',
  loaderPath: '.tmp/native-host-arm64-0wfTF4/loader.node',
  loaderSha256: 'a69138c30cfe5010057d69d2926484c24a7a5210f2b556ad738b65250c9295b6',
});
export const EVIDENCE = Object.freeze([
  'linux-arm64-onebot-smoke.json',
  'native-dependencies-linux-arm64-supplemental.json',
  'native-relocations-linux-arm64.json',
  'native-host-scope-linux-arm64.json',
]);
export const BUNDLE_FILES = Object.freeze([
  'preflight.mjs', 'core.mjs', 'safe-files.mjs', 'elf.mjs', 'constants.mjs',
  'README.md', 'device-facts.example.json',
]);
export const LIMITS = Object.freeze({ json: 16 * 1024 * 1024, binary: 512 * 1024 * 1024 });
