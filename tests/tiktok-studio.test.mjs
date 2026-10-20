import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTikTokStudioCSVs,normalizeTikTokStudioCsv,validateTikTokStudioReport,mergeTikTokStudioReports} from '../lib/tiktok-studio.mjs';
import {tiktokStudioFixture} from './fixtures/tiktok-studio.mjs';
const capturedAt='2026-10-20T16:00:00Z';
const range={start:'2026-10-17',end:'2026-10-18',timezone:null};
function input() {return {capturedAt,overviewRange:{...range},viewersRange:{...range},files:[
 {name:'Overview.csv',text:'\uFEFF"Date","Video Views","Profile Views","Likes","Comments","Shares"\r\n"17 October","1,000","10","5","0","2"\r\n"18 October","0","0","0","0","0"\r\n'},
 {name:'FollowerHistory.csv',text:'"Date","Followers","Difference in followers from previous day"\n"17 October","undefined","-2"\n"18 October","170","0"\n'},
 {name:'Viewers.csv',text:'"Date","Total Viewers","New Viewers","Returning Viewers"\n"17 October","undefined","0","0"\n"18 October","30","20","10"\n'},
 {name:'FollowerGender.csv',text:'"Gender","Distribution"\n"Male","0.67"\n"Female","0.33"\n"Other","0"'},
 {name:'FollowerTopTerritories.csv',text:'"Top territories","Distribution"\n"GB","0.858"\n"United States, other","0.03"\n"Others","0.112"'}]};}
test('CSV import preserves real zeroes/undefined, quoted commas/BOM and separates stocks, changes and unique viewers',()=>{
 const result=normalizeTikTokStudioCSVs(input());
 assert.equal(result.performance.totals.views,1000);assert.equal(result.performance.totals.comments,0);
 assert.equal(result.performance.totals.netFollowers,-2);assert.equal(result.performance.daily[0].followers,null);
 assert.equal(result.performance.daily[1].followers,170);assert.equal(result.performance.daily[1].netFollowers,0);
 assert.equal(result.performance.daily[0].totalViewers,null);assert.equal(result.performance.daily[0].newViewers,0);
 assert.equal(result.performance.totals.totalViewers,null);assert.equal(result.performance.totals.newViewers,null);
 assert.deepEqual(result.audience[0].gender.at(-1),{label:'Other',percentage:0,lessThan:null});
 assert.deepEqual(result.audience[0].country.at(-1),{label:'Others',percentage:11.2,lessThan:null});
 assert.equal(result.audience[0].country[1].label,'United States, other');assert.equal(result.performance.dateRange.timezone,null);
 assert.deepEqual(validateTikTokStudioReport(result),result);
});
test('different explicit series windows anchor years correctly and retain unmatched dates as missing',()=>{
 const value=input();value.overviewRange={start:'2025-10-19',end:'2026-10-18',timezone:null};
 value.viewersRange={start:'2025-10-20',end:'2026-10-19',timezone:null};
 value.files[0].text='Date,Video Views,Profile Views,Likes,Comments,Shares\n19 October,1,0,0,0,0\n18 October,2,0,0,0,0';
 value.files[1].text='Date,Followers,Difference in followers from previous day\n19 October,undefined,0\n18 October,170,0';
 value.files[2].text='Date,Total Viewers,New Viewers,Returning Viewers\n20 October,undefined,0,0\n19 October,undefined,0,0';
 const result=normalizeTikTokStudioCSVs(value);
 assert.equal(result.performance.daily.length,366);
 assert.equal(result.performance.daily[0].date,'2025-10-19');assert.equal(result.performance.daily[0].views,1);
 assert.equal(result.performance.daily.at(-1).date,'2026-10-19');assert.equal(result.performance.daily.at(-1).views,null);
 assert.equal(result.performance.daily.at(-1).newViewers,0);assert.equal(result.performance.totals.views,null);
 assert.deepEqual(result.performance.seriesRanges.overview,value.overviewRange);
 assert.deepEqual(result.performance.seriesRanges.viewers,value.viewersRange);
});
test('yearless dates require an explicit unambiguous real window and duplicate dates are rejected',()=>{
 const missing=input();delete missing.overviewRange;assert.throws(()=>normalizeTikTokStudioCSVs(missing),/Date range/);
 const ambiguous=input();ambiguous.overviewRange={start:'2025-10-17',end:'2026-10-18',timezone:null};
 assert.throws(()=>normalizeTikTokStudioCSVs(ambiguous),/ambiguous/);
 const impossible=input();impossible.files[0].text=impossible.files[0].text.replace('17 October','31 February');
 assert.throws(()=>normalizeTikTokStudioCSVs(impossible),/outside/);
 const duplicate=input();duplicate.files[0].text=duplicate.files[0].text.replace('18 October','17 October');
 assert.throws(()=>normalizeTikTokStudioCSVs(duplicate),/Duplicate/);
 const badDay=input();badDay.overviewRange.start='2026-02-30';assert.throws(()=>normalizeTikTokStudioCSVs(badDay),/real ISO/);
});
test('malformed CSV, invalid counts, files, percentages and unexpected schema fields fail closed',()=>{
 for(const mutate of [
  value=>{value.files[0].text+='"unclosed';},
  value=>{value.files[0].text=value.files[0].text.replace('"1,000"','"1.5"');},
  value=>{value.files[0].text=value.files[0].text.replace('"1,000"','"-1"');},
  value=>{value.files[0].text=value.files[0].text.replace('"1,000"','"=SUM(1)"');},
  value=>{value.files[0].text=value.files[0].text.replace('"Shares"','"Other"');},
  value=>{value.files.push({...value.files[0]});},
  value=>{value.files[0].name='../Overview.csv';},
  value=>{value.files[3].text=value.files[3].text.replace('"0.67"','"67"');},
  value=>{value.files[3].text=value.files[3].text.replace('"Other"','"Male"');},
 ]){const value=input();mutate(value);assert.throws(()=>normalizeTikTokStudioCSVs(value));}
 const source=tiktokStudioFixture();source.credentials='private';assert.throws(()=>validateTikTokStudioReport(source),/unsupported/);
 const nested=tiktokStudioFixture();nested.performance.daily[0].rawToken='private';assert.throws(()=>validateTikTokStudioReport(nested),/unsupported/);
 const badTotals=tiktokStudioFixture();badTotals.performance.totals.views=101;assert.throws(()=>validateTikTokStudioReport(badTotals),/must match/);
 const unique=tiktokStudioFixture();unique.performance.totals.totalViewers=70;assert.throws(()=>validateTikTokStudioReport(unique),/unique viewers/);
});
test('screen evidence preserves exact percentages and censored thresholds without renormalizing',()=>{
 const report=tiktokStudioFixture();
 report.audience.push({population:'viewers',capturedAt:'2026-10-20T14:00:00Z',dateRange:{...range},provenance:'studio-screen',
  age:[{label:'18-24',percentage:38.5,lessThan:null}],gender:[],country:[{label:'UK',percentage:89.4,lessThan:null},{label:'Spain',percentage:null,lessThan:1}]});
 report.trafficSources={capturedAt:'2026-10-20T14:00:00Z',dateRange:{...range},rows:[{label:'For You',percentage:91.8,lessThan:null},{label:'Following',percentage:0,lessThan:null}]};
 const result=validateTikTokStudioReport(report);
 assert.equal(result.audience[1].country[1].percentage,null);assert.equal(result.audience[1].country[1].lessThan,1);
 assert.equal(result.trafficSources.rows[1].percentage,0);
 const both=structuredClone(report);both.audience[1].country[1].percentage=0.5;assert.throws(()=>validateTikTokStudioReport(both),/censored/);
 const duplicate=structuredClone(report);duplicate.audience.push({...report.audience[0]});assert.throws(()=>validateTikTokStudioReport(duplicate));
});
test('same-capture merge retains absent evidence; newer populations replace older missing dimensions honestly',()=>{
 const old=tiktokStudioFixture();old.audience[0].age=[{label:'25-34',percentage:40,lessThan:null}];old.audience[0].provenance='studio-csv-and-screen';
 const incoming=tiktokStudioFixture();const merged=mergeTikTokStudioReports(old,incoming);
 assert.deepEqual(merged.audience[0].age,old.audience[0].age);assert.equal(merged.audience[0].provenance,'studio-csv-and-screen');
 const absent=tiktokStudioFixture();absent.audience=[];assert.deepEqual(mergeTikTokStudioReports(old,absent).audience,old.audience);
 const newer=tiktokStudioFixture();newer.importedAt='2026-10-21T15:00:00Z';newer.performance.capturedAt='2026-10-21T14:00:00Z';newer.audience[0].capturedAt='2026-10-21T14:00:00Z';
 assert.deepEqual(mergeTikTokStudioReports(old,newer).audience[0].age,[]);
 const stale=tiktokStudioFixture();stale.performance.capturedAt='2026-10-19T14:00:00Z';assert.throws(()=>mergeTikTokStudioReports(old,stale),{code:'stale-studio-report'});
 assert.deepEqual(mergeTikTokStudioReports(null,incoming),validateTikTokStudioReport(incoming));
});
test('low-level source normalizer accepts explicit metadata without leaking raw files',()=>{
 const source=input();const names={ 'Overview.csv':'overview','FollowerHistory.csv':'followers','Viewers.csv':'viewers','FollowerGender.csv':'followerGender','FollowerTopTerritories.csv':'followerTopTerritories'};
 const sources=Object.fromEntries(source.files.map(file=>[names[file.name],{csv:file.text,capturedAt,dateRange:{...range}}]));
 const result=normalizeTikTokStudioCsv({accountUsername:'scranpints',importedAt:capturedAt,sources});
 assert.equal(result.performance.totals.views,1000);assert.doesNotMatch(JSON.stringify(result),/"csv":|Overview\.csv|Date,Video/);
 const changed=structuredClone(sources);changed.followerGender.capturedAt='2026-10-20T15:00:00Z';
 assert.throws(()=>normalizeTikTokStudioCsv({importedAt:capturedAt,sources:changed}),/matching capture/);
});
