// 测试用的身份默认值：没有外部环境变量时，给一组**自洽的合成身份**，让 `npm test` 在干净克隆上也能全绿。
//
// 为什么放在 preload 里：`src/config/account.mjs` 在 import 时就把值定下来了，所以必须在任何测试
// 文件被加载之前把环境变量准备好。`node --import ./test/account-defaults.mjs --test ...` 就是干这个的。
//
// 注意：这里**不放任何真实账号**。要跑真实身份相关的场景，自己 export QQ_BOT_UIN 等变量即可，
// 这里只在缺失时补默认值，不覆盖已有值。

const DEFAULTS = {
  QQ_BOT_UIN: '200000001',
  QQ_OWNER_UIN: '200000002',
  QQ_BOT_UID: 'u_syntheticbot000000000000',
  QQ_TEST_GROUP: '200000003',
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key] || String(process.env[key]).trim() === '') {
    process.env[key] = value;
  }
}
