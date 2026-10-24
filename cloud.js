// GitHub Pages 可直接載入的 Firebase ES 模組，不需要 npm。
// 這個檔案不能存放 service-account private key。
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, setDoc, getDocs, writeBatch, query, orderBy, documentId, startAt, endAt, endBefore, limitToLast, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

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

// 以文件 ID（YYYY-MM-DD-...）做單欄位遞增查詢，再在畫面端反轉成最新優先。
// 避免舊版使用 __name__ 降冪索引造成「The query requires an index」。
// 這個查詢仍只讀取指定年月的最後 pageSize 篇，不會下載整個資料庫。
const prefixQuery=(collectionName,prefix,pageSize,last)=>{
  const clauses=[orderBy(documentId(),'asc')];
  if(prefix) clauses.push(startAt(prefix),endAt(prefix+'\uf8ff'));
  if(last) clauses.push(endBefore(last));
  clauses.push(limitToLast(pageSize));
  return query(collection(db,collectionName),...clauses);
};
function pageFromSnapshot(snap){
  // Firestore 遞增回傳；顯示時反轉為日期由新到舊。
  const docs=[...snap.docs].reverse();
  return {
    entries:docs.map(d=>({...d.data(),id:d.id})),
    // 下一頁須從目前最舊的文件往前取得。
    last:docs.at(-1)||null
  };
}
export function watchNews({admin,prefix,pageSize},next,error){
  const coll=admin?'articles':'public_articles';
  return onSnapshot(prefixQuery(coll,prefix,pageSize,null),snap=>{
    const page=pageFromSnapshot(snap);
    next(page.entries,page.last);
  },error);
}
export async function moreNews({admin,prefix,pageSize,last}) {
  if(!last)return {entries:[],last:null};
  const snap=await getDocs(prefixQuery(admin?'articles':'public_articles',prefix,pageSize,last));
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
export async function importArticles(records,onProgress){
  const chunks=Array.from({length:Math.ceil(records.length/180)},(_,i)=>records.slice(i*180,(i+1)*180));
  let count=0;
  for(const chunk of chunks){const batch=writeBatch(db);
    for(const record of chunk){batch.set(doc(db,'articles',record.id),record);if(record.hidden)batch.delete(doc(db,'public_articles',record.id));else batch.set(doc(db,'public_articles',record.id),publicRecord(record));}
    await batch.commit();count+=chunk.length;onProgress?.(count,records.length);
  }
  return count;
}
