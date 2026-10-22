import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramBrowserHandler } from '../lib/instagram-browser-route.mjs';
const origin = 'https://analytics.example.com';
const env = { APP_ORIGIN: origin, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', WORKSHOP_ALLOWED_EMAILS: 'team@example.com' };
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = JSON.parse(value); } }; }
const req = input => ({ method: 'POST', url: '/api/connections/instagram-browser', headers: { origin, 'content-type': 'application/json' }, body: input });
test('anonymous management calls never read private credentials or launch a session', async () => {
  let touched = false;
  const handler = createInstagramBrowserHandler({ env, authorize: async (req, res) => { res.statusCode = 401; res.end('{"error":"sign_in_required"}'); }, storeFactory: () => { touched = true; } });
  const res = response(); await handler(req({ action: 'start' }), res);
  assert.equal(res.statusCode, 401); assert.equal(touched, false);
});
test('cross-origin configuration is rejected before authorization, storage or provider access', async () => {
  let touched = false;
  const handler = createInstagramBrowserHandler({ env, authorize: async () => { touched = true; } });
  const res = response(); await handler({ ...req({ action: 'configure', apiKey: 'secret-test' }), headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(touched, false); assert.doesNotMatch(JSON.stringify(res), /secret-test/);
});
test('team status is a sanitized projection, never the private saved browser settings', async () => {
  const handler = createInstagramBrowserHandler({ env, authorize: async () => ({ id: 'team-test' }),
    storeFactory: () => ({ getConnection: async () => ({ credentials: { reportingMode: 'browser-sweep', browser: { apiKey: 'secret-test', provider: 'browserbase', state: 'ready', contextId: 'private-context' } } }) }) });
  const res = response(); await handler({ method: 'GET', url: '/api/connections/instagram-browser', headers: {} }, res);
  assert.equal(res.body.connected, true); assert.doesNotMatch(JSON.stringify(res.body), /secret-test|private-context/);
});
test('start accepts no arbitrary URLs, target accounts or scan parameters', async () => {
  let started = false;
  const handler = createInstagramBrowserHandler({ env, authorize: async () => ({ id: 'team-test' }), storeFactory: () => ({}), start: async () => { started = true; } });
  const res = response(); await handler(req({ action: 'start', url: 'https://untrusted.example' }), res);
  assert.equal(res.statusCode, 400); assert.equal(started, false);
});
test('provider exceptions never expose connection URLs, DOM text or credentials', async () => {
  const handler = createInstagramBrowserHandler({ env, authorize: async () => ({ id: 'team-test' }), storeFactory: () => ({}),
    start: async () => { throw Error('secret-test private-browser-url'); } });
  const res = response(); await handler(req({ action: 'start' }), res);
  assert.equal(res.statusCode, 503); assert.deepEqual(res.body, { error: 'browser_unavailable' });
});
