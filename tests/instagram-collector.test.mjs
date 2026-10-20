import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInstagram } from '../lib/instagram-collector.mjs';
const env={INSTAGRAM_ACCESS_TOKEN:'private-instagram-token',INSTAGRAM_ACCOUNT_ID:'178400012345',INSTAGRAM_API_VERSION:'v24.0'};
const capturedAt='2026-10-20T12:00:00.000Z';
const json=(payload,status=200)=>({ok:status>=200&&status<300,status,json:async()=>payload});
const media=(id='12345',extra={})=>({id,caption:'A matchday pint',media_type:'VIDEO',media_product_type:'REELS',
  permalink:`https://www.instagram.com/reel/short_${id}/?tracking=drop`,timestamp:'2026-09-01T12:00:00+0000',like_count:12,comments_count:3,...extra});
const metric=(name,value)=>({name,period:'lifetime',values:[{value}]});
function fixture({pages=[[media()]],optional='ok',daily='ok',demographics=true,profile={},failPage=false,malformed=false}={}) {
  const requests=[];let page=0;
  return {requests,fetchImpl:async(endpoint,options)=>{
    const url=new URL(endpoint);requests.push({url,options});
    assert.equal(url.origin,'https://graph.instagram.com');
    assert.equal(options.headers.Authorization,`Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`);
    assert.equal(options.redirect,'error');assert.equal(url.searchParams.has('access_token'),false);
    if(url.pathname.endsWith('/media')) {
      if(failPage&&page)return json({},500);
      const rows=pages[page++];
      return json({data:rows,...(page<pages.length?{paging:{next:'https://evil.test/ignored',cursors:{after:`cursor-${page}`}}}:{})});
    }
    if(!url.pathname.endsWith('/insights'))return json({id:env.INSTAGRAM_ACCOUNT_ID,username:'scranpints',followers_count:123,media_count:pages.flat().length,...profile});
    if(url.pathname.endsWith(`/${env.INSTAGRAM_ACCOUNT_ID}/insights`)) {
      if(url.searchParams.get('metric')==='follower_demographics') {
        if(!demographics)return json({data:[]});
        const family=url.searchParams.get('breakdown');
        assert.equal(url.searchParams.get('timeframe'),'this_month');
        return json({data:[{name:'follower_demographics',total_value:{breakdowns:[{dimension_keys:[family],
          results:[{dimension_values:[family==='country'?'GB':family==='age'?'25-34':'M'],value:80}]}]}}]});
      }
      assert.equal(url.searchParams.get('metric_type'),'total_value');
      assert.equal(Number(url.searchParams.get('until'))-Number(url.searchParams.get('since')),86399);
      return daily==='failed'?json({},403):json({data:daily==='empty'?[]:[{name:'views',total_value:{value:10}}]});
    }
    if(optional==='failed')return json({},403);
    if(optional==='shares-unsupported'&&url.searchParams.get('metric')==='views,shares')return json({},400);
    if(optional==='empty')return json({data:[]});
    return json({data:[metric('views',malformed?-1:100),...(url.searchParams.get('metric').includes('shares')?[metric('shares',4)]:[])]});
  }};
}
test('Instagram collects all cursor pages, lifetime counters and native daily/audience without token leakage',async()=>{
  const mock=fixture({pages:[[media('123')],[media('456')]]});
  const result=await collectInstagram({env,capturedAt,...mock});
  assert.equal(result.content.length,2);assert.equal(result.content[1].id,'456');
  assert.equal(result.content[0].url,'https://www.instagram.com/reel/short_123/');
  assert.equal(result.metrics.views,200);assert.equal(result.metrics.likes,24);assert.equal(result.metrics.comments,6);
  assert.equal(result.metrics.shares,8);assert.equal(result.metrics.followers,123);assert.equal(result.metrics.watchHours,null);
  assert.equal(result.counterScope,'public-content-lifetime');assert.equal(result.daily.length,90);
  assert.equal(result.daily[0].day,'2026-07-22');assert.equal(result.daily.at(-1).day,'2026-10-19');
  assert.equal(result.dateRange.end,'2026-10-19');
  assert.equal(result.dateRange.timezone,'UTC');assert.equal(result.daily[0].views,10);
  assert.deepEqual(result.nativeAudience.age,[{label:'25-34',count:80}]);
  assert.deepEqual(result.nativeAudience.country,[{label:'GB',count:80}]);
  assert.doesNotMatch(JSON.stringify(result),/private-instagram-token|cursor-1|evil.test/);
  assert.match(result.scope,/not reporting-period totals/);
});
test('unsupported media metrics and missing daily/demographic reports stay unavailable while core counters save',async()=>{
  const mock=fixture({optional:'shares-unsupported',daily:'empty',demographics:false});
  const result=await collectInstagram({env,capturedAt,...mock});
  assert.equal(result.metrics.views,100);assert.equal(result.metrics.shares,null);assert.equal(result.metrics.likes,12);
  assert.deepEqual(result.daily,[]);assert.equal(result.nativeAudience,undefined);
  assert.match(result.scope,/1 media have unavailable/);assert.match(result.scope,/90 requested daily reports were unavailable/);
  const failed=await collectInstagram({env,capturedAt,...fixture({optional:'failed',daily:'failed',demographics:false})});
  assert.equal(failed.metrics.views,null);assert.equal(failed.content[0].views,null);assert.equal(failed.metrics.followers,123);
  assert.deepEqual(failed.daily,[]);
});
test('Instagram preserves saved daily history and refreshes seven-day overlap instead of reloading ninety days',async()=>{
  const initial=await collectInstagram({env,capturedAt,...fixture()});
  initial.daily.unshift({day:'2026-04-01',views:77});initial.dateRange.start='2026-04-01';
  const mock=fixture({daily:'empty',demographics:false});
  const refreshed=await collectInstagram({env,capturedAt:'2026-10-21T12:00:00.000Z',previous:initial,...mock});
  const dailyRequests=mock.requests.filter(({url})=>url.searchParams.get('metric')==='views'&&url.searchParams.get('metric_type')==='total_value');
  assert.equal(dailyRequests.length,8);assert.deepEqual(refreshed.daily,initial.daily);
  assert.equal(refreshed.dateRange.start,'2026-04-01');assert.match(refreshed.scope,/saved daily rows are retained/);
});
test('Instagram rejects inventory gaps, repeated media, wrong account and unsafe content URLs',async()=>{
  for(const mock of [fixture({pages:[[media('123')],[media('123')]]}),fixture({pages:[[media('123')],[media('456')]],failPage:true}),
    fixture({profile:{username:'wrong'}}),fixture({pages:[[media('123',{permalink:'https://evil.test/p/x/'})]]}),
    fixture({pages:[[media('123',{like_count:-1})]]})])
    await assert.rejects(collectInstagram({env,capturedAt,...mock}));
  await assert.rejects(collectInstagram({env:{...env,INSTAGRAM_ACCESS_TOKEN:''},capturedAt}),{code:'not-configured'});
  await assert.rejects(collectInstagram({env:{...env,INSTAGRAM_ACCOUNT_ID:'../evil'},capturedAt}),{code:'configuration'});
});
test('Instagram optional invalid metric values cannot become negative or made-up zero totals',async()=>{
  const result=await collectInstagram({env,capturedAt,...fixture({malformed:true})});
  assert.equal(result.metrics.views,null);assert.equal(result.metrics.shares,null);
  assert.equal(result.content[0].views,null);
});
test('Instagram request concurrency remains bounded at five',async()=>{
  const mock=fixture({pages:[Array.from({length:12},(_,i)=>media(String(100+i)))]});
  let active=0,highest=0;
  const result=await collectInstagram({env,capturedAt,fetchImpl:async(...args)=>{
    active++;highest=Math.max(highest,active);
    await new Promise(resolve=>setTimeout(resolve,1));
    try{return await mock.fetchImpl(...args);}finally{active--;}
  }});
  assert.equal(result.content.length,12);assert.equal(highest,5);
});
