import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalAgentConfig, originalBusinessSettingsMatch, RUNTIME_MODEL_AUTH_MARKER } from '../src/host/original-agent-config.mjs';
import { TEST_GROUP } from '../src/config/account.mjs';

const original = () => ({
  onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '', httpAccessToken: '', catchupReplyWindowMs: 12345, wsHeartbeat: 'auto' },
  server: { host: '127.0.0.1', port: 3210, token: '' },
  api: { baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKey: '', model: 'synthetic-original-model',
    maxRunTokens: 160000, maxRounds: 12, timeout: 60000, extraBody: {},
    thinkingByService: { 'synthetic-original-service': { chat: 'off' } }, fallback: { enabled: false } },
  allow: { groups: [20001, 20002], private: [30001] }, allowAllWhenEmpty: true,
  runtime: { mode: 'active', paused: false },
  proactive: { enabled: true, followUpEnabled: true }, reminders: { enabled: true },
  timeControl: { enabled: true, windows: ['synthetic-window'] },
  store: { groupSliderPos: { '20001': 17, '20002': 83 }, sliderMode: 'probability' },
  personality: { prompt: 'SYNTHETIC_PERSONA_NOT_REAL_DATA' }, plugins: { enabled: true }, mcp: { enabled: true },
});

test('normal config changes connections/auth only and preserves every original business value', () => {
  const source = original(), snapshot = structuredClone(source);
  const configured = createOriginalAgentConfig(source, { onebotWsUrl: 'ws://127.0.0.1:45671',
    onebotHttpUrl: 'http://127.0.0.1:45672', consoleHost: '127.0.0.1', consolePort: 45673,
    modelAuthMarker: RUNTIME_MODEL_AUTH_MARKER });
  assert.deepEqual(source, snapshot, 'original baseline is not mutated');
  assert(originalBusinessSettingsMatch(source, configured));
  for (const section of ['allow', 'runtime', 'proactive', 'reminders', 'timeControl', 'store', 'personality', 'plugins', 'mcp'])
    assert.deepEqual(configured[section], source[section]);
  assert.equal(configured.api.baseUrl, source.api.baseUrl, 'original service identity/thinking lookup must remain unchanged');
  assert.equal(Object.hasOwn(configured.api, 'stream'), false);
  assert.equal(Object.hasOwn(configured.api, 'max_tokens'), false);
  assert.deepEqual(configured.api.extraBody, {});
  assert.equal(configured.api.apiKey, RUNTIME_MODEL_AUTH_MARKER, 'only a public non-credential marker may be persisted');
});

test('business overrides and model-origin rewriting cannot be disguised as deployment connections', () => {
  for (const patch of [{ mode: 'observe' }, { group: Number(TEST_GROUP) }, { maxTokens: 512 }, { modelBaseUrl: 'http://127.0.0.1:1/v1' }, { probability: 100 }])
    assert.throws(() => createOriginalAgentConfig(original(), patch), /ORIGINAL_CONFIG_BUSINESS_PATCH_FORBIDDEN/);
  const changed = original(); changed.proactive.enabled = false;
  assert.equal(originalBusinessSettingsMatch(original(), changed), false);
  const modelChanged = original(); modelChanged.api.baseUrl = 'http://127.0.0.1:1/v1';
  assert.equal(originalBusinessSettingsMatch(original(), modelChanged), false);
});

test('connection changes remain loopback and do not accept real persistent credentials', () => {
  assert.throws(() => createOriginalAgentConfig(original(), { onebotWsUrl: 'ws://example.invalid:1234' }), /LOOPBACK/);
  assert.throws(() => createOriginalAgentConfig(original(), { consoleHost: '0.0.0.0' }), /LOOPBACK/);
  assert.throws(() => createOriginalAgentConfig(original(), { modelAuthMarker: 'synthetic-secret-value' }), /AUTH_MARKER_ONLY/);
  const bad = original(); bad.api.apiKey = 'synthetic-not-a-real-key';
  assert.throws(() => createOriginalAgentConfig(bad), /SOURCE_NOT_SANITIZED/);
});

test('normal config without connection patches is a faithful independent copy', () => {
  const source = original(), configured = createOriginalAgentConfig(source);
  assert.deepEqual(configured, source);
  configured.allow.groups.push(20003);
  assert.equal(source.allow.groups.length, 2);
});
