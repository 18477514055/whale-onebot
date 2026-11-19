// 账号标识的唯一来源。
//
// ★ 发布版（推到公开仓库的那份）里这四个默认值必须是**占位符**，真实值只能在运行时注入：
//     QQ_BOT_UIN=... QQ_OWNER_UIN=... QQ_BOT_UID=... QQ_TEST_GROUP=... node ...
//   本机日常开发/真机部署时，用 `scripts/local-account-env.mjs`（不在仓库里）或环境变量提供真值。
//
// 说明：源码里其它地方一律 import 这里，不要再写字面量。
export const BOT_UIN = process.env.QQ_BOT_UIN ?? '10000';
export const OWNER_UIN = process.env.QQ_OWNER_UIN ?? '10001';
export const BOT_UID = process.env.QQ_BOT_UID ?? 'u_placeholder';
export const TEST_GROUP = process.env.QQ_TEST_GROUP ?? '10002';
