export const complexEntries = [
 {type:'label',id:'tag',parentId:'u',targetId:'u',label:'保留标签'},
 {type:'message',id:'kept',parentId:'tag',message:{role:'user',content:'Keep /original/absolute/path',timestamp:2}},
 {type:'compaction',id:'compact',parentId:'kept',firstKeptEntryId:'tag',summary:'Earlier context summary',tokensBefore:50},
 {type:'context_edit',id:'edit',parentId:'compact',targetId:'kept',replacement:{content:'Edited retained context'}},
 {type:'message',id:'other-branch',parentId:'u',message:{role:'user',content:'UNSELECTED BRANCH',timestamp:3}},
 {type:'message',id:'selected',parentId:'edit',message:{role:'user',content:'Selected final context',timestamp:4}},
 {type:'label',id:'offpath-tag',parentId:'other-branch',targetId:'kept',label:'全树标签重连'},
 {type:'session_info',id:'last',parentId:'selected',name:'Complex source'},
];

