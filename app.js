// v7 - 在 v6-2 基礎上擴充，保留原有功能。
import * as cloud from './cloud.js?v=7';

const $=id=>document.getElementById(id);
const $all=s=>[...document.querySelectorAll(s)];
const DEFAULT={topics:[{id:'taichung',name:'台中',terms:['台中']},{id:'chen-shu-hua',name:'陳淑華',terms:['陳淑華']},{id:'chen-yu-rong',name:'陳俞融',terms:['陳俞融']},{id:'chang-fen-yu',name:'張芬郁',terms:['張芬郁']}],sources:[{name:'自由時報',site_query:'news.ltn.com.tw',home_url:'https://search.ltn.com.tw/'},{name:'三立新聞',site_query:'setn.com',home_url:'https://www.setn.com/'},{name:'中央社',site_query:'cna.com.tw',home_url:'https://www.cna.com.tw/'},{name:'民視新聞',site_query:'ftvnews.com.tw',home_url:'https://www.ftvnews.com.tw/SearchResult.aspx'},{name:'聯合報',site_query:'udn.com',home_url:'https://udn.com/'},{name:'鏡新聞',site_query:'mnews.tw',home_url:'https://www.mnews.tw/'}]};
const dateTW=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const now=dateTW();
const state={catalog:structuredClone(DEFAULT),topic:'all',year:+now.slice(0,4),month:+now.slice(5,7),kind:'all',source:'all',query:'',user:null,admin:false,entries:[],firstPage:[],extraRows:[],nextPage:null,hasMore:false,loading:false,configLoaded:false,uidShown:false};
const MISC={id:'misc',name:'其他',terms:[]};
function allTopics(){return [...state.catalog.topics.filter(t=>t.id!=='misc'),state.catalog.topics.find(t=>t.id==='misc')||MISC]}
const PAGE=20;
const BATCH=350;  // 一般月份直接取得全部（如 90 則），大量資料分批以防手機卡頓。
const MAX_CACHE=4;
const archiveCache=new Map();
let activeArchiveKey='';
let archivePage=1;
let archiveHasMore=false;
let archiveLast=null;
let archiveTotal=null;
let archiveIncomplete=false;
let archiveError='';
let archiveAppending=false;
function archiveKey(){return [state.admin?'admin':'public',state.topic,keyPrefix()].join('|')}
function rememberArchive(){
  const key=archiveKey();
  archiveCache.delete(key);
  archiveCache.set(key,{entries:state.entries.slice(),hasMore:archiveHasMore,last:archiveLast,total:archiveTotal,incomplete:archiveIncomplete});
  while(archiveCache.size>MAX_CACHE)archiveCache.delete(archiveCache.keys().next().value);
}
function invalidateArchive(){archiveCache.clear()}
function setPage(page){
  const totalPages=Math.max(1,Math.ceil(visibleEntries().length/PAGE));
  archivePage=Math.max(1,Math.min(totalPages,page));
  renderList();
}
function pageButtons(root,pages){
  const add=(label,p,active=false,disabled=false)=>{
    const b=btn(String(label),()=>setPage(p),'page-btn'+(active?' active':''));
    b.disabled=disabled;b.setAttribute('aria-current',active?'page':'false');root.append(b);
  };
  add('‹',archivePage-1,false,archivePage===1);
  const spots=new Set([1,pages]);
  for(let i=archivePage-2;i<=archivePage+2;i++)if(i>=1&&i<=pages)spots.add(i);
  let prev=0;
  for(const p of [...spots].sort((a,b)=>a-b)){
    if(p-prev>1)root.append(node('span','page-ellipsis','…'));
    add(p,p,p===archivePage);prev=p;
  }
  add('›',archivePage+1,false,archivePage===pages);
}

let stopWatch=null, stopJobs=null, loadToken=0, notifyTimer=null;
let editCatalog=null;
const str=v=>typeof v==='string'?v.trim():'';
function closeMobile(){
  $('sidebar').classList.remove('open');
  $('mobileBackdrop').hidden=true;
}
function notify(s){const t=$('toast');t.textContent=s;t.classList.add('show');clearTimeout(notifyTimer);notifyTimer=setTimeout(()=>t.classList.remove('show'),4100)}
function node(tag,cls='',txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=String(txt);return e}
function append(p,...els){els.forEach(x=>x&&p.append(x));return p}
function btn(label,fn,cls=''){const e=node('button',cls,label);e.type='button';e.addEventListener('click',fn);return e}
function verifyDate(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const [y,m,d]=v.split('-').map(Number),t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d}
function urlSafe(v,relative=false){const value=str(v);if(!value)return '';if(relative&&/^assets\/docs\/[a-z0-9_\u4e00-\u9fff\u3400-\u4dbf.%()\/-]+$/iu.test(value)&&!value.includes('..'))return value;try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:''}catch{return ''}}
function normalize(r){if(!r||typeof r!=='object')return null;const date=str(r.date),title=str(r.title).slice(0,240),source=str(r.source).slice(0,100);if(!verifyDate(date)||!title||!source)return null;const topics=[...new Set((Array.isArray(r.topics)?r.topics:[]).filter(x=>typeof x==='string'&&x.length<120))];const kind=/影音|video|youtube/i.test(str(r.kind))?'影音':'新聞';return {id:str(r.id),date,title,source,kind,topics,url:urlSafe(r.url),note:str(r.note).slice(0,4000),archive_url:urlSafe(r.archive_url||r.attachment,true),hidden:!!r.hidden}}
function safeErr(e){const code=str(e?.code),message=str(e?.message);if(/permission-denied/.test(code))return '權限不足。請確認 Firebase UID 已填入 Firestore 規則並發布。';if(/unauthorized-domain/.test(code))return '這個網域尚未加入 Firebase Authentication → 授權網域。';if(/popup-blocked/.test(code))return '瀏覽器封鎖登入視窗；請允許此網站開啟彈出視窗。';if(/network-request-failed|unavailable/.test(code))return '暫時無法連線，請確認網路後重試。';return code?code+(message?`：${message.slice(0,110)}`:''):(message||'未知錯誤')}
function keyPrefix(){return String(state.year)+(state.month==='all'?'':('-'+String(state.month).padStart(2,'0')))}
function visibleEntries(){return state.entries.filter(x=>(state.admin||!x.hidden)&&(state.topic==='all'||(x.topics||[]).includes(state.topic))&&(state.kind==='all'||x.kind===state.kind)&&(state.source==='all'||x.source===state.source)&&(!state.query||`${x.title} ${x.source} ${x.note}`.toLocaleLowerCase().includes(state.query.toLocaleLowerCase())))}
function nav() {
  const root=$('topicNav');
  const oldOpened=new Set([...document.querySelectorAll('.topic-folder[open]')].map(x=>x.dataset.folderKey));
  root.replaceChildren();
  const addTopic=(parent,t)=>{
    const b=btn('',()=>{if(state.topic===t.id){closeMobile();return}state.topic=t.id;archivePage=1;render();subscribe();closeMobile()},'topic-btn'+(state.topic===t.id?' active':''));
    b.append(node('span','',t.name));parent.append(b);
  };
  addTopic(root,{id:'all',name:'全部主題'});
  const topics=state.catalog.topics.filter(t=>t.id!=='misc');
  const folders=getFolders(state.catalog);
  const createFolder=(parent,label,key,containsActive=false)=>{
    const folder=node('details','topic-folder');folder.dataset.folderKey=key;
    folder.append(node('summary','topic-folder-title','▸ '+label));parent.append(folder);
    folder.open=oldOpened.has(key)||containsActive;
    return folder;
  };
  // 第一層依資料夾順序，第二層可收合，未分類主題直接顯示。
  for(const t of topics.filter(x=>!str(x.group)))addTopic(root,t);
  for(const f of folders){
    const related=topics.filter(x=>str(x.group)===f.name);
    const fg=createFolder(root,f.name,'g:'+f.name,related.some(x=>x.id===state.topic));
    for(const t of related.filter(x=>!str(x.subgroup)))addTopic(fg,t);
    const subs=[...new Set([...(f.children||[]),...related.map(x=>str(x.subgroup)).filter(Boolean)])];
    for(const sub of subs){
      const relatedSub=related.filter(t=>str(t.subgroup)===sub);
      const sg=createFolder(fg,sub,'s:'+f.name+'/'+sub,relatedSub.some(x=>x.id===state.topic));
      for(const t of relatedSub)addTopic(sg,t);
    }
  }
  const miscSection=node('div','misc-nav-divider');root.append(miscSection);
  addTopic(root,allTopics().find(t=>t.id==='misc'));
  const name=allTopics().find(t=>t.id===state.topic)?.name||'全部主題';
  $('crumbTopic').textContent=name;$('archiveTitle').textContent=name;
  $('archiveDesc').textContent=state.topic==='all'?'已儲存的新聞依原始發布日期排列。':state.topic==='misc'?'零碎新聞與自訂關鍵字蒐集的內容。':'只顯示歸入「'+name+'」的已收錄新聞，不設額外重要性門檻。';
}
function getFolders(catalog){
  const folders=Array.isArray(catalog.folders)?structuredClone(catalog.folders):[];
  for(const f of folders)f.children=Array.isArray(f.children)?f.children:[];
  for(const t of catalog.topics||[]){
    const g=str(t.group),s=str(t.subgroup);if(!g)continue;
    let f=folders.find(x=>x.name===g);if(!f){f={name:g,children:[]};folders.push(f)}
    if(s&&!(f.children||[]).includes(s)){f.children||=[];f.children.push(s)}
  }
  return folders;
}
function renderTopicMemo(){
  const wrap=$('topicMemoWrap'),field=$('topicMemo'),save=$('saveTopicMemo');
  const topic=state.catalog.topics.find(t=>t.id===state.topic);
  if(!topic){wrap.hidden=true;return}
  wrap.hidden=false;field.readOnly=!state.admin;save.hidden=!state.admin;
  if(document.activeElement!==field||field.dataset.topic!==state.topic)field.value=topic.memo||'';
  field.dataset.topic=state.topic;
}
function yearMonths(){const yroot=$('yearChips');yroot.replaceChildren();const yearNow=+now.slice(0,4);for(let y=Math.max(yearNow,state.year);y>=2016;y--){const b=btn(y,()=>{state.year=y;state.month='all';archivePage=1;render();subscribe()},y===state.year?'active':'');b.setAttribute('aria-pressed',String(y===state.year));yroot.append(b)}const mroot=$('monthChips');mroot.replaceChildren();for(const m of [{value:'all',name:'全年'},...Array.from({length:12},(_,i)=>({value:i+1,name:String(i+1).padStart(2,'0')+'月'}))]){const b=btn(m.name,()=>{state.month=m.value;archivePage=1;render();subscribe()},m.value===state.month?'active':'');mroot.append(b)}}
function sourceSelects(){const existing=state.source;const names=[...new Set([...state.catalog.sources.map(x=>x.name),...state.entries.map(x=>x.source)])];const s=$('sourceSelect');s.replaceChildren(new Option('所有媒體來源','all'));for(const n of names)s.append(new Option(n,n));state.source=names.includes(existing)?existing:'all';s.value=state.source;const form=$('articleSource'),old=form.value;form.replaceChildren();for(const n of names)form.append(new Option(n,n));form.append(new Option('其他（自行輸入）','__other'));if(names.includes(old))form.value=old}
function articleCard(a){const row=node('article','article-card'+(a.hidden?' excluded':''));row.append(node('div','article-icon',a.kind==='影音'?'▷':'▤'));const body=node('div','article-body'),meta=node('div','article-meta');append(meta,node('span','source-name',a.source),node('span','','·'),node('time','article-date',a.date.replaceAll('-','.')),node('span','article-kind',a.hidden?'已排除':a.kind));body.append(meta);const title=node('h4','article-title');if(a.url){const link=node('a','',a.title);link.href=a.url;link.target='_blank';link.rel='noopener noreferrer';title.append(link)}else title.textContent=a.title;body.append(title);if(a.note)body.append(node('p','article-note',a.note));const tags=node('div','article-tags');for(const t of allTopics().filter(t=>(a.topics||[]).includes(t.id)))tags.append(node('span','article-tag',t.name));if(a.archive_url){const link=node('a','article-link','↗ 查看保存附件');link.href=a.archive_url;link.target='_blank';link.rel='noopener noreferrer';tags.append(link)}body.append(tags);
  if(state.admin){const actions=node('div','article-actions');actions.append(btn('✎ 編輯',()=>openEditor(a),'edit-btn'));actions.append(btn(a.hidden?'↶ 復原':'× 排除',async()=>{if(!confirm(a.hidden?`復原「${a.title}」並重新公開？`:`將「${a.title}」從公開頁面排除？`))return;try{await cloud.setHidden(a,!a.hidden);state.entries=state.entries.map(x=>x.id===a.id?{...x,hidden:!a.hidden}:x);rememberArchive();renderList();notify(a.hidden?'已復原並同步雲端':'已排除並同步雲端')}catch(e){notify('操作未完成：'+safeErr(e))}}));actions.append(btn('永久刪除',async()=>{
    if(!confirm(`確定要永久刪除「${a.title}」？\n這項操作無法復原。`))return;
    try {await cloud.deleteArticle(a.id);state.entries=state.entries.filter(x=>x.id!==a.id);
      if(archiveTotal!==null)archiveTotal=Math.max(0,archiveTotal-1);
      rememberArchive();renderList();notify('新聞已永久刪除');}
    catch(e){notify('刪除失敗：'+safeErr(e))}
  },'small-danger'));body.append(actions)}row.append(body);return row}
function renderList(){
  const list=$('articleList');list.replaceChildren();
  const items=visibleEntries().slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
  // 簡潔而準確：完整數量才使用「共有」；未完成掃描只顯示已載入的篇數。
  // Firestore 缺少複合索引時不把部分結果誤標為總數。
  const countIsExact=archiveTotal!==null&&!archiveIncomplete;
  const countText=countIsExact
    ? `共有 ${archiveTotal.toLocaleString('zh-TW')} 則`
    : `已載入 ${state.entries.length.toLocaleString('zh-TW')} 則`;
  const pages=Math.max(1,Math.ceil(items.length/PAGE));
  archivePage=Math.min(archivePage,pages);
  const first=(archivePage-1)*PAGE;
  const showing=items.slice(first,first+PAGE);
  $('resultCount').textContent=archiveError&&!items.length?'目前無法載入':countText;
  $('headlineCount').textContent=state.entries.length.toLocaleString('zh-TW');
  const nav=$('archivePagination');nav.replaceChildren();
  if(state.loading&&!archiveAppending){list.append(node('div','empty-state','正在讀取指定主題、年月的新聞…'));$('loadMoreBtn').hidden=true;return}
  if(!items.length){
    const empty=node('div','empty-state');
    append(empty,node('div','empty-icon','✳'),node('h3','',state.entries.length?'目前篩選沒有相符紀錄':'這個期間還沒有新聞紀錄'),node('p','',archiveError||'這只代表目前已收錄的資料，不代表媒體沒有報導。'));
    if(state.admin)empty.append(btn('＋ 新增新聞',()=>openEditor(),'primary-btn'));
    list.append(empty);
  } else {
    for(const entry of showing)list.append(articleCard(entry));
    if(pages>1)pageButtons(nav,pages);
    const summary=node('p','page-summary',`第 ${archivePage} / ${pages} 頁，${PAGE} 則／頁。切換已載入的頁碼不會重新讀取 Firebase。`);
    nav.append(summary);
  }
  $('loadMoreBtn').hidden=!archiveHasMore;
  $('loadMoreBtn').disabled=false;
  $('loadMoreBtn').textContent=archiveHasMore?'載入更早新聞（下一批，最多 '+BATCH+' 則） ↓':'';
}
function render(){renderTopicMemo();nav();yearMonths();sourceSelects();$all('#typeTabs button').forEach(b=>b.classList.toggle('active',b.dataset.kind===state.kind));$('adminBar').hidden=!state.admin;$('addArticleTop').hidden=!state.admin;$('autoImportSideBtn').hidden=!state.admin;$('manageCatalogBtn').hidden=!state.admin;
  $('openOverviewBtn').hidden=!state.admin||state.topic==='all'||state.topic==='misc';$('adminToggle').setAttribute('aria-pressed',String(state.admin));$('adminToggleText').textContent=state.admin?'管理員：'+(state.user?.displayName||'已登入'):(state.user?'檢視登入／UID':'Google 管理員登入');$('syncStatus').textContent=state.admin?'管理員已驗證 · Firebase 雲端':state.user?'Google 已登入 · 尚未授權管理員':'公開閱覽 · Firebase 雲端';renderList()}
async function subscribe(force=false){
  const token=++loadToken;archiveAppending=false;
  const key=archiveKey();activeArchiveKey=key;
  if(stopWatch){stopWatch();stopWatch=null}
  if(!force&&archiveCache.has(key)){
    const cached=archiveCache.get(key);
    state.entries=cached.entries.slice();archiveHasMore=cached.hasMore;archiveLast=cached.last;archiveTotal=cached.total;archiveIncomplete=cached.incomplete;
    state.loading=false;archiveError='';render();return;
  }
  state.loading=true;archiveError='';archiveHasMore=false;archiveIncomplete=false;archiveTotal=null;archiveLast=null;
  state.entries=[];renderList();
  try {
    const data=await cloud.fetchArchiveBatch({admin:state.admin,prefix:keyPrefix(),topic:state.topic,batchSize:BATCH});
    if(token!==loadToken)return;
    state.entries=data.entries;archiveHasMore=data.hasMore;archiveLast=data.last;
    archiveTotal=data.hasMore?null:data.entries.length;
    if(data.hasMore){
      try { archiveTotal=await cloud.countArchive({admin:state.admin,prefix:keyPrefix(),topic:state.topic}) }
      catch(e){console.warn('總數計數無法取得，會以已讀取篇數顯示下限：',e)}
    }
    if(token!==loadToken)return;
    rememberArchive();archiveError='';
  } catch(e) {
    if(token!==loadToken)return;
    // 索引不足時，單月份可用日期索引保守回退；不把部分結果當成完整總數。
    if(state.topic!=='all'&&String(e?.code||'').includes('failed-precondition')&&/^\d{4}-\d{2}$/.test(keyPrefix())){
      try {
        const fallback=await cloud.fetchMonthWithoutComposite({admin:state.admin,prefix:keyPrefix(),topic:state.topic});
        if(token!==loadToken)return;
        state.entries=fallback.entries;archiveIncomplete=fallback.incomplete;
        archiveHasMore=false;archiveTotal=fallback.incomplete?null:fallback.entries.length;
        // 索引不足屬於查詢設定問題，不在新聞標題旁顯示長篇技術警告。
        archiveError='';
        if(fallback.incomplete)console.warn('單月份已掃描 '+fallback.scanned+' 則新聞，達到安全上限；請建立 Firebase「topics array-contains + date descending」複合索引以查到完整篇數。');
        rememberArchive();
      } catch(err){archiveError='查詢失敗：'+safeErr(err);notify(archiveError)}
    } else {archiveError='查詢失敗：'+safeErr(e);notify(archiveError)}
  } finally {if(token===loadToken){state.loading=false;render()}}
}
async function loadMore(){
  if(!archiveHasMore||state.loading)return;
  const token=loadToken;state.loading=true;archiveAppending=true;$('loadMoreBtn').disabled=true;
  try {
    const data=await cloud.fetchArchiveBatch({admin:state.admin,prefix:keyPrefix(),topic:state.topic,batchSize:BATCH,last:archiveLast});
    if(token!==loadToken)return;
    const seen=new Map(state.entries.map(x=>[x.id,x]));for(const row of data.entries)seen.set(row.id,row);
    state.entries=[...seen.values()];archiveLast=data.last;archiveHasMore=data.hasMore;
    if(!archiveHasMore)archiveTotal=state.entries.length;
    rememberArchive();
  }catch(e){notify('無法載入下一批新聞：'+safeErr(e))}
  finally{if(token===loadToken){state.loading=false;archiveAppending=false;renderList()}}
}
function openEditor(a=null){if(!state.admin){$('loginDialog').showModal();return}const f=$('articleForm');f.reset();$('editId').value=a?.id||'';$('editorTitle').textContent=a?'編輯新聞紀錄':'新增新聞報導';$('articleTitle').value=a?.title||'';$('articleDate').value=a?.date||now;$('articleKind').value=a?.kind||'新聞';$('articleUrl').value=a?.url||'';$('articleNote').value=a?.note||'';$('articleAttachment').value=a?.archive_url||'';sourceSelects();const existing=state.catalog.sources.some(x=>x.name===a?.source);$('articleSource').value=a?(existing?a.source:'__other'):(state.catalog.sources[0]?.name||'__other');$('articleSourceOther').value=a&&!existing?a.source:'';const parent=$('articleTopicChecks');parent.replaceChildren();for(const t of allTopics()){const check=node('input');check.type='checkbox';check.value=t.id;check.checked=a?(a.topics||[]).includes(t.id):(state.topic!=='all'&&state.topic===t.id);append(parent,append(node('label','check-label'),check,node('span','',t.name)))}$('articleDialog').showModal()}
async function suffixFor(title,source,url){const text=(url||`${source}|${title}`).trim().toLowerCase();const dig=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(dig)].slice(0,12).map(x=>x.toString(16).padStart(2,'0')).join('')}
async function stableId(record){return `${record.date}-${await suffixFor(record.title,record.source,record.url)}`}
async function submitArticle(e){e.preventDefault();if(!state.admin)return;const topics=$all('#articleTopicChecks input:checked').map(x=>x.value);if(!topics.length){notify('請至少選一個追蹤主題');return}const source=$('articleSource').value==='__other'?$('articleSourceOther').value:$('articleSource').value;const oldId=$('editId').value;
  const raw={id:'',title:$('articleTitle').value,date:$('articleDate').value,kind:$('articleKind').value,source,topics,url:$('articleUrl').value,note:$('articleNote').value,archive_url:$('articleAttachment').value,hidden:false};
  if(raw.url&&!urlSafe(raw.url)){notify('原始網址必須是 http 或 https');return}if(raw.archive_url&&!urlSafe(raw.archive_url,true)){notify('附件需使用 https 網址或 assets/docs/ 下的相對路徑');return}
  const a=normalize(raw);if(!a){notify('請確認標題、日期和來源');return}const original=state.entries.find(x=>x.id===oldId);const fixedSuffix=oldId?.match(/^\d{4}-\d{2}-\d{2}-(.+)$/)?.[1];a.id=oldId?(a.date+'-'+(fixedSuffix||await suffixFor(a.title,a.source,a.url))):await stableId(a);a.hidden=!!original?.hidden;
  const saving=$('saveArticleBtn');saving.disabled=true;saving.textContent='正在儲存到雲端…';try{await cloud.upsertArticle(a,oldId);invalidateArchive();$('articleDialog').close();state.year=Number(a.date.slice(0,4));state.month=Number(a.date.slice(5,7));state.topic=state.topic==='all'||topics.includes(state.topic)?state.topic:topics[0];state.source='all';state.kind='all';state.query='';$('searchInput').value='';if(!oldId)archivePage=1;render();subscribe(true);notify(oldId?'修改成功，已儲存至雲端':'新增成功，已儲存至雲端')}catch(err){notify('沒有儲存成功：'+safeErr(err))}finally{saving.disabled=false;saving.textContent='儲存到 Firebase'}}
function loginUI(){const user=state.user;$('uidPanel').hidden=!user;$('googleLoginBtn').hidden=!!user;$('recheckAdminBtn').hidden=!user;$('logoutBtn').hidden=!user;if(user){$('uidValue').textContent=user.uid;$('loginUserStatus').textContent=`目前登入：${user.email||user.displayName||'Google 帳號'}。${state.admin?'已通過管理員權限驗證，可以編輯雲端資料。':'尚未通過管理員 UID 驗證，請先發布 Firestore 安全規則。'}`}else $('loginUserStatus').textContent='目前尚未登入。'}
async function authChanged(user){state.user=user;state.admin=false;if(user){try{state.admin=await cloud.checkAdmin()}catch(e){if(!/permission-denied/.test(str(e?.code)))notify('管理員權限檢查：'+safeErr(e))}}render();loginUI();subscribe();beginJobs()}
async function startLogin(){const button=$('googleLoginBtn');button.disabled=true;try{await cloud.login();notify('Google 已登入，正在驗證管理員身分')}catch(e){notify('登入失敗：'+safeErr(e))}finally{button.disabled=false}}
async function saveTopicMemo(){
  if(!state.admin||state.topic==='all')return;
  const button=$('saveTopicMemo'),topicId=state.topic,memo=$('topicMemo').value.trim();
  button.disabled=true;button.textContent='儲存中…';
  try{
    const catalog=await cloud.loadCatalog();
    if(!catalog||!Array.isArray(catalog.topics))throw Error('主題設定讀取失敗');
    const topic=catalog.topics.find(t=>t.id===topicId);
    if(!topic)throw Error('找不到對應的主題');
    topic.memo=memo;await cloud.saveCatalog(catalog);
    state.catalog=structuredClone(catalog);renderTopicMemo();notify('備忘錄已儲存至 Firebase');
  }catch(e){notify('備忘錄儲存失敗：'+safeErr(e))}
  finally{button.disabled=false;button.textContent='儲存備忘錄'}
}
function showCatalog(){if(!state.admin)return;editCatalog=structuredClone(state.catalog);renderCatalog();$('catalogDialog').showModal();closeMobile()}
function makeId(name){return 'topic-'+[...new TextEncoder().encode(name)].reduce((a,b)=>((a*31+b)>>>0),7).toString(36)}
function renderCatalog(){
  const topics=$('catalogTopics'),sources=$('catalogSources');topics.replaceChildren();sources.replaceChildren();
  const folders=getFolders(editCatalog);editCatalog.folders=folders;
  const createBtn=btn('＋ 新增資料夾',()=>{
    const name=str(prompt('新資料夾名稱（第一層）'));if(!name)return;
    if(folders.some(f=>f.name===name)){notify('資料夾名稱已存在');return}
    folders.push({name,children:[]});renderCatalog();
  },'secondary-btn');topics.append(createBtn);
  const makeTopicRow=(t)=>{
    const i=editCatalog.topics.indexOf(t),row=node('div','v7-topic-row');row.draggable=true;row.dataset.topicId=t.id;
    row.append(node('span','v7-drag-handle','⠿'));
    const title=node('strong','',t.name);row.append(title);
    const actions=node('div','v7-row-actions');
    const folderSel=node('select');folderSel.setAttribute('aria-label','第一層資料夾');folderSel.append(new Option('不分類',''));
    for(const f of folders)folderSel.append(new Option(f.name,f.name));folderSel.value=str(t.group);
    const subSel=node('select');subSel.setAttribute('aria-label','第二層資料夾');
    function refreshSub(){subSel.replaceChildren(new Option('無子資料夾',''));const f=folders.find(x=>x.name===folderSel.value);for(const s of f?.children||[])subSel.append(new Option(s,s));subSel.value=f?.children?.includes(str(t.subgroup))?str(t.subgroup):'';}
    refreshSub();folderSel.addEventListener('change',()=>{t.group=folderSel.value;t.subgroup='';refreshSub();renderCatalog()});
    subSel.addEventListener('change',()=>{t.subgroup=subSel.value;renderCatalog()});
    actions.append(folderSel,subSel);
    actions.append(btn('↑',()=>moveTopic(t,-1),'v7-mini-btn'),btn('↓',()=>moveTopic(t,1),'v7-mini-btn'));
    actions.append(btn('刪除',()=>{if(!confirm(`移除「${t.name}」追蹤分類？既有新聞不會被刪除。`))return;editCatalog.topics=editCatalog.topics.filter(x=>x.id!==t.id);renderCatalog()},'small-danger'));
    row.append(actions);
    row.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain','topic:'+t.id);e.dataTransfer.effectAllowed='move'});
    row.addEventListener('dragover',e=>e.preventDefault());
    row.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();const value=e.dataTransfer.getData('text/plain');if(!value.startsWith('topic:'))return;const dragged=editCatalog.topics.find(x=>x.id===value.slice(6));if(dragged&&dragged!==t){dragged.group=t.group||'';dragged.subgroup=t.subgroup||'';moveTopicTo(dragged,t);renderCatalog()}});
    return row;
  };
  function moveTopic(t,delta){const arr=editCatalog.topics;const idx=arr.indexOf(t),next=idx+delta;if(next<0||next>=arr.length)return;[arr[idx],arr[next]]=[arr[next],arr[idx]];renderCatalog()}
  function moveTopicTo(a,b){const arr=editCatalog.topics;arr.splice(arr.indexOf(a),1);arr.splice(arr.indexOf(b),0,a)}
  function folderDrop(el,g,sub=''){
    el.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('text/plain'))e.preventDefault()});
    el.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();const value=e.dataTransfer.getData('text/plain');
      if(value.startsWith('topic:')){const t=editCatalog.topics.find(x=>x.id===value.slice(6));if(!t)return;t.group=g;t.subgroup=sub;renderCatalog()}
      else if(value.startsWith('folder:')&&!sub){const n=value.slice(7),i=folders.findIndex(x=>x.name===n),j=folders.findIndex(x=>x.name===g);if(i<0||j<0||i===j)return;const [f]=folders.splice(i,1);folders.splice(j,0,f);renderCatalog()}
    });
  }
  const loose=node('div','v7-catalog-folder');loose.append(node('h4','','未分類主題（可拖曳到資料夾）'));folderDrop(loose,'','');
  for(const t of editCatalog.topics.filter(x=>!str(x.group)&&x.id!=='misc'))loose.append(makeTopicRow(t));topics.append(loose);
  for(const f of folders){
    const box=node('details','v7-catalog-folder');box.open=true;box.draggable=true;
    box.addEventListener('dragstart',e=>{if(e.target!==box)return;e.dataTransfer.setData('text/plain','folder:'+f.name)});
    const summary=node('summary','','📁 '+f.name+'（拖曳主題至此）');box.append(summary);folderDrop(box,f.name);
    const actions=node('div','v7-folder-actions');
    actions.append(btn('＋ 子資料夾',()=>{const name=str(prompt('新增「'+f.name+'」的子資料夾名稱'));if(!name)return;if(f.children.includes(name)){notify('名稱重複');return}f.children.push(name);renderCatalog()},'v7-mini-btn'));
    actions.append(btn('重新命名',()=>{const name=str(prompt('重新命名資料夾',f.name));if(!name||folders.some(x=>x!==f&&x.name===name))return;for(const t of editCatalog.topics)if(t.group===f.name)t.group=name;f.name=name;renderCatalog()},'v7-mini-btn'));
    actions.append(btn('↑',()=>{const i=folders.indexOf(f);if(i>0){[folders[i],folders[i-1]]=[folders[i-1],folders[i]];renderCatalog()}},'v7-mini-btn'));
    actions.append(btn('↓',()=>{const i=folders.indexOf(f);if(i<folders.length-1){[folders[i],folders[i+1]]=[folders[i+1],folders[i]];renderCatalog()}},'v7-mini-btn'));
    actions.append(btn('移除資料夾',()=>{if(!confirm('移除資料夾「'+f.name+'」？內部主題會變成未分類，新聞不會刪除。'))return;for(const t of editCatalog.topics)if(t.group===f.name){t.group='';t.subgroup=''}folders.splice(folders.indexOf(f),1);renderCatalog()},'small-danger'));
    box.append(actions);
    for(const t of editCatalog.topics.filter(x=>x.group===f.name&&!str(x.subgroup)))box.append(makeTopicRow(t));
    for(const sub of f.children){
      const inner=node('details','v7-catalog-subfolder');inner.open=true;
      inner.append(node('summary','','📂 '+sub));folderDrop(inner,f.name,sub);
      const tools=node('div','v7-folder-actions');tools.append(btn('改名',()=>{const name=str(prompt('子資料夾名稱',sub));if(!name||f.children.includes(name))return;f.children[f.children.indexOf(sub)]=name;for(const t of editCatalog.topics)if(t.group===f.name&&t.subgroup===sub)t.subgroup=name;renderCatalog()},'v7-mini-btn'));
      tools.append(btn('移除',()=>{if(!confirm('移除此子資料夾？內部主題保留在「'+f.name+'」。'))return;f.children=f.children.filter(x=>x!==sub);for(const t of editCatalog.topics)if(t.group===f.name&&t.subgroup===sub)t.subgroup='';renderCatalog()},'v7-mini-btn'));
      inner.append(tools);for(const t of editCatalog.topics.filter(x=>x.group===f.name&&x.subgroup===sub))inner.append(makeTopicRow(t));box.append(inner);
    }
    topics.append(box);
  }
  const media=node('div','v7-sources-scroll');sources.append(media);
  for(const src of editCatalog.sources){
    const row=node('div','v7-source-card');row.draggable=true;row.append(node('strong','',src.name));
    const inp=node('input');inp.type='text';inp.placeholder='https://新聞媒體官網／搜尋網址（可使用 {keyword}）';inp.value=src.home_url||('https://'+(src.site_query||''));inp.addEventListener('input',()=>src.home_url=inp.value.trim());row.append(inp);
    const controls=node('div','v7-row-actions');const i=editCatalog.sources.indexOf(src);
    controls.append(btn('←',()=>{if(i>0){[editCatalog.sources[i-1],editCatalog.sources[i]]=[editCatalog.sources[i],editCatalog.sources[i-1]];renderCatalog()}},'v7-mini-btn'));
    controls.append(btn('→',()=>{if(i<editCatalog.sources.length-1){[editCatalog.sources[i+1],editCatalog.sources[i]]=[editCatalog.sources[i],editCatalog.sources[i+1]];renderCatalog()}},'v7-mini-btn'));
    controls.append(btn('移除',()=>{if(!confirm('移除媒體「'+src.name+'」？'))return;editCatalog.sources=editCatalog.sources.filter(x=>x!==src);renderCatalog()},'small-danger'));row.append(controls);
    row.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','media:'+src.name));
    row.addEventListener('dragover',e=>e.preventDefault());row.addEventListener('drop',e=>{e.preventDefault();const value=e.dataTransfer.getData('text/plain');if(!value.startsWith('media:'))return;const dragged=editCatalog.sources.find(x=>x.name===value.slice(6));if(!dragged||dragged===src)return;editCatalog.sources.splice(editCatalog.sources.indexOf(dragged),1);editCatalog.sources.splice(editCatalog.sources.indexOf(src),0,dragged);renderCatalog()});
    media.append(row);
  }
}
async function saveCatalog(){if(!state.admin)return;const button=$('saveCatalogBtn');button.disabled=true;try{if(editCatalog.sources.some(x=>x.home_url&&!/^https:\/\/[^\s/]+/i.test(x.home_url)))throw Error('媒體官網網址請使用 https:// 開頭');await cloud.saveCatalog(editCatalog);invalidateArchive();state.catalog=structuredClone(editCatalog);if(!state.catalog.topics.some(x=>x.id===state.topic))state.topic='all';$('catalogDialog').close();render();notify('關鍵字與媒體已儲存至雲端')}catch(e){notify('設定未儲存：'+safeErr(e))}finally{button.disabled=false}}
// 來源開啟策略：自由時報帶入關鍵字與日期；其他媒體進官網搜尋入口，不再導往 Google。
const MEDIA_HOMES={
  '自由時報':'https://search.ltn.com.tw/', '三立新聞':'https://www.setn.com/',
  '中央社':'https://www.cna.com.tw/', '民視新聞':'https://www.ftvnews.com.tw/SearchResult.aspx',
  '聯合報':'https://udn.com/', '鏡新聞':'https://www.mnews.tw/'
};
function selectedSearch(){
  const t=allTopics().find(x=>x.id===$('externalTopic').value);
  const s=state.catalog.sources.find(x=>x.name===$('externalSource').value);
  if(!t||!s){notify('請先選擇關鍵字與新聞媒體');return null}
  const custom=str($('externalCustomKeyword').value);
  if((t.id==='misc'||$('externalUseCustom').checked)&&!custom){notify('請先輸入要搜尋的文字');return null}
  const start=$('externalStart').value,end=$('externalEnd').value;
  if(start&&!verifyDate(start)||end&&!verifyDate(end)||start&&end&&start>end){notify('搜尋日期範圍有誤');return null}
  return {topicId:(t.id==='misc'||$('externalUseCustom').checked)?'misc':t.id,keyword:custom&&(t.id==='misc'||$('externalUseCustom').checked)?custom:(t.terms?.[0]||t.name),source:s.name,start,end,mode:$('searchMode').value,media:s};
}
function officialSearchUrl(v){
  if(v.source==='自由時報'){
    const p=new URLSearchParams({keyword:v.keyword,type:'all',sort:'date'});
    if(v.start)p.set('start_time',v.start.replaceAll('-',''));
    if(v.end)p.set('end_time',v.end.replaceAll('-',''));
    return 'https://search.ltn.com.tw/list?'+p.toString();
  }
  const configured=v.media.home_url, fallback=MEDIA_HOMES[v.source];
  // 自訂媒體網址僅採用 HTTPS 網域，不直接拼接使用者輸入的搜尋參數。
  if(/^https:\/\/[^\s/]+/i.test(configured||''))return configured.replaceAll('{keyword}',encodeURIComponent(v.keyword)).replaceAll('{start8}',(v.start||'').replaceAll('-','')).replaceAll('{end8}',(v.end||'').replaceAll('-',''));
  return fallback||('https://'+(v.media.site_query||''));
}
function externalSearch(){const v=selectedSearch();if(!v)return;const u=officialSearchUrl(v);if(!/^https:\/\//.test(u)){notify('請先為此媒體設定官網網址');return}window.open(u,'_blank','noopener,noreferrer');if(v.source!=='自由時報')notify('已開啟媒體官網；若該站不支援網址帶入關鍵字，請在站內搜尋框輸入。')}
function updateSearchAvailability(){
  const isLtn=$('externalSource').value==='自由時報';
  $('autoImportBtn').disabled=!state.admin||!isLtn;
  $('autoImportBtn').title=!state.admin?'只有管理員可送出匯入任務':(!isLtn?'其他媒體尚未完成自動匯入模組':'');
  $('autoImportNote').textContent=isLtn?'自由時報：可送出日期搜尋（實驗性）或官方 RSS（近期）。網站按鈕會建立任務，GitHub Actions 約每 10 分鐘檢查一次；無法保證官網所有報導均可取得。':'其他媒體：目前提供官方網站入口，尚未支援自動匯入。未經驗證不會假裝已完成。';
  $('searchModeHolder').hidden=!isLtn;
}
function renderSearchTopicChoices(){
  const input=$('externalTopic'),previous=input.value||state.topic;input.replaceChildren();
  const tree=$('topicPickerTree');tree.replaceChildren();
  const addOption=t=>input.append(new Option(t.name,t.id));
  const addPick=(parent,t)=>{
    const b=btn(t.name,()=>{input.value=t.id;tree.hidden=true;$('topicPickerBtn').textContent=t.name+' ▾';updateCustomSearchUI()},'v7-topic-pick-item');
    parent.append(b);
  };
  const loose=state.catalog.topics.filter(x=>x.id!=='misc'&&!str(x.group));
  for(const t of loose){addOption(t);addPick(tree,t)}
  for(const f of getFolders(state.catalog)){
    const first=node('details','v7-pick-folder');const heading=node('summary','','📁 '+f.name);first.append(heading);
    for(const t of state.catalog.topics.filter(x=>x.group===f.name&&!str(x.subgroup))){addOption(t);addPick(first,t)}
    for(const sub of f.children||[]){
      const second=node('details','v7-pick-subfolder');second.append(node('summary','','📂 '+sub));
      for(const t of state.catalog.topics.filter(x=>x.group===f.name&&x.subgroup===sub)){addOption(t);addPick(second,t)}
      first.append(second);
    }
    tree.append(first);
  }
  input.append(new Option('其他（自行輸入關鍵字）','misc'));
  addPick(tree,{id:'misc',name:'其他（自行輸入關鍵字）'});
  input.value=allTopics().some(x=>x.id===previous)?previous:'misc';
  $('topicPickerBtn').textContent=(allTopics().find(x=>x.id===input.value)?.name||'選擇新聞主題')+' ▾';
  tree.hidden=true;
  updateCustomSearchUI();
}
function updateCustomSearchUI(){
  const custom=$('externalTopic').value==='misc'||$('externalUseCustom').checked;
  $('customKeywordWrap').hidden=!custom;
  $('externalCustomKeyword').required=custom;
}
function showSearch(){
  renderSearchTopicChoices();
  const sources=$('externalSource');sources.replaceChildren();for(const s of state.catalog.sources)sources.append(new Option(s.name,s.name));
  $('externalEnd').value=dateTW();const d=new Date(dateTW()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-2);$('externalStart').value=d.toISOString().slice(0,10);
  $('searchMode').value='site';updateSearchAvailability();$('searchDialog').showModal();closeMobile();
}
async function submitImportJob(){
  const v=selectedSearch();if(!v)return;
  if(!state.admin){notify('請先登入管理員');return}
  if(v.source!=='自由時報'){notify('目前只有自由時報可以自動匯入');return}
  if(!v.start||!v.end){notify('自動匯入請填寫起訖日期');return}
  const days=Math.round((Date.parse(v.end+'T00:00:00Z')-Date.parse(v.start+'T00:00:00Z'))/86400000)+1;
  if(days>31){notify('為避免官網負擔，請以最多 31 天為一批搜尋；舊新聞可逐月補齊');return}
  if(v.end>dateTW()){notify('結束日期不能晚於今天');return}
  const b=$('autoImportBtn');b.disabled=true;b.textContent='正在建立任務…';
  try{await cloud.enqueueSearchJob(v);notify('搜尋工作已送出，背景程式會處理並回報進度（不是立即完成）');}
  catch(e){notify('未能建立搜尋工作：'+safeErr(e))}
  finally{b.disabled=false;b.textContent='送出自動匯入任務';updateSearchAvailability()}
}
function showJobStatus(jobs){const list=$('jobStatusList');list.replaceChildren();if(!jobs.length){list.append(node('p','', '尚無匯入任務。'));return}
  for(const j of jobs){const el=node('div','job-status-item');const stat={pending:'等候執行',running:'正在蒐集',done:'完成',partial:'部分完成／未能取得全部',failed:'失敗'}[j.status]||j.status;
    append(el,node('strong','',`${j.keyword||'—'} · ${j.source||'—'}　${stat}`),node('div','',`${j.start||'—'} ～ ${j.end||'—'}｜已取得 ${j.found||0}／新增 ${j.added||0}／重複 ${j.duplicate||0}／略過 ${j.skipped||0}｜處理 ${j.pages||0} 頁`),node('div','',j.info||''));
    if(state.admin&&j.status!=='running')el.append(btn('× 刪除紀錄',async()=>{
      if(!confirm('確定刪除此筆匯入紀錄？這不會刪除已收錄的新聞。'))return;
      try{await cloud.deleteSearchJob(j.id);notify('已刪除匯入紀錄')}
      catch(e){notify('刪除失敗：'+safeErr(e))}
    },'small-danger'));
    if(j.errors?.length)el.append(node('small','job-error','最近問題：'+String(j.errors.at(-1)).slice(0,240)));
    list.append(el);
  }
}
function beginJobs(){if(stopJobs){stopJobs();stopJobs=null}const box=$('jobStatusList');box.replaceChildren();if(!state.admin){box.append(node('p','', '登入管理員即可查看匯入進度'));return}
  stopJobs=cloud.watchSearchJobs(showJobStatus,e=>{box.textContent='無法取得工作進度：'+safeErr(e)})}
// v7：資料總覽：完整掃描指定主題／年月後，才能開放全選與永久刪除。
const overview={entries:[],selected:new Set(),loading:false,complete:false,token:0};
function renderOverview(){
  const list=$('overviewItems');list.replaceChildren();
  $('overviewCount').textContent=`已取得 ${overview.entries.length} 則${overview.complete?'（本月全部）':'（尚未完整讀取）'} · 已選 ${overview.selected.size} 則`;
  $('overviewDelete').disabled=!overview.complete||overview.loading||overview.selected.size===0;
  $('overviewSelectAll').disabled=!overview.complete||overview.loading;
  $('overviewUnselect').disabled=overview.loading||overview.selected.size===0;
  const q=str($('overviewFilter').value).toLowerCase();
  for(const article of overview.entries){
    if(q&&!(`${article.title} ${article.date} ${article.source}`.toLowerCase().includes(q)))continue;
    const row=node('label','v7-overview-row');
    const ck=node('input');ck.type='checkbox';ck.checked=overview.selected.has(article.id);ck.disabled=overview.loading;
    ck.addEventListener('change',()=>{if(ck.checked)overview.selected.add(article.id);else overview.selected.delete(article.id);$('overviewCount').textContent=`已取得 ${overview.entries.length} 則${overview.complete?'（本月全部）':'（尚未完整讀取）'} · 已選 ${overview.selected.size} 則`;$('overviewDelete').disabled=!overview.complete||!overview.selected.size});
    const meta=node('span','v7-overview-info');meta.append(node('small','',article.date+' · '+article.source),node('span','',article.title));
    row.append(ck,meta);list.append(row);
  }
}
async function openOverview(){
  if(!state.admin||state.topic==='all'||state.topic==='misc'){notify('請先選擇個別關鍵字，再以管理員身分開啟資料總覽');return}
  const dlg=$('overviewDialog');dlg.showModal();
  $('overviewFilter').value='';overview.entries=[];overview.selected.clear();overview.complete=false;overview.loading=true;
  const token=++overview.token;const topic=state.topic,prefix=keyPrefix();
  $('overviewScope').textContent=(allTopics().find(t=>t.id===topic)?.name||topic)+' · '+prefix;
  $('overviewProgress').textContent='正在完整讀取這個主題與年月的新聞…';renderOverview();
  let last=null;
  try{
    do{
      const part=await cloud.fetchArchiveBatch({admin:true,topic,prefix,batchSize:300,last});
      if(token!==overview.token||!dlg.open)return;
      overview.entries.push(...part.entries);last=part.last;
      $('overviewProgress').textContent=`已讀取 ${overview.entries.length} 則，${part.hasMore?'繼續讀取…':'讀取完成'}`;
      if(!part.hasMore){overview.complete=true;break}
      if(!part.entries.length)throw Error('資料分頁異常，已停止操作');
    }while(true);
  }catch(err){$('overviewProgress').textContent='讀取未完成，已禁止批次刪除：'+safeErr(err)}
  finally{if(token===overview.token){overview.loading=false;renderOverview()}}
}
async function deleteOverviewSelected(){
  if(!state.admin||!overview.complete||overview.loading)return;
  const ids=[...overview.selected];if(!ids.length)return;
  const message=`即將永久刪除 ${ids.length} 則新聞。注意：同一篇新聞若屬多個主題，也會從其他主題一併消失。此操作無法復原。`;
  if(!confirm(message))return;
  const check=prompt('請輸入「刪除 '+ids.length+'」確認永久刪除：');
  if(check!==`刪除 ${ids.length}`){notify('已取消批次刪除');return}
  overview.loading=true;renderOverview();
  try{
    await cloud.deleteArticlesBatch(ids,(done,total)=>{$('overviewProgress').textContent=`正在永久刪除：${done} / ${total} 則`});
    overview.entries=overview.entries.filter(x=>!overview.selected.has(x.id));
    overview.selected.clear();overview.complete=true;invalidateArchive();
    $('overviewProgress').textContent=`已成功刪除 ${ids.length} 則，現在剩餘 ${overview.entries.length} 則。`;
    await subscribe(true);renderOverview();notify('批次刪除完成：'+ids.length+' 則');
  }catch(e){overview.complete=false;$('overviewProgress').textContent='部分刪除可能已成功，請關閉並重新讀取確認：'+safeErr(e);notify('批次刪除未完全完成：'+safeErr(e))}
  finally{overview.loading=false;renderOverview()}
}
// v7：跨主題、跨年月的站內標題搜尋：只有使用者按搜尋才開始分批掃描。
const internal={rows:[],page:1,scanned:0,loading:false,cancel:false};
function renderInternalResults(){
  const root=$('internalResults');root.replaceChildren();
  const pages=Math.max(1,Math.ceil(internal.rows.length/20));internal.page=Math.min(internal.page,pages);
  const start=(internal.page-1)*20;
  for(const r of internal.rows.slice(start,start+20)){
    const row=node('div','v7-search-result');
    row.append(node('small','',r.date+' · '+r.source));
    const link=node('a','',r.title);if(r.url){link.href=r.url;link.target='_blank';link.rel='noopener noreferrer'}else link.removeAttribute('href');row.append(link);
    const names=allTopics().filter(t=>(r.topics||[]).includes(t.id)).map(t=>t.name);
    row.append(node('small','',names.join('、')));root.append(row);
  }
  const nav=$('internalPages');nav.replaceChildren();
  if(pages>1){for(let page=1;page<=pages;page++){
    if(pages>13&&Math.abs(page-internal.page)>3&&page!==1&&page!==pages)continue;
    nav.append(btn(page,()=>{internal.page=page;renderInternalResults()},'page-btn'+(page===internal.page?' active':'')));
  }}
  $('internalSummary').textContent=`已掃描 ${internal.scanned.toLocaleString()} 則已收錄新聞 · 標題符合 ${internal.rows.length.toLocaleString()} 則${internal.loading?' · 搜尋中…':''}`;
}
async function runInternalSearch(){
  if(internal.loading)return;
  const term=str($('internalKeyword').value).toLocaleLowerCase();if(term.length<2){notify('請輸入至少兩個字的搜尋關鍵字');return}
  internal.rows=[];internal.scanned=0;internal.page=1;internal.loading=true;internal.cancel=false;
  $('internalSearchBtn').disabled=true;$('internalCancelBtn').hidden=false;renderInternalResults();
  let last=null,complete=false;
  try{
    do{
      const part=await cloud.scanArchiveTitles({admin:state.admin,last,batchSize:300});
      if(!part.entries.length){complete=true;break}
      internal.scanned+=part.entries.length;
      internal.rows.push(...part.entries.filter(x=>(state.admin||!x.hidden)&&String(x.title||'').toLocaleLowerCase().includes(term)));
      last=part.last;complete=!part.hasMore;
      renderInternalResults();
      if(internal.cancel)break;
      // 每次最多掃描 20,000 則，避免無限制讀取；必要時提示縮小查詢。
      if(internal.scanned>=20000&&!complete){$('internalProgress').textContent='已達 20,000 則掃描上限，結果可能不完整。';break}
    }while(!complete);
    if(complete)$('internalProgress').textContent='搜尋完成：已掃描全部可取得的新聞標題。';
    else if(internal.cancel)$('internalProgress').textContent='已停止搜尋：目前結果僅涵蓋已掃描的新聞。';
  }catch(e){$('internalProgress').textContent='搜尋中斷，結果可能不完整：'+safeErr(e)}
  finally{internal.loading=false;$('internalSearchBtn').disabled=false;$('internalCancelBtn').hidden=true;renderInternalResults()}
}
function openInternalSearch(){
  $('internalDialog').showModal();closeMobile();
  $('internalKeyword').focus();
}
function wire(){for(const close of $all('[data-close]'))close.addEventListener('click',()=>$(close.dataset.close).close());$('mobileMenu').addEventListener('click',()=>{$('sidebar').classList.add('open');$('mobileBackdrop').hidden=false});$('mobileBackdrop').addEventListener('click',closeMobile);$('adminToggle').addEventListener('click',()=>{loginUI();$('loginDialog').showModal();closeMobile()});$('googleLoginBtn').addEventListener('click',startLogin);$('recheckAdminBtn').addEventListener('click',async()=>{await authChanged(cloud.currentUser());notify(state.admin?'管理員權限驗證成功':'仍未授權，請檢查規則是否已發布')});$('logoutBtn').addEventListener('click',async()=>{await cloud.logout();$('loginDialog').close();notify('已登出管理員')});$('copyUid').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('uidValue').textContent);notify('UID 已複製')}catch{notify('請手動選取並複製 UID')}});
  for(const id of ['addArticleTop','addArticleBtn'])$(id).addEventListener('click',()=>openEditor());$('articleForm').addEventListener('submit',submitArticle);$('sourceSearchBtn').addEventListener('click',showSearch);$('openExternalSearchBtn').addEventListener('click',externalSearch);$('updateHelpBtn').addEventListener('click',()=>{$('helpDialog').showModal();closeMobile()});$('autoImportSideBtn').addEventListener('click',showSearch);$('autoImportHelpBtn').addEventListener('click',showSearch);$('autoImportBtn').addEventListener('click',submitImportJob);$('externalSource').addEventListener('change',updateSearchAvailability);$('manageCatalogBtn').addEventListener('click',showCatalog);
  $('addTopicSetting').addEventListener('click',()=>{const name=str($('newTopic').value);if(!name)return;if(editCatalog.topics.some(x=>x.name===name)){notify('追蹤主題已存在');return}let id=makeId(name);while(editCatalog.topics.some(x=>x.id===id))id+='x';editCatalog.topics.push({id,name,terms:[name]});$('newTopic').value='';renderCatalog()});$('addSourceSetting').addEventListener('click',()=>{const name=str($('newSource').value);if(!name)return;if(editCatalog.sources.some(x=>x.name===name)){notify('媒體已存在');return}const url=str($('newSourceUrl').value);if(url&&!/^https:\/\/[^\s/]+/i.test(url)){notify('請輸入 https:// 開頭的媒體官網網址');return}editCatalog.sources.push({name,site_query:'',home_url:url});$('newSourceUrl').value='';$('newSource').value='';renderCatalog()});$('saveCatalogBtn').addEventListener('click',saveCatalog);
  $('searchInput').addEventListener('input',e=>{state.query=e.target.value.trim();archivePage=1;renderList()});$('sourceSelect').addEventListener('change',e=>{state.source=e.target.value;archivePage=1;renderList()});$('typeTabs').addEventListener('click',e=>{const b=e.target.closest('[data-kind]');if(!b)return;state.kind=b.dataset.kind;archivePage=1;render()});$('loadMoreBtn').addEventListener('click',loadMore);$('saveTopicMemo').addEventListener('click',saveTopicMemo);
  $('openOverviewBtn').addEventListener('click',openOverview);
  $('overviewDialog').addEventListener('close',()=>{overview.token++});
  $('overviewFilter').addEventListener('input',renderOverview);
  $('overviewSelectAll').addEventListener('click',()=>{if(!overview.complete)return;overview.selected=new Set(overview.entries.map(x=>x.id));renderOverview()});
  $('overviewUnselect').addEventListener('click',()=>{overview.selected.clear();renderOverview()});
  $('overviewDelete').addEventListener('click',deleteOverviewSelected);
  $('internalSearchSideBtn').addEventListener('click',openInternalSearch);
  $('internalSearchBtn').addEventListener('click',runInternalSearch);
  $('internalKeyword').addEventListener('keydown',e=>{if(e.key==='Enter')runInternalSearch()});
  $('internalCancelBtn').addEventListener('click',()=>{internal.cancel=true});
  $('internalDialog').addEventListener('close',()=>{internal.cancel=true});
  $('externalTopic').addEventListener('change',updateCustomSearchUI);
  $('topicPickerBtn').addEventListener('click',()=>{$('topicPickerTree').hidden=!$('topicPickerTree').hidden});
  $('externalUseCustom').addEventListener('change',updateCustomSearchUI);
}
const V62_PAGE_STYLES = `/* 新聞分頁附加樣式：不覆蓋原本的 styles.css */
.archive-pagination{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;margin-top:25px}
.archive-pagination .page-btn{min-width:42px;min-height:42px;padding:7px 12px;border:1px solid #d8ccb7;border-radius:9px;background:#fffcf6;color:#695641;font-weight:750}
.archive-pagination .page-btn.active{background:#876b43;color:#fff;border-color:#876b43}
.archive-pagination .page-btn:hover:not(:disabled){border-color:#a17f52;background:#efe3d0}
.archive-pagination .page-btn.active:hover{background:#775b37;color:white}
.archive-pagination .page-btn:disabled{opacity:.38}
.archive-pagination .page-ellipsis{padding:0 2px;color:#98826a}
.archive-pagination .page-summary{flex-basis:100%;text-align:center;color:#8a7b67;font-size:13px;margin:7px 0 0}
.refresh-archive{text-align:center;padding-top:12px}
.refresh-archive button{border:0;background:transparent;color:#856c49;font-size:14px;text-decoration:underline;text-underline-offset:3px;padding:7px}
@media(max-width:700px){.archive-pagination{gap:5px}.archive-pagination .page-btn{min-width:36px;min-height:39px;padding:6px 9px}}
`;
function ensurePaginationUI(){
  if(!$('archivePagination')){
    const nav=node('nav','archive-pagination');nav.id='archivePagination';
    nav.setAttribute('aria-label','新聞列表頁碼');
    const footer=$('loadMoreBtn').parentElement;
    footer.parentElement.insertBefore(nav,footer);
  }
  if(!$('refreshArchiveBtn')){
    const holder=node('div','refresh-archive');
    const b=btn('↻ 重新整理本月新聞',()=>subscribe(true));
    b.id='refreshArchiveBtn';holder.append(b);
    const footer=$('loadMoreBtn').parentElement;
    footer.parentElement.insertBefore(holder,footer);
  }
  if(!document.getElementById('v62-pagination-style')){
    const style=node('style');style.id='v62-pagination-style';
    style.textContent=V62_PAGE_STYLES;document.head.append(style);
  }
  const hint=document.querySelector('.sort-hint');
  if(hint)hint.textContent='依發布日期 ↓　·　每頁 20 則';
}
async function begin(){ensurePaginationUI();wire();render();try{const catalog=await cloud.loadCatalog();if(catalog&&Array.isArray(catalog.topics)&&Array.isArray(catalog.sources))state.catalog=catalog;state.configLoaded=true;render()}catch(e){notify('載入主題設定失敗，暫時顯示預設四組：'+safeErr(e))}cloud.onUser(authChanged)}
begin();
