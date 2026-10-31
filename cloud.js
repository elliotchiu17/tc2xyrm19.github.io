// GitHub Pages 可直接載入的 Firebase ES 模組，不需要 npm。
// 這個檔案不能存放 service-account private key。
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, deleteDoc, setDoc, addDoc, serverTimestamp, getDocs, writeBatch, query, orderBy, startAt, endAt, startAfter, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

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
/* 新增完全刪除功能 */
export async function deleteArticle(id) {
  if (!id) throw new Error('缺少新聞 ID');

  const batch = writeBatch(db);

  batch.delete(doc(db, 'articles', id));
  batch.delete(doc(db, 'public_articles', id));

  await batch.commit();
}
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
export function watchSearchJobs(next, error) {
  return onSnapshot(
    query(
      collection(db, 'search_jobs'),
      orderBy('createdAt', 'desc'),
      limit(12)
    ),
    snap => {
      next(snap.docs.map(d => ({
        ...d.data(),
        id: d.id
      })));
    },
    error
  );
}

export async function deleteSearchJob(id) {
  if (!auth.currentUser || !id) {
    throw new Error('缺少管理員身分或工作 ID');
  }

  await deleteDoc(doc(db, 'search_jobs', id));
}
