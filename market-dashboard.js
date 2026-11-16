/* Komorebi v10-3 — completed daily closing prices (not intraday quotes). */
(()=>{'use strict';
const markets=[
 {id:'TAIEX',market:'台灣',name:'台灣加權指數'},
 {id:'TX',market:'台灣期貨',name:'台指期（近月日盤）'},
 {id:'SPX',market:'美國',name:'S&P 500'},
 {id:'IXIC',market:'美國',name:'NASDAQ'},
 {id:'DJI',market:'美國',name:'道瓊工業指數'},
 {id:'SOX',market:'美國',name:'費城半導體'},
 {id:'N225',market:'日本',name:'日經 225'},
 {id:'KS11',market:'韓國',name:'KOSPI'},
 {id:'STOXX50E',market:'歐洲',name:'EURO STOXX 50'}
];
const $=id=>document.getElementById(id);
const escape=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt=value=>Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const day=s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return null;const d=new Date(s+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s?s.slice(5).replace('-','/') : null};
let latest={items:{}};
function render(data){
 const quotes=data?.items||{};
 $('indices').innerHTML=markets.map(m=>{
  const q=quotes[m.id];const price=Number(q?.price), valid=q&&Number.isFinite(price)&&price>0&&day(q.marketDate);
  const change=q?.change===null||q?.change===undefined?null:Number(q.change);
  const pct=q?.changePct===null||q?.changePct===undefined?null:Number(q.changePct);
  const hasChange=valid&&Number.isFinite(change),hasPct=valid&&Number.isFinite(pct);
  const direction=hasChange?(change>0?'up':change<0?'down':''):'';
  const chip=hasChange?`${change>0?'+':''}${fmt(change)}`:'漲跌 —';
  const pctText=hasPct?`${pct>0?'+':''}${pct.toFixed(2)}%`:'—%';
  const dateText=valid?`${escape(q.marketDate.slice(0,4))}/${day(q.marketDate)} 收盤`:'尚無有效收盤資料';
  const source=valid?`來源：${escape(q.source||'資料供應者')}`:'尚未取得可公開展示的行情';
  const note=valid&&q.note?` · ${escape(q.note)}`:'';
  return `<div class="index-card"><div class="market">${m.market}</div><div class="name">${m.name}</div><div class="value">${valid?fmt(price):'—'}</div><div class="market-chips"><span class="market-chip">${dateText}</span><span class="market-chip ${direction}">${chip}</span><span class="market-chip ${direction}">${pctText}</span></div><div class="market-update">${source}${note}</div></div>`;
 }).join('');
 const count=markets.filter(m=>{const q=quotes[m.id];return q&&Number(q.price)>0&&day(q.marketDate)}).length;
 $('market-updated').textContent=`每日收盤 · 已有 ${count}/9 項資料 · 各地依最近有效交易日顯示`;
}
async function refresh(){if(document.hidden)return;try{
 const response=await fetch('market-quotes.json?ts='+Date.now(),{cache:'no-store'});
 if(!response.ok)throw new Error('HTTP '+response.status);
 const data=await response.json();
 if(data&&data.items&&typeof data.items==='object')latest=data;
 render(latest);
 }catch(e){render(latest);$('market-updated').textContent='收盤資料讀取失敗；顯示已讀取資料';}
}
render(latest);refresh();
setInterval(refresh,60*60*1000); // EOD data only; page checks hourly while visible.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
window.addEventListener('focus',refresh);
})();
