// GitHub Pages 可直接載入的 Firebase ES 模組，不需要 npm。
// 這個檔案不能存放 service-account private key。
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, deleteDoc, setDoc, addDoc, serverTimestamp, getDocs, getCountFromServer, where, writeBatch, query, orderBy, startAt, endAt, startAfter, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({prompt:'select_account'});
export function onUser(cb) { return onAuthStateChanged(auth,cb); }
export function currentUser() { return auth.currentUser; }
export async function login() { return (await signInWithPopup(auth,provider)).user; }
export async function logout() { return signOut(auth); }
// 非管理員會得到 permission-denied，管理員即使文件不存在，也可成功讀取。
export async function checkAdmin() { await getDoc(doc(db,'admin_probe','status')); return true; }
export async function loadCatalog() { const snap=await getDoc(doc(db,'settings','catalog')); return snap.exists()?snap.data():null; }
export async function saveCatalog(catalog) { await setDoc(doc(db,'settings','catalog'),catalog); }

// 僅按「發布日期」單一欄位查詢，使用 Firestore 預設的單欄位索引。
// 不以文件 ID 降冪排序，避免先前的索引錯誤。
// prefix 例如 2026 或 2026-10；只讀取該年／月，並可逐頁載入。
function dateRange(prefix) {
  const match = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/.exec(prefix || '');
  if (!match) throw new Error('年份或月份格式錯誤');
  const year = Number(match[1]);
  if (match[2]) {
    const month = Number(match[2]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return [prefix + '-01', prefix + '-' + String(lastDay).padStart(2, '0')];
  }
  return [match[1] + '-01-01', match[1] + '-12-31'];
}
function newsQuery(collectionName, prefix, pageSize, last) {
  const [from, to] = dateRange(prefix);
  const clauses = [orderBy('date', 'desc'), startAt(to), endAt(from)];
  if (last) clauses.push(startAfter(last));
  clauses.push(limit(pageSize));
  return query(collection(db, collectionName), ...clauses);
}
function pageFromSnapshot(snap) {
  const docs = snap.docs;
  return {
    entries: docs.map(d => ({...d.data(), id: d.id})),
    last: docs.at(-1) || null
  };
}
export function watchNews({admin, prefix, pageSize}, next, error) {
  const coll = admin ? 'articles' : 'public_articles';
  return onSnapshot(newsQuery(coll, prefix, pageSize, null), snap => {
    const page = pageFromSnapshot(snap);
    next(page.entries, page.last);
  }, error);
}
export async function moreNews({admin, prefix, pageSize, last}) {
  if (!last) return {entries: [], last: null};
  const snap = await getDocs(newsQuery(admin ? 'articles' : 'public_articles', prefix, pageSize, last));
  return pageFromSnapshot(snap);
}
// 2026-11 分頁升級：同一主題、年月讀取一批，瀏覽器端每頁 20 則。
// 主題+日期組合查詢需要複合索引（Firestore Console 可依報錯連結建立）。
export async function fetchArchiveBatch({admin, prefix, topic='all', batchSize=350, last=null}) {
  const [from, to] = dateRange(prefix);
  const coll = admin ? 'articles' : 'public_articles';
  const fields = [];
  if (topic !== 'all') fields.push(where('topics', 'array-contains', topic));
  fields.push(where('date', '>=', from), where('date', '<=', to), orderBy('date', 'desc'));
  if (last) fields.push(startAfter(last));
  fields.push(limit(batchSize + 1));
  const result = await getDocs(query(collection(db, coll), ...fields));
  const docs = result.docs.slice(0, batchSize);
  return {
    entries: docs.map(d => ({...d.data(), id:d.id})),
    // 多取 1 筆，用來判斷是否真的還有下一批，避免多出空白按鈕。
    hasMore: result.docs.length > batchSize,
    last: docs.at(-1) || null
  };
}

export async function countArchive({admin, prefix, topic='all'}) {
  const [from,to] = dateRange(prefix);
  const coll = admin ? 'articles' : 'public_articles';
  const conditions = [];
  if (topic !== 'all') conditions.push(where('topics','array-contains',topic));
  // 與 fetchArchiveBatch 使用相同的日期降冪索引，避免計數另外要求升冪索引。
  conditions.push(where('date','>=',from),where('date','<=',to),orderBy('date','desc'));
  const result=await getCountFromServer(query(collection(db,coll),...conditions));
  return result.data().count;
}

// 在 Firebase 複合索引尚未建好時，以日期單欄位索引分批掃描整個月份。
// 重要：先讀完整個月份，再篩選主題；不能只取前 1,200 筆就宣稱找齊。
// 正式解法仍是建立 topics(array-contains) + date(desc) 複合索引。
export async function fetchMonthWithoutComposite({admin,prefix,topic,batchSize=350,maxScan=12000}) {
  if (!/^\d{4}-\d{2}$/.test(prefix)) {
    throw new Error('全年資料量較大，請先建立「主題＋日期」的複合索引。');
  }
  const coll = admin ? 'articles' : 'public_articles';
  const [from,to] = dateRange(prefix);
  const matches = [];
  let cursor = null;
  let scanned = 0;
  let incomplete = false;
  while (true) {
    const remaining = maxScan - scanned;
    if (remaining <= 0) { incomplete = true; break; }
    const take = Math.min(batchSize, remaining);
    const clauses = [
      where('date','>=',from), where('date','<=',to), orderBy('date','desc')
    ];
    if (cursor) clauses.push(startAfter(cursor));
    clauses.push(limit(take + 1));
    const snap = await getDocs(query(collection(db,coll),...clauses));
    const page = snap.docs.slice(0,take);
    for (const d of page) {
      const value = {...d.data(), id:d.id};
      if (topic==='all' || (value.topics||[]).includes(topic)) matches.push(value);
    }
    scanned += page.length;
    if (snap.docs.length <= take) break; // 沒有下一批，已掃完整個月份
    cursor = page.at(-1);
    if (!cursor) break;
    if (scanned >= maxScan) { incomplete = true; break; }
  }
  return {entries:matches,incomplete,scanned};
}
export async function deleteArticle(id) {
  if(!id)throw new Error('缺少新聞 ID');
  const batch=writeBatch(db);
  batch.delete(doc(db,'articles',id));
  batch.delete(doc(db,'public_articles',id));
  await batch.commit();
}
export async function deleteSearchJob(id) {
  if(!auth.currentUser||!id)throw new Error('缺少管理員身分或工作 ID');
  await deleteDoc(doc(db,'search_jobs',id));
}

function publicRecord(r){const {hidden,...rest}=r;return rest;}
export async function upsertArticle(record,oldId){
  const batch=writeBatch(db),newId=record.id;
  if(oldId&&oldId!==newId){batch.delete(doc(db,'articles',oldId));batch.delete(doc(db,'public_articles',oldId));}
  batch.set(doc(db,'articles',newId),record);
  if(record.hidden)batch.delete(doc(db,'public_articles',newId));
  else batch.set(doc(db,'public_articles',newId),publicRecord(record));
  await batch.commit();
}
export async function setHidden(record,hidden){await upsertArticle({...record,hidden});}
export async function importArticles(records,onProgress){
  const chunks=Array.from({length:Math.ceil(records.length/180)},(_,i)=>records.slice(i*180,(i+1)*180));
  let count=0;
  for(const chunk of chunks){const batch=writeBatch(db);
    for(const record of chunk){batch.set(doc(db,'articles',record.id),record);if(record.hidden)batch.delete(doc(db,'public_articles',record.id));else batch.set(doc(db,'public_articles',record.id),publicRecord(record));}
    await batch.commit();count+=chunk.length;onProgress?.(count,records.length);
  }
  return count;
}


// 管理員只提交搜尋「工作」，實際抓取由 GitHub Actions 執行，避免瀏覽器放入私密金鑰。
export async function enqueueSearchJob({topicId,keyword,source,start,end,mode}) {
  if (!auth.currentUser) throw Error('請先以管理員身分登入');
  return addDoc(collection(db,'search_jobs'),{
    topicId, keyword, source, start, end, mode,
    status:'pending', createdAt:serverTimestamp(), createdBy:auth.currentUser.uid,
    pages:0, found:0, added:0, duplicate:0, skipped:0,
    info:'等待背景更新程式處理', cursor:'', errors:[]
  });
}
export function watchSearchJobs(next,error) {
  return onSnapshot(query(collection(db,'search_jobs'),orderBy('createdAt','desc'),limit(12)),snap => {
    next(snap.docs.map(d => ({...d.data(),id:d.id})));
  },error);
}

// v7：批次永久刪除，單一 Firestore 批次最多 180 篇（兩個集合合計 360 次刪除）。
export async function deleteArticlesBatch(ids, onProgress) {
  if (!auth.currentUser) throw new Error('請先登入管理員');
  const unique=[...new Set(ids.filter(x=>typeof x==='string'&&x.length>0))];
  for(let n=0;n<unique.length;n+=180){
    const batch=writeBatch(db);
    for(const id of unique.slice(n,n+180)){
      batch.delete(doc(db,'articles',id));
      batch.delete(doc(db,'public_articles',id));
    }
    await batch.commit();
    onProgress?.(Math.min(n+180,unique.length),unique.length);
  }
  return unique.length;
}
// v7：站內搜尋依標題過濾，逐批掃描資料庫（Firebase 不支援任意子字串查詢）。
// 使用日期索引，不依賴主題複合索引；不載入新聞全文。
export async function scanArchiveTitles({admin=false, last=null, batchSize=300}) {
  const coll=admin?'articles':'public_articles';
  const q=[orderBy('date','desc')];
  if(last)q.push(startAfter(last));
  q.push(limit(batchSize));
  const snap=await getDocs(query(collection(db,coll),...q));
  return {entries:snap.docs.map(d=>({...d.data(),id:d.id})),last:snap.docs.at(-1)||null,hasMore:snap.size===batchSize};
}
