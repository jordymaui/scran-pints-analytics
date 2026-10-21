import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const dashboard=await readFile(new URL('../dashboard.js',import.meta.url),'utf8');
const connections=await readFile(new URL('../connections.js',import.meta.url),'utf8');
function source(){return {id:'instagram',provenance:{kind:'manual-browser'},metrics:{followers:321,views:null},content:[],daily:[],manualCapture:{
 method:'manual-browser-inspection',capturedAt:'2026-02-15T09:15:24.485Z',followers:321,contentCoverage:'sample',
 windows:[7,30,90].map(periodDays=>({periodDays,label:`Last ${periodDays} days`,instagramViews:periodDays===90?123450:periodDays*1000,
 facebookViews:0,viewers:100,interactions:12,accountsEngaged:8,profileVisits:5,externalLinkTaps:0,profileActivity:5,
 viewAudience:[{label:'Non-followers',percentage:90}],viewContentTypes:[{label:'Reels',percentage:100}],interactionAudience:[]})),
 content:[{id:'captured-sample',url:null,capturedAt:'2026-02-15T09:15:24.485Z',reportingWindow:'not-shown',views:1234,viewers:100,interactions:12,likes:8,comments:1,saves:2,shares:1}]}};}
const dashboardContext=vm.createContext({range:'28d',esc:value=>String(value??''),date:value=>String(value).slice(0,10),
 num:value=>Number.isFinite(value)?new Intl.NumberFormat('en-GB').format(value):'—'});
vm.runInContext(dashboard.slice(dashboard.indexOf('function manualInstagram(s)'),dashboard.indexOf('function sidebar()')),dashboardContext);
vm.runInContext(dashboard.slice(dashboard.indexOf('function manualInstagramBreakdown('),dashboard.indexOf('function metricCards()')),dashboardContext);
test('Instagram manual overview shows the exact native window, genuine zeroes and capture date without fabricated history',()=>{
 const value=source(),before=JSON.stringify(value);
 assert.equal(dashboardContext.instagramManualWindow(value).periodDays,90);
 assert.equal(dashboardContext.instagramManualWindow(value,'7d').periodDays,7);
 assert.equal(dashboardContext.instagramManualWindow(value,'30d').periodDays,30);
 const html=dashboardContext.manualInstagramPanel(value);
 assert.match(html,/123,450/);assert.match(html,/Last 90 days/);assert.match(html,/2026-02-15/);
 assert.match(html,/Facebook views/);assert.match(html,/>0<\/b>/);
 assert.match(html,/Daily values and previous-period growth were not captured/);
 assert.match(html,/not all-time performance/);assert.doesNotMatch(html,/lifetime views|0 videos|is not connected/);
 assert.equal(JSON.stringify(value),before);
});
test('Instagram sample is separate from the uncaptured full library and does not invent a permalink or thumbnail',()=>{
 const value=source(),html=dashboardContext.instagramSamplePanel(value,true),items=dashboardContext.displayedContent(value);
 assert.equal(items.length,1);assert.equal(items[0].sample,true);assert.equal(items[0].url,null);assert.equal(items[0].publishedAt,null);
 assert.match(html,/Sample · full inventory not captured/);assert.match(html,/does not represent the full Instagram library/);
 assert.match(html,/Reporting window was not shown/);assert.match(html,/1,234/);
 assert.doesNotMatch(html,/<img|Watch video|videos tracked|href="null"/);
 assert.match(dashboard,/manualInstagram\(s\)\?manualInstagramPanel\(s\):performance\(s\)/);
});
test('Connections distinguishes a public native capture from the unconnected API and keeps API controls disabled',()=>{
 const fields=new Map();
 const node=key=>{if(!fields.has(key))fields.set(key,{textContent:'',innerHTML:'',disabled:false,hidden:false});return fields.get(key);};
 const cards=new Map();for(const id of ['youtube','youtube-shorts','instagram','tiktok'])cards.set(id,{querySelector:selector=>node(`${id}:${selector}`)});
 const context=vm.createContext({sourceIds:[...cards.keys()],sourceNames:{instagram:'Instagram',youtube:'YouTube','youtube-shorts':'YouTube Shorts',tiktok:'TikTok'},
  current:{configured:true,setup:{},platforms:[{id:'instagram',connected:false,hasSnapshot:true,capturedAt:'2026-02-15T09:15:24.485Z'}]},instagramManualCapture:null,
  teamAccess:false,busySource:null,statusPending:false,reviewedStudioReport:null,formatDate:value=>value,escapeHTML:value=>String(value),
  document:{querySelectorAll:()=>[]},$:selector=>{const match=/\[data-source="([^"]+)"\]/.exec(selector);return match?cards.get(match[1]):node(selector);}});
 vm.runInContext(connections.slice(connections.indexOf('function instagramCapturedReport('),connections.indexOf('const studioImportErrors')),context);
 const value=source();context.instagramManualCapture=context.instagramCapturedReport(value);context.renderStatus();
 assert.equal(node('instagram:[data-field="status"]').textContent,'Native capture available');
 assert.match(node('instagram:[data-field="details"]').innerHTML,/API connection<\/dt><dd>Not connected/);
 assert.match(node('instagram:[data-field="details"]').innerHTML,/123,450/);assert.match(node('instagram:[data-field="details"]').innerHTML,/321/);
 assert.match(node('instagram:[data-field="details"]').innerHTML,/Latest saved API collection<\/dt><dd>Not collected through API/);
 assert.match(node('instagram:[data-field="help"]').textContent,/API is not connected/);
 assert.match(node('instagram:[data-field="help"]').textContent,/Refresh does not update this manual capture/);
 assert.equal(node('instagram:[data-sync]').disabled,true);assert.equal(context.current.platforms[0].connected,false);
 assert.equal(context.instagramCapturedReport({...value,id:'tiktok'}),null);
 context.current.configured=false;context.renderStatus();
 assert.match(node('instagram:[data-field="help"]').textContent,/connection status could not be verified/);
 assert.doesNotMatch(node('instagram:[data-field="help"]').textContent,/API is not connected/);
});
