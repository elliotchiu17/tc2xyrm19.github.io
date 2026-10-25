#!/usr/bin/env python3
"""Firebase 搜尋工作佇列：自由時報官方 RSS / 官網搜尋頁（實驗）.

不使用 Google 新聞、不按照新聞重要性人工挑選。
嚴格保留來源的日期和網址；來源拒絕自動存取時回報失敗，不製造紀錄。
需要 GitHub Actions secret: FIREBASE_SERVICE_ACCOUNT_JSON。不可將它放進前端。
"""
import hashlib
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse, urlencode, parse_qs
from urllib.robotparser import RobotFileParser

import feedparser
import firebase_admin
import requests
from bs4 import BeautifulSoup
from firebase_admin import credentials, firestore

TZ = timezone(timedelta(hours=8))
BASE = 'https://search.ltn.com.tw/list'
RSS = 'https://news.ltn.com.tw/rss/all.xml'
HEADERS = {'User-Agent': 'PersonalMediaArchive/1.0 (+manual research, respectful rate; GitHub Actions)'}
S = requests.Session()
S.headers.update(HEADERS)
MAX_PAGES_PER_RUN = 12  # 每輪負載上限，不是新聞篇數上限；仍有分頁時下輪繼續
WAIT_SECONDS = 1.8
ARTICLE_WAIT = 1.2
_last_request = 0.0
_robots = {}


def date_only(text, year=None):
    """從頁面標示取得日期；沒有日期則不匯入，不以蒐集時間替代發布日期。"""
    value = (text or '').strip()
    match = re.search(r'(20\d{2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})', value)
    if match:
        yy, mm, dd = (int(n) for n in match.groups())
    else:
        partial = re.search(r'(?<!\d)(\d{1,2})\s*[/.-]\s*(\d{1,2})(?!\d)', value)
        if not partial or year is None:
            return None
        yy, mm, dd = int(year), int(partial[1]), int(partial[2])
    try:
        return date(yy, mm, dd).isoformat()
    except ValueError:
        return None


def allowed_url(url):
    try:
        p = urlparse(url)
        hosts = {'news.ltn.com.tw','ec.ltn.com.tw','ent.ltn.com.tw',
                 'sports.ltn.com.tw','art.ltn.com.tw','health.ltn.com.tw',
                 'auto.ltn.com.tw','def.ltn.com.tw','talk.ltn.com.tw',
                 '3c.ltn.com.tw','stock.ltn.com.tw','istyle.ltn.com.tw',
                 'playing.ltn.com.tw','food.ltn.com.tw','estate.ltn.com.tw'}
        if p.scheme != 'https' or p.hostname not in hosts:
            return False
        # 避免把導覽選單 /news/politics 誤當作新聞；只接受文章永久網址。
        return bool(re.search(r'/(?:breakingnews|paper)/\d+(?:/)?$|/news/\d+(?:/)?$',p.path))
    except Exception:
        return False


def canonical(url):
    p = urlparse(url)
    return f'{p.scheme}://{p.netloc}{p.path.rstrip("/")}'


def robots_allowed(url):
    # Respect the publishers' robots.txt. Unavailable robots.txt is treated as unknown, not permissive.
    host = urlparse(url).netloc
    if host not in _robots:
        rr = f'https://{host}/robots.txt'
        try:
            resp = S.get(rr, timeout=15)
            if resp.status_code == 404:
                _robots[host] = True
            elif resp.status_code == 200:
                rp = RobotFileParser(); rp.parse(resp.text.splitlines()); _robots[host] = rp
            else:
                raise RuntimeError(f'{host} robots.txt HTTP {resp.status_code}; 暫不自動存取')
        except Exception as ex:
            raise RuntimeError(f'無法確認 {host} robots.txt，已停止：{ex}') from ex
    rule = _robots[host]
    return rule is True or rule.can_fetch(HEADERS['User-Agent'].split()[0], url)


def fetch(url):
    global _last_request
    if not robots_allowed(url):
        raise RuntimeError('來源 robots.txt 不允許自動讀取此頁：' + url)
    remaining = WAIT_SECONDS - (time.monotonic() - _last_request)
    if remaining > 0:
        time.sleep(remaining)
    resp = S.get(url, timeout=22, allow_redirects=True)
    _last_request = time.monotonic()
    resp.raise_for_status()
    if not resp.url.startswith('https://'):
        raise RuntimeError('來源重新導向不安全')
    return resp


def build_ltn_search(keyword, start, end):
    return BASE + '?' + urlencode(dict(keyword=keyword,type='all',sort='date',start_time=start.replace('-',''),end_time=end.replace('-','')))


def relative_date(text, today=None):
    """搜尋頁只顯示「3天前」時，取得*估計*日期；真正日期仍以原文 metadata 為優先。"""
    text = (text or '').strip().replace(' ', '')
    today = today or datetime.now(TZ).date()
    if re.search(r'(?:剛剛|剛才|\d+分鐘前|\d+小時前|今天)', text):
        return today.isoformat()
    if '昨天' in text:
        return (today-timedelta(days=1)).isoformat()
    m = re.search(r'(?<!\d)(\d{1,3})天前', text)
    if m:
        return (today-timedelta(days=int(m.group(1)))).isoformat()
    return None


def extract_ltn_results(html, page_url, from_date, to_date):
    """以官網文章網址辨識搜尋項目，不再假設結果必定在 <main> 裡。

    官網目前會顯示包含標題、文章網址、日期的清單；若其 HTML 結構
    不符合事先猜測的 class，就會完全抓不到。改為掃描所有符合
    自由時報文章網址形式的 anchor，再找*就近*的日期標示。
    """
    soup = BeautifulSoup(html, 'html.parser')
    yr = int(from_date[:4]) if from_date[:4] == to_date[:4] else None
    results, seen = [], set()
    for a in soup.select('a[href]'):
        href = a.get('href') or ''
        url = canonical(urljoin(page_url, href))
        if not allowed_url(url) or url in seen:
            continue
        # 文章標題優先；同一篇出現的純連結網址不採用。
        title = (a.get('title') or a.get_text(' ', strip=True) or '').strip()
        if len(title) < 5 or title.startswith(('http://','https://')):
            img = a.find('img')
            title = (img.get('alt', '') if img else '').strip()
        if len(title) < 5 or title.startswith(('http://','https://')):
            continue
        # 同一筆搜尋結果的日期往往是 <li> 或 <div> 兄弟節點，
        # 可以在就近的祖先取得；也支援官網顯示「3天前」。
        published, approx = None, False
        node = a
        for _ in range(5):
            if node is None:
                break
            label = node.get_text(' ', strip=True)
            if len(label) < 1200:  # 防止把整個頁面上的其他文章日期當成這篇日期
                published = date_only(label, yr)
                if published:
                    break
                estimated = relative_date(label)
                if estimated:
                    published, approx = estimated, True
                    break
            node = node.parent
        if not published:
            # 可以在 fetch 原文後取得日期；暫不因清單沒有日期而丟棄文章。
            time_node = a.find_parent(['article','li','div'])
            if time_node:
                stamp = time_node.select_one('time[datetime]')
                if stamp:
                    published = date_only(stamp.get('datetime', ''))
        seen.add(url)
        results.append({'title': title[:240], 'date': published, 'url': url,
                        'estimated_date': approx})

    # 自由時報分頁箭頭實際可能是「〉」（不是 ASCII >）。
    next_url = None
    current_str = parse_qs(urlparse(page_url).query).get('page', ['1'])[0]
    current = int(current_str) if current_str.isdigit() else 1
    for a in soup.select('a[href]'):
        candidate = urljoin(page_url, a.get('href') or '')
        p = urlparse(candidate)
        if p.scheme != 'https' or p.hostname != 'search.ltn.com.tw' or p.path != '/list':
            continue
        label = a.get_text(' ', strip=True).replace(' ', '')
        rel = a.get('rel', [])
        pg = parse_qs(p.query).get('page', [''])[0]
        is_next = 'next' in rel or label in ('下一頁','下頁','Next','›','»','>','〉','→')
        if not is_next and pg.isdigit() and int(pg) == current+1:
            is_next = True
        if is_next and (not pg.isdigit() or int(pg) > current):
            next_url = candidate
            break
    return results, next_url


def search_page_diagnostics(html):
    soup = BeautifulSoup(html, 'html.parser')
    body = soup.get_text(' ', strip=True)
    all_links = soup.select('a[href]')
    article_links = [a for a in all_links if allowed_url(urljoin(BASE, a.get('href','')))]
    match = re.search(r'(?:約有|共)\s*([\d,]+)\s*(?:項結果|筆結果|則結果)', body)
    return {'html_chars':len(html), 'links':len(all_links),
            'article_links':len(article_links), 'reported_results':match.group(1) if match else '未知',
            'has_search_results_text': '項結果' in body or '筆結果' in body,
            'bot_like': bool(re.search(r'captcha|cloudflare|access denied|存取遭拒|人機驗證', body, re.I))}


def article_date(url):
    """只有列表缺發布日期時，有限度讀取該篇 metadata。"""
    if not allowed_url(url): return None
    response = fetch(url)
    soup = BeautifulSoup(response.text, 'html.parser')
    for selector, attr in [
        ('meta[property="article:published_time"]','content'),
        ('meta[name="pubdate"]','content'),
        ('meta[itemprop="datePublished"]','content'),
        ('time[datetime]','datetime')
    ]:
        tag = soup.select_one(selector)
        if tag:
            value = date_only(tag.get(attr,''))
            if value: return value
    for tag in soup.select('script[type="application/ld+json"]'):
        try:
            data=json.loads(tag.string or tag.get_text())
            stack=data if isinstance(data,list) else [data]
            for x in stack:
                if isinstance(x,dict):
                    val=x.get('datePublished') or x.get('dateCreated')
                    found=date_only(str(val)) if val else None
                    if found:return found
        except (ValueError,TypeError):pass
    return None


def official_rss(from_date,to_date,keyword):
    response=fetch(RSS)
    parsed=feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise RuntimeError('官方 RSS 解析失敗')
    entries=[]
    for e in parsed.entries:
        url=canonical(e.get('link',''))
        if not allowed_url(url):continue
        raw = e.get('published') or e.get('updated') or ''
        try:
            d = parsedate_to_datetime(raw).astimezone(TZ).date().isoformat()
        except Exception:
            d = None
            if e.get('published_parsed'):
                d=date(*e['published_parsed'][:3]).isoformat()
        if not d or not (from_date<=d<=to_date):continue
        description=BeautifulSoup(e.get('summary',''),'html.parser').get_text(' ',strip=True)
        title=e.get('title','').strip()
        if keyword not in title and keyword not in description:
            continue
        entries.append(dict(url=url,date=d,title=title[:240]))
    return entries


def get_firestore():
    raw=os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON','').strip()
    if not raw:
        raise RuntimeError('缺少 GitHub Actions Secret: FIREBASE_SERVICE_ACCOUNT_JSON；不會執行匯入')
    obj=json.loads(raw)
    if obj.get('project_id')!='taichung-media-archive':
        raise RuntimeError('服務帳戶的 Firebase 專案不符，已停止，避免誤寫到別人的資料庫')
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(obj))
    return firestore.client()


def claim_job(db, ref):
    transaction=db.transaction()
    @firestore.transactional
    def _claim(t):
        snap=ref.get(transaction=t)
        if not snap.exists:return None
        j=snap.to_dict()
        if j.get('status')=='running':
            heartbeat=j.get('heartbeat')
            if heartbeat and (datetime.now(timezone.utc)-heartbeat).total_seconds()<1800:
                return None
        elif j.get('status')!='pending':return None
        t.update(ref,{'status':'running','heartbeat':firestore.SERVER_TIMESTAMP,'info':'背景程式開始處理'})
        return j
    return _claim(transaction)


def merge_row(db, row, topic_id):
    """URL 穩定 ID：重跑不重複；絕不把管理員排除、備註、標題覆蓋。"""
    url=canonical(row['url'])
    uid=hashlib.sha256(url.lower().encode('utf-8')).hexdigest()[:24]
    did=f"{row['date']}-{uid}"
    private=db.collection('articles').document(did)
    public=db.collection('public_articles').document(did)
    transaction=db.transaction()
    @firestore.transactional
    def _merge(tx):
        original=private.get(transaction=tx)
        if original.exists:
            existing=original.to_dict()
            groups=list(dict.fromkeys((existing.get('topics') or [])+[topic_id]))
            if groups!=existing.get('topics'):
                tx.update(private,{'topics':groups})
                if not existing.get('hidden'):
                    tx.update(public,{'topics':groups})
            return 'duplicate'
        payload={
            'id':did,'date':row['date'],'title':row['title'],'source':'自由時報',
            'kind':'新聞','topics':[topic_id],'url':url,
            'note':'日期由官網搜尋頁相對時間推估，尚未核對原文發稿日期' if row.get('estimated_date') else '',
            'archive_url':'','hidden':False
        }
        tx.set(private,payload)
        tx.set(public,{k:v for k,v in payload.items() if k!='hidden'})
        return 'added'
    return _merge(transaction)


def run_job(db,ref,job):
    source=job.get('source'); keyword=job.get('keyword',''); tid=job.get('topicId','')
    start,end=job.get('start',''),job.get('end','');mode=job.get('mode','site')
    if source!='自由時報' or mode not in ('site','rss') or not keyword or not tid:
        raise RuntimeError('來源／搜尋模式／關鍵字不合法；目前僅支援自由時報')
    start_date=date.fromisoformat(start); end_date=date.fromisoformat(end)
    if (end_date-start_date).days not in range(31):
        raise RuntimeError('一次最多處理 31 天，較長區間請分月提交')
    if end_date>datetime.now(TZ).date():
        raise RuntimeError('不能搜尋未來新聞')
    stats={k:int(job.get(k,0)) for k in ('pages','found','added','duplicate','skipped')}
    errors=list(job.get('errors') or [])[-4:]
    if mode=='rss':
        entries=official_rss(start,end,keyword)
        stats['pages']+=1;stats['found']+=len(entries)
        for r in entries:
            state=merge_row(db,r,tid)
            stats[state]+=1
        ref.update({**stats,'status':'partial','cursor':'',
            'info':f'RSS 已處理最近可取得的 {len(entries)} 則相符新聞；RSS 不含歷史全集，請勿解讀為完整蒐集。',
            'finishedAt':firestore.SERVER_TIMESTAMP,'errors':errors})
        return
    url=job.get('cursor') or build_ltn_search(keyword,start,end)
    seen_urls=set()
    done=False
    for page_index in range(MAX_PAGES_PER_RUN):
        page=fetch(url)
        diagnosis=search_page_diagnostics(page.text)
        print(f'LTN page={page_index+1} HTTP={page.status_code} url={page.url} diagnostics={json.dumps(diagnosis,ensure_ascii=False)}',flush=True)
        rows,next_page=extract_ltn_results(page.text,page.url,start,end)
        print(f'LTN parsed articles={len(rows)} next={bool(next_page)}',flush=True)
        if not rows:
            raise RuntimeError('官網回傳頁面但抓不到文章；'+
                               f'連結={diagnosis["links"]}、文章連結={diagnosis["article_links"]}、'+
                               f'官網顯示結果數={diagnosis["reported_results"]}。'+
                               '請查看 GitHub Actions 的 LTN diagnostics；未宣稱沒有新聞。')
        new_on_page=0
        for r in rows:
            if r['url'] in seen_urls:continue
            seen_urls.add(r['url']);new_on_page+=1
            # 若搜尋頁只寫「3天前」，先向原文確認精確發稿日。
            # 原文暫時不可讀時，保留從搜尋頁推估的日期，並標記未核實。
            if not r.get('date') or r.get('estimated_date'):
                try:
                    exact = article_date(r['url'])
                    if exact:
                        r['date'] = exact
                        r['estimated_date'] = False
                except Exception as e:
                    errors.append(f"無法從原文核對日期 {r['url']}: {str(e)[:70]}")
            if not r.get('date'):
                stats['skipped']+=1
                errors.append('缺少發稿日期：'+r['url'])
                continue
            if not start<=r['date']<=end:continue
            stats['found']+=1
            state=merge_row(db,r,tid)
            stats[state]+=1
        stats['pages']+=1
        if not next_page or next_page==url or new_on_page==0:
            done=True;url='';break
        url=next_page
        ref.update({**stats,'cursor':url,'heartbeat':firestore.SERVER_TIMESTAMP,
                    'info':f'已處理 {stats["pages"]} 頁，找到 {stats["found"]} 筆，下一輪會繼續'} )
    if done:
        msg=f'可解析分頁已處理完畢；找到 {stats["found"]} 筆、其中新增 {stats["added"]} 筆。'
        # 無法獨立核對官網結果總數，一律明示不是保證全集。
        ref.update({**stats,'status':'partial','cursor':'','errors':errors[-5:],
                    'info':msg+' 官網搜尋結果可能不完整，請與官網手動對照。',
                    'finishedAt':firestore.SERVER_TIMESTAMP})
    else:
        ref.update({**stats,'status':'pending','cursor':url,'errors':errors[-5:],
                    'info':f'本輪完成 {MAX_PAGES_PER_RUN} 頁；剩餘分頁將由下次 GitHub Actions 繼續處理'})


def run():
    db=get_firestore()
    col=db.collection('search_jobs')
    # 不用需要複合索引的條件查詢；少量取近期工作後於記憶體挑選待處理的。
    candidates=list(col.order_by('createdAt',direction=firestore.Query.DESCENDING).limit(35).stream())
    pending=[]
    for snap in candidates:
        j=snap.to_dict()
        if j.get('status')=='pending':pending.append(snap)
        elif j.get('status')=='running':
            heartbeat=j.get('heartbeat')
            if not heartbeat or (datetime.now(timezone.utc)-heartbeat).total_seconds()>1800:
                pending.append(snap)
    for snap in sorted(pending,key=lambda x:x.to_dict().get('createdAt') or datetime.min.replace(tzinfo=timezone.utc))[:2]:
        ref=snap.reference;job=claim_job(db,ref)
        if not job:continue
        try:
            run_job(db,ref,job)
            print('Processed job',ref.id)
        except Exception as ex:
            old=list(job.get('errors') or [])[-4:]
            old.append(str(ex)[:350])
            # 不要把資料源封鎖或索引頁改版誤報為「成功」
            ref.update({'status':'failed','info':'此輪無法完成：'+str(ex)[:180],
                        'errors':old,'finishedAt':firestore.SERVER_TIMESTAMP})
            print('FAILED job',ref.id,str(ex),file=sys.stderr)

if __name__=='__main__':
    try:run()
    except Exception as err:
        print('worker failed:',str(err),file=sys.stderr)
        sys.exit(1)
