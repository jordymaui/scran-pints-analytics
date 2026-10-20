export function tiktokStudioFixture() {
  const window={start:'2026-10-18',end:'2026-10-18',timezone:null};
  return {schemaVersion:1,accountUsername:'scranpints',importedAt:'2026-10-20T15:00:00Z',
    performance:{capturedAt:'2026-10-20T14:00:00Z',dateRange:{...window},
      seriesRanges:{overview:{...window},followers:{...window},viewers:{...window}},
      totals:{views:100,profileViews:10,likes:5,comments:2,shares:1,netFollowers:3,totalViewers:null,newViewers:null,returningViewers:null},
      daily:[{date:'2026-10-18',views:100,profileViews:10,likes:5,comments:2,shares:1,followers:170,netFollowers:3,totalViewers:70,newViewers:50,returningViewers:20}]},
    audience:[{population:'followers',capturedAt:'2026-10-20T14:00:00Z',dateRange:{...window},provenance:'studio-csv',
      age:[],gender:[{label:'Male',percentage:67,lessThan:null},{label:'Female',percentage:33,lessThan:null}],
      country:[{label:'GB',percentage:85.8,lessThan:null},{label:'Others',percentage:14.2,lessThan:null}]}]};
}
