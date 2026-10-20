const FIELDS = ['views', 'profileViews', 'likes', 'comments', 'shares', 'followers', 'netFollowers', 'totalViewers', 'newViewers', 'returningViewers'];
const TOTALS = FIELDS.filter(key => key !== 'followers');
const GROUPS = { overview: ['views', 'profileViews', 'likes', 'comments', 'shares'], followers: ['followers', 'netFollowers'], viewers: ['totalViewers', 'newViewers', 'returningViewers'] };
const CSV_FIELDS = {
  overview: ['Date', 'Video Views', 'Profile Views', 'Likes', 'Comments', 'Shares'],
  followers: ['Date', 'Followers', 'Difference in followers from previous day'],
  viewers: ['Date', 'Total Viewers', 'New Viewers', 'Returning Viewers'],
  followerGender: ['Gender', 'Distribution'], followerTopTerritories: ['Top territories', 'Distribution'],
};
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MAX_DAYS = 20000;
export class TikTokStudioError extends Error {
  constructor(message, code = 'invalid-studio-report') { super(message); this.name = 'TikTokStudioError'; this.code = code; }
}
const fail = message => { throw new TikTokStudioError(message); };
function object(value, keys, name, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail(`${name} contains missing or unsupported fields.`);
}
function text(value, name, max = 150) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u001f\u007f]/.test(value) || /(?:\bBearer\s|\b(?:access|refresh)[_-]?token\s*[:=]|\bclient[_-]?secret\s*[:=]|[A-Za-z]:[\\/]|\/Users\/|\/home\/)/i.test(value)) fail(`${name} must be safe public text.`);
  return value.trim();
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail('A real ISO calendar date is required.');
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('An explicit capture timestamp and timezone are required.');
  day(value.slice(0,10)); return value;
}
const move = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0,10);
function dateRange(value) {
  object(value, ['start','end','timezone'], 'Date range');
  const start=day(value.start), end=day(value.end);
  if (start>end || (Date.parse(end)-Date.parse(start))/86400000 >= MAX_DAYS) fail('The reporting date range is invalid or too large.');
  if (value.timezone !== null) {
    text(value.timezone,'Timezone',100);
    try { new Intl.DateTimeFormat('en',{timeZone:value.timezone}).format(); } catch { fail('The reporting timezone is invalid.'); }
  }
  return {start,end,timezone:value.timezone};
}
function amount(value, key) {
  if (value===null) return null;
  if (!Number.isSafeInteger(value) || (key!=='netFollowers' && value<0)) fail(`Invalid ${key} count.`);
  return value;
}
function numberCell(value, key) {
  const raw=value.trim();
  if (['','undefined','null','n/a','--','—'].includes(raw.toLowerCase())) return null;
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) fail(`Invalid ${key} cell.`);
  return amount(Number(raw.replaceAll(',','')), key);
}
function table(csv, kind) {
  if (typeof csv!=='string' || !csv.length || csv.length>20000000) fail('A supported CSV file is required.');
  const source=csv.replace(/^\uFEFF/,'');
  const rows=[]; let row=[], cell='', quoted=false, closed=false;
  function pushCell(){row.push(cell);cell='';closed=false;}
  function pushRow(){pushCell();if(row.some(value=>value.trim()!==''))rows.push(row);row=[];}
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(quoted){if(c==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closed)fail('Malformed CSV quotation.');quoted=true;continue;}
    if(c===','){pushCell();continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'&&source[i+1]==='\n')i++;pushRow();continue;}
    if(closed){if(c===' '||c==='\t')continue;fail('Unexpected text after a quoted CSV field.');}
    cell+=c;
  }
  if(quoted)fail('Unclosed CSV quotation.');
  if(cell||row.length||closed)pushRow();
  const headers=rows.shift()?.map(value=>value.trim());
  const expected=CSV_FIELDS[kind];
  if(!headers || headers.length!==expected.length || headers.some((value,index)=>value!==expected[index])) fail(`Unexpected ${kind} CSV columns.`);
  if(!rows.length || rows.length>MAX_DAYS || rows.some(values=>values.length!==headers.length))fail(`The ${kind} CSV has missing or malformed rows.`);
  return rows;
}
function labelledDay(value, range) {
  if(/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const date=day(value.trim());if(date<range.start||date>range.end)fail('A CSV date is outside its explicit reporting window.');return date;
  }
  const match=/^(\d{1,2})\s+([A-Za-z]+)(?:,?\s+(\d{4}))?$/.exec(value.trim());
  if(!match)fail('Unrecognized CSV date label.');
  const month=MONTHS.findIndex(name=>name===match[2].toLowerCase()||name.slice(0,3)===match[2].toLowerCase())+1;
  if(!month)fail('Unrecognized CSV month.');
  const candidates=[];
  for(let year=Number(range.start.slice(0,4));year<=Number(range.end.slice(0,4));year++) {
    if(match[3]&&year!==Number(match[3]))continue;
    const candidate=`${year}-${String(month).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
    if(Number.isFinite(Date.parse(candidate))&&new Date(candidate).toISOString().slice(0,10)===candidate&&candidate>=range.start&&candidate<=range.end)candidates.push(candidate);
  }
  if(candidates.length!==1)fail('Yearless CSV dates are ambiguous or outside the explicit reporting window.');
  return candidates[0];
}
function series(source, kind) {
  if(!source)fail(`The ${kind} CSV and its explicit date window are required.`);
  const range=dateRange(source.dateRange), capturedAt=instant(source.capturedAt), seen=new Set();
  const rows=table(source.csv,kind).map(values=>{
    const date=labelledDay(values[0],range);
    if(seen.has(date))fail(`Duplicate ${kind} CSV date.`);seen.add(date);
    return {date,...Object.fromEntries(GROUPS[kind].map((key,index)=>[key,numberCell(values[index+1],key)]))};
  }).sort((a,b)=>a.date.localeCompare(b.date));
  return {range,capturedAt,rows};
}
function percentageCell(value) {
  const raw=value.trim();
  if(['','undefined','null','n/a'].includes(raw.toLowerCase()))return null;
  if(!/^(?:0(?:\.\d{1,12})?|1(?:\.0{1,12})?)$/.test(raw))fail('Demographic distributions must be exported fractions from zero to one.');
  const [whole,fraction='']=raw.split('.');
  const digits=(whole+fraction).padEnd(whole.length+2,'0'), point=whole.length+2;
  return Number(`${digits.slice(0,point)}.${digits.slice(point)||'0'}`);
}
function distribution(source, kind) {
  const range=dateRange(source.dateRange),capturedAt=instant(source.capturedAt),seen=new Set();
  const rows=table(source.csv,kind).map(([rawLabel,value])=>{
    const label=text(rawLabel,'Demographic label',100),key=label.toLowerCase();
    if(seen.has(key))fail('Duplicate demographic bucket.');seen.add(key);
    return {label,percentage:percentageCell(value),lessThan:null};
  });
  return {range,capturedAt,rows};
}
function buckets(rows,name) {
  if(!Array.isArray(rows)||rows.length>100)fail(`Invalid ${name} buckets.`);
  const seen=new Set();
  return rows.map(row=>{
    object(row,['label','percentage','lessThan'],name);
    const label=text(row.label,'Bucket label',100),key=label.toLowerCase();
    if(seen.has(key))fail('Duplicate audience bucket.');seen.add(key);
    if(row.percentage!==null&&(!Number.isFinite(row.percentage)||row.percentage<0||row.percentage>100))fail('Invalid reported percentage.');
    if(row.lessThan!==null&&(!Number.isFinite(row.lessThan)||row.lessThan<=0||row.lessThan>100||row.percentage!==null))fail('Invalid censored percentage.');
    return {label,percentage:row.percentage,lessThan:row.lessThan};
  });
}
function sum(rows,key,range) {
  const selected=rows.filter(row=>row.date>=range.start&&row.date<=range.end);
  if(selected.length!==(Date.parse(range.end)-Date.parse(range.start))/86400000+1 || selected.some(row=>row[key]===null))return null;
  const value=selected.reduce((total,row)=>total+row[key],0);return amount(value,key);
}
export function validateTikTokStudioReport(value) {
  object(value,['schemaVersion','accountUsername','importedAt','performance','audience'],'TikTok Studio report',['trafficSources']);
  if(value.schemaVersion!==1||value.accountUsername!=='scranpints')fail('Only the Scran & Pints TikTok Studio report is accepted.');
  const importedAt=instant(value.importedAt),p=value.performance;
  object(p,['capturedAt','dateRange','seriesRanges','totals','daily'],'Performance');
  const capturedAt=instant(p.capturedAt),range=dateRange(p.dateRange);
  if(Date.parse(capturedAt)>Date.parse(importedAt))fail('Capture cannot be later than import time.');
  object(p.seriesRanges,Object.keys(GROUPS),'Series date ranges');
  const seriesRanges=Object.fromEntries(Object.keys(GROUPS).map(key=>[key,dateRange(p.seriesRanges[key])]));
  const ranges=Object.values(seriesRanges);
  if(range.start!==ranges.map(item=>item.start).sort()[0]||range.end!==ranges.map(item=>item.end).sort().at(-1))fail('The combined date range must match the exported series.');
  if(ranges.some(item=>item.end>capturedAt.slice(0,10)))fail('Report dates cannot be later than capture.');
  if(!Array.isArray(p.daily)||!p.daily.length||p.daily.length>MAX_DAYS)fail('Invalid daily reporting rows.');
  const seen=new Set();
  const daily=p.daily.map(row=>{
    object(row,['date',...FIELDS],'Daily row');const date=day(row.date);
    if(seen.has(date)||date<range.start||date>range.end)fail('Daily dates must be unique and inside the reporting window.');seen.add(date);
    const result={date,...Object.fromEntries(FIELDS.map(key=>[key,amount(row[key],key)]))};
    for(const [family,keys] of Object.entries(GROUPS))if(date<seriesRanges[family].start||date>seriesRanges[family].end)
      if(keys.some(key=>result[key]!==null))fail('Metrics outside their exported series window must remain unavailable.');
    if(result.totalViewers!==null&&result.newViewers!==null&&result.returningViewers!==null&&result.totalViewers!==result.newViewers+result.returningViewers)fail('Daily viewer counts do not reconcile.');
    return result;
  }).sort((a,b)=>a.date.localeCompare(b.date));
  object(p.totals,TOTALS,'Performance totals');
  const totals=Object.fromEntries(TOTALS.map(key=>[key,amount(p.totals[key],key)]));
  for(const key of GROUPS.overview)if(totals[key]!==sum(daily,key,seriesRanges.overview))fail('Performance totals must match complete exported rows.');
  if(totals.netFollowers!==sum(daily,'netFollowers',seriesRanges.followers))fail('Net followers must use reported daily changes.');
  if(['totalViewers','newViewers','returningViewers'].some(key=>totals[key]!==null))fail('Daily viewer counts cannot establish unique viewers for the reporting period.');
  if(!Array.isArray(value.audience)||value.audience.length>2)fail('Invalid audience reports.');
  const populations=new Set();
  const audience=value.audience.map(entry=>{
    object(entry,['population','capturedAt','dateRange','provenance','age','gender','country'],'Audience');
    if(!['viewers','followers'].includes(entry.population)||populations.has(entry.population)||!['studio-csv','studio-screen','studio-csv-and-screen'].includes(entry.provenance))fail('Audience reports need one entry for each reported population.');
    populations.add(entry.population);const at=instant(entry.capturedAt),window=dateRange(entry.dateRange);
    if(Date.parse(at)>Date.parse(importedAt)||window.end>at.slice(0,10))fail('Audience dates cannot be later than capture/import.');
    return {population:entry.population,capturedAt:at,dateRange:window,provenance:entry.provenance,
      age:buckets(entry.age,'Age'),gender:buckets(entry.gender,'Gender'),country:buckets(entry.country,'Country')};
  });
  let trafficSources;
  if(value.trafficSources!==undefined) {
    const entry=value.trafficSources;object(entry,['capturedAt','dateRange','rows'],'Traffic sources');
    const at=instant(entry.capturedAt),window=dateRange(entry.dateRange);
    if(Date.parse(at)>Date.parse(importedAt)||window.end>at.slice(0,10))fail('Traffic dates cannot be later than capture/import.');
    trafficSources={capturedAt:at,dateRange:window,rows:buckets(entry.rows,'Traffic source')};
  }
  return {schemaVersion:1,accountUsername:'scranpints',importedAt,
    performance:{capturedAt,dateRange:range,seriesRanges,totals,daily},audience,...(trafficSources?{trafficSources}:{})};
}
export function normalizeTikTokStudioCsv({accountUsername='scranpints',importedAt,sources,audience=[],trafficSources}={}) {
  if(!sources||typeof sources!=='object')fail('CSV source files and explicit date windows are required.');
  const parsed=Object.fromEntries(Object.keys(GROUPS).map(key=>[key,series(sources[key],key)]));
  const seriesRanges=Object.fromEntries(Object.entries(parsed).map(([key,value])=>[key,value.range]));
  const ranges=Object.values(seriesRanges),start=ranges.map(value=>value.start).sort()[0],end=ranges.map(value=>value.end).sort().at(-1);
  const dateRangeValue=dateRange({start,end,timezone:ranges.every(value=>value.timezone===ranges[0].timezone)?ranges[0].timezone:null});
  const dates=new Map();for(let date=start;date<=end;date=move(date,1))dates.set(date,{date,...Object.fromEntries(FIELDS.map(key=>[key,null]))});
  for(const value of Object.values(parsed))for(const row of value.rows)Object.assign(dates.get(row.date),row);
  const daily=[...dates.values()];
  const totals={...Object.fromEntries(GROUPS.overview.map(key=>[key,sum(daily,key,seriesRanges.overview)])),
    netFollowers:sum(daily,'netFollowers',seriesRanges.followers),totalViewers:null,newViewers:null,returningViewers:null};
  const capturedAt=Object.values(parsed).map(value=>value.capturedAt).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1);
  const entries=[...audience];
  const gender=sources.followerGender?distribution(sources.followerGender,'followerGender'):null;
  const country=sources.followerTopTerritories?distribution(sources.followerTopTerritories,'followerTopTerritories'):null;
  if(gender||country) {
    const metadata=gender||country;
    if(gender&&country&&(gender.capturedAt!==country.capturedAt||JSON.stringify(gender.range)!==JSON.stringify(country.range)))fail('Follower distributions must have matching capture and date windows.');
    if(entries.some(entry=>entry.population==='followers'))fail('Add screen follower age after normalizing the exported follower distributions.');
    entries.push({population:'followers',capturedAt:metadata.capturedAt,dateRange:metadata.range,provenance:'studio-csv',age:[],gender:gender?.rows||[],country:country?.rows||[]});
  }
  return validateTikTokStudioReport({schemaVersion:1,accountUsername,importedAt,performance:{capturedAt,dateRange:dateRangeValue,seriesRanges,totals,daily},
    audience:entries,...(trafficSources!==undefined?{trafficSources}:{})});
}
export function normalizeTikTokStudioCSVs({files,capturedAt,importedAt=capturedAt,accountUsername='scranpints',overviewRange,viewersRange,audience=[],trafficSources}={}) {
  if(!Array.isArray(files)||files.length>20)fail('Choose the TikTok Studio CSV files.');
  const names={'overview.csv':'overview','followerhistory.csv':'followers','viewers.csv':'viewers','followergender.csv':'followerGender','followertopterritories.csv':'followerTopTerritories'};
  const sources={};
  for(const file of files) {
    if(!file||typeof file.name!=='string'||/[\\/]/.test(file.name))fail('CSV filenames must not contain paths.');
    if(file.name.toLowerCase()==='followeractivity.csv')continue;
    const key=names[file.name.toLowerCase()];
    if(!key||sources[key])fail('Choose each supported TikTok CSV once.');
    sources[key]={csv:file.text,capturedAt,dateRange:key==='viewers'?viewersRange:overviewRange};
  }
  return normalizeTikTokStudioCsv({accountUsername,importedAt,sources,audience,trafficSources});
}
export function mergeTikTokStudioReports(previous,incoming) {
  const next=validateTikTokStudioReport(incoming);if(!previous)return next;
  const prior=validateTikTokStudioReport(previous);
  if(Date.parse(next.performance.capturedAt)<Date.parse(prior.performance.capturedAt))throw new TikTokStudioError('An older performance capture cannot replace the saved report.','stale-studio-report');
  const audience=new Map(prior.audience.map(entry=>[entry.population,entry]));
  for(const entry of next.audience) {
    const old=audience.get(entry.population);
    if(old&&Date.parse(old.capturedAt)>Date.parse(entry.capturedAt))continue;
    if(old&&old.capturedAt===entry.capturedAt&&JSON.stringify(old.dateRange)===JSON.stringify(entry.dateRange)) {
      const merged={...entry};for(const family of ['age','gender','country'])if(!merged[family].length)merged[family]=old[family];
      if(old.provenance!==entry.provenance)merged.provenance='studio-csv-and-screen';audience.set(entry.population,merged);
    }else audience.set(entry.population,entry);
  }
  let trafficSources=next.trafficSources||prior.trafficSources;
  if(prior.trafficSources&&next.trafficSources&&Date.parse(prior.trafficSources.capturedAt)>Date.parse(next.trafficSources.capturedAt))trafficSources=prior.trafficSources;
  const importedAt=[prior.importedAt,next.importedAt].sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1);
  return validateTikTokStudioReport({...next,importedAt,audience:[...audience.values()],...(trafficSources?{trafficSources}:{})});
}
