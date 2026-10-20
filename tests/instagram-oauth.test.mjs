import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramOAuthConfig, createInstagramFlow, verifyInstagramFlow,
  exchangeInstagramGrant, createInstagramConnectionHandler, INSTAGRAM_SCOPES } from '../lib/instagram-oauth.mjs';
const env = { APP_ORIGIN: 'https://analytics.example.test', SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', WORKSHOP_ALLOWED_EMAILS: 'team@example.test', NODE_ENV: 'production',
  INSTAGRAM_CLIENT_ID: '123456789012345', INSTAGRAM_CLIENT_SECRET: 'test-instagram-client-secret-1234' };
const config = instagramOAuthConfig(env), user = { id: 'team-user' }, now = Date.parse('2026-10-20T12:00:00Z');
const json = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
function response() { return { headers: {}, setHeader(k,v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; }, end(v='') { this.body=v; } }; }
function fixture({ token={}, profile={}, long={}, storeFails=false, wrapped=true }={}) {
  const requests=[],saves=[];
  return { requests,saves, setConnection:async(...args)=>{if(storeFails)throw Error('private');saves.push(args);},
    fetcher:async(endpoint,options)=>{
      requests.push({endpoint,options}); const url=new URL(endpoint);
      if(url.hostname==='api.instagram.com') {
        const row={access_token:'short-private-token',user_id:'12345',permissions:INSTAGRAM_SCOPES.join(','),...token};
        return json(wrapped?{data:[row]}:row);
      }
      if(url.pathname==='/access_token')return json({access_token:'long-private-token',token_type:'bearer',expires_in:5184000,...long});
      assert.equal(url.pathname,`/${config.apiVersion}/me`);
      return json({user_id:'67890',username:'scranpints',...profile});
    } };
}
test('Instagram configuration requires credentials and restricts API/account values',()=>{
  assert.equal(config.callback,`${env.APP_ORIGIN}/api/connections/instagram`);
  assert.equal(config.expectedUsername,'scranpints');
  for(const extra of [{INSTAGRAM_CLIENT_ID:'bad'},{INSTAGRAM_CLIENT_SECRET:'tiny'},
    {INSTAGRAM_EXPECTED_USERNAME:'bad/@x'},{INSTAGRAM_API_VERSION:'v1.0'},{INSTAGRAM_API_VERSION:'https://evil.test'}])
    assert.throws(()=>instagramOAuthConfig({...env,...extra}),{code:'instagram_not_configured'});
});
test('Instagram flow requests only reporting permissions and binds signed state to team session',()=>{
  const flow=createInstagramFlow(config,user,now), url=new URL(flow.authorize);
  assert.equal(url.origin,'https://www.instagram.com');assert.equal(url.pathname,'/oauth/authorize');
  assert.equal(url.searchParams.get('scope'),INSTAGRAM_SCOPES.join(','));
  assert.equal(url.searchParams.get('redirect_uri'),config.callback);
  assert.equal(url.searchParams.get('force_reauth'),'true');
  assert.ok(!url.href.includes(config.clientSecret));assert.ok(!flow.state.includes(user.id));
  const args={config,user,state:flow.state,cookieState:flow.state,now};
  assert.equal(verifyInstagramFlow(args),true);
  for(const extra of [{user:{id:'other'}},{now:now+600000},{now:now-60000},
    {cookieState:''},{state:flow.state+'x'},{state:'A'+flow.state.slice(1),cookieState:'A'+flow.state.slice(1)}])
    assert.throws(()=>verifyInstagramFlow({...args,...extra}),{code:'connection_expired'});
});
test('Instagram exchange validates account and stores only long-lived private grant',async()=>{
  for(const wrapped of [true,false]) {
    const mock=fixture({wrapped}), result=await exchangeInstagramGrant({config,user,code:'single-use-code',now,...mock});
    assert.deepEqual(result,{connected:true,connectedAt:new Date(now).toISOString()});
    assert.equal(mock.saves.length,1);assert.equal(mock.saves[0][0],'instagram');
    assert.equal(mock.saves[0][1].accessToken,'long-private-token');
    assert.equal(mock.saves[0][1].tokenIssuedAt,new Date(now).toISOString());
    assert.equal(mock.saves[0][1].expiresAt,new Date(now+5184000*1000).toISOString());
    assert.equal(mock.saves[0][2].accountId,'67890');
    assert.deepEqual(mock.saves[0][2].scopes,[...INSTAGRAM_SCOPES]);
    assert.doesNotMatch(JSON.stringify(result),/private-token/);
    assert.doesNotMatch(JSON.stringify(mock.saves),/short-private-token/);
    assert.equal(mock.requests[0].options.redirect,'error');
    assert.equal(new URLSearchParams(mock.requests[0].options.body).get('redirect_uri'),config.callback);
    assert.equal(mock.requests[2].options.headers.Authorization,'Bearer long-private-token');
  }
});
test('wrong account, missing/extra scopes, malformed token and persistence failures do not save',async()=>{
  for(const [changes,code] of [[{profile:{username:'other'}},'wrong_instagram_account'],
    [{token:{permissions:INSTAGRAM_SCOPES[0]}},'instagram_scopes_required'],
    [{token:{permissions:INSTAGRAM_SCOPES.join(',')+',instagram_business_content_publish'}},'instagram_scopes_required'],
    [{token:{permissions:undefined}},'instagram_scopes_required'],
    [{long:{expires_in:3600}},'instagram_grant_missing'],[{token:{user_id:'bad'}},'instagram_grant_missing'],
    [{profile:{user_id:'bad'}},'wrong_instagram_account'],[{storeFails:true},'connection_save_failed']]) {
    const mock=fixture(changes);
    await assert.rejects(exchangeInstagramGrant({config,user,code:'code',now,...mock}),{code});
    assert.equal(mock.saves.length,0);
  }
  const mismatch=fixture();
  await assert.rejects(exchangeInstagramGrant({config,user,code:'code',now,existingAccountId:'99999',...mismatch}),{code:'wrong_instagram_account'});
  assert.equal(mismatch.saves.length,0);
  await assert.rejects(exchangeInstagramGrant({config,user,code:'code',now,
    fetcher:async()=>{throw Error('private-client-secret');}}),error=>error.code==='instagram_unavailable'&&!error.message.includes('private-client-secret'));
});
test('Instagram start rejects foreign origin and signed-out sessions',async()=>{
  let calls=0;
  const handler=createInstagramConnectionHandler({env,now:()=>now,authorize:async()=>{calls++;return user;},storeFactory:()=>({})});
  const foreign=response();await handler({method:'POST',url:'/api/connections/instagram',headers:{origin:'https://evil.test'}},foreign);
  assert.equal(foreign.statusCode,403);assert.equal(calls,0);
  const good=response();await handler({method:'POST',url:'/api/connections/instagram',headers:{origin:config.origin}},good);
  assert.equal(good.statusCode,303);assert.equal(new URL(good.getHeader('Location')).origin,'https://www.instagram.com');
  assert.ok(good.getHeader('Set-Cookie').every(v=>v.includes('HttpOnly; Secure; SameSite=Lax; Max-Age=600')));
  const noSession=response(),protectedHandler=createInstagramConnectionHandler({env,storeFactory:()=>{throw Error('must not reach store');}});
  await protectedHandler({method:'POST',url:'/api/connections/instagram',headers:{origin:config.origin}},noSession);
  assert.equal(noSession.statusCode,401);
});
test('Instagram callback rechecks session, verifies unique state/code, clears flow cookie and redirects safely',async()=>{
  const mock=fixture(),flow=createInstagramFlow(config,user,now);let calls=0;
  const handler=createInstagramConnectionHandler({env,now:()=>now,fetcher:mock.fetcher,
    authorize:async()=>{calls++;return user;},storeFactory:()=>({setConnection:mock.setConnection,getConnection:async()=>null})});
  const query=new URLSearchParams({state:flow.state,code:'one-use-code'});
  const request={method:'GET',url:`/api/connections/instagram?${query}`,headers:{cookie:`__Host-sp-instagram-state=${encodeURIComponent(flow.state)}`}};
  const success=response();await handler(request,success);
  assert.equal(calls,1);assert.equal(success.getHeader('Location'),'/connections.html?connected=instagram');
  assert.ok(success.getHeader('Set-Cookie').every(v=>v.includes('Max-Age=0')));assert.equal(mock.saves.length,1);
  assert.equal(success.getHeader('Cache-Control'),'private, no-store, max-age=0');
  for(const url of [request.url+'&state=other',request.url+'&code=other',request.url+'&error=access_denied']) {
    const failed=response();await handler({...request,url},failed);
    assert.match(failed.getHeader('Location'),/^\/connections.html\?error=(connection_expired|consent_cancelled)$/);
  }
  assert.equal(mock.saves.length,1);
});
