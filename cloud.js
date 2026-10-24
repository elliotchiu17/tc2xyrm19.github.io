// GitHub Pages 可直接載入的 Firebase ES 模組，不需要 npm。
// 這個檔案不能存放 service-account private key。
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, setDoc, getDocs, writeBatch, query, orderBy, documentId, startAt, endAt, startAfter, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

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

const prefixQuery=(collectionName,prefix,pageSize,last)=>{
  const clauses=[orderBy(documentId(),'desc')];
  if(prefix) clauses.push(startAt(prefix+'\uf8ff'),endAt(prefix));
  if(last) clauses.push(startAfter(last));
  clauses.push(limit(pageSize));
  return query(collection(db,collectionName),...clauses);
};
export function watchNews({admin,prefix,pageSize},next,error){
  const coll=admin?'articles':'public_articles';
  return onSnapshot(prefixQuery(coll,prefix,pageSize,null),snap=>next(snap.docs.map(d=>({...d.data(),id:d.id})),snap.docs.at(-1)||null),error);
}
export async function moreNews({admin,prefix,pageSize,last}) {
  if(!last)return {entries:[],last:null};
  const snap=await getDocs(prefixQuery(admin?'articles':'public_articles',prefix,pageSize,last));
  return {entries:snap.docs.map(d=>({...d.data(),id:d.id})),last:snap.docs.at(-1)||null};
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
