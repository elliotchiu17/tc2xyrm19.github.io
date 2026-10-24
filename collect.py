#!/usr/bin/env python3
"""Conservative supplemental news feed collector for the personal archive.

Search per topic term AND permitted source domain (the only search criteria).
The search index may omit many matching articles; no completeness claims.
No article-ranking, relevance thresholds, daily item caps, or politicians added
implicitly to the Taichung topic. Manual data lives separately in editorial.json.

No third-party Python dependencies; intended for GitHub Actions.
"""
from __future__ import annotations
import argparse
import datetime as dt
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
import re
import sys
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
TZ = ZoneInfo('Asia/Taipei')
GNEWS = 'https://news.google.com/rss/search?'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsArchive/3.0; feed indexer)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
}


def read_json(name, default):
    p=DATA / name
    if not p.exists():return default
    return json.loads(p.read_text(encoding='utf-8'))


def atomic_json(name, value):
    p=DATA / name
    new=p.with_suffix(p.suffix + '.tmp')
    new.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    new.replace(p)


def request(url):
    req=urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as res:
        data=res.read(5_000_001)
        if len(data)>5_000_000:raise ValueError('Feed too large')
        return data


def clean(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', s or ''))).strip()


def date_stamp(s):
    try:
        d=parsedate_to_datetime(s)
        if d.tzinfo is None:d=d.replace(tzinfo=TZ)
        return d.astimezone(TZ).date().isoformat()
    except (ValueError,TypeError,IndexError):
        pass
    try:
        d=dt.datetime.fromisoformat(s.replace('Z','+00:00'))
        if d.tzinfo is None:d=d.replace(tzinfo=TZ)
        return d.astimezone(TZ).date().isoformat()
    except (ValueError,TypeError,AttributeError):return None


def xml_entries(doc):
    root=ET.fromstring(doc)
    rss=[]
    if root.tag.split('}')[-1]=='feed':
        ns='{http://www.w3.org/2005/Atom}'
        for e in root.findall(f'{ns}entry'):
            link=e.find(f'{ns}link')
            video=e.findtext('{http://www.youtube.com/xml/schemas/2015}videoId')
            rss.append({'title':clean(e.findtext(f'{ns}title','')), 'url':('https://www.youtube.com/watch?v='+urllib.parse.quote(video)) if video else (link.attrib.get('href','') if link is not None else ''), 'date':date_stamp(e.findtext(f'{ns}published','') or e.findtext(f'{ns}updated','')), 'description':clean(e.findtext(f'{ns}summary',''))})
    else:
        for e in root.findall('.//item'):
            rss.append({'title':clean(e.findtext('title','')), 'url':clean(e.findtext('link','')), 'date':date_stamp(e.findtext('pubDate','')), 'description':clean(e.findtext('description',''))})
    return rss


def google_query(term, domain, days):
    # No legislator restriction on 台中, no ranking threshold, no per-source item cutoff.
    q=f'"{term}" site:{domain} when:{days}d'
    return GNEWS+urllib.parse.urlencode({'q':q,'hl':'zh-TW','gl':'TW','ceid':'TW:zh-Hant'})


def stable_id(url):
    return hashlib.sha256(url.encode('utf-8')).hexdigest()[:20]


def make_item(raw, src, topic_ids, earliest, today, origin):
    title=raw.get('title','')
    date=raw.get('date')
    url=raw.get('url','')
    parsed=urllib.parse.urlparse(url)
    if not (title and date and earliest<=date<=today and parsed.scheme in ('http','https') and parsed.netloc):return None
    if title.endswith(' - '+src):title=title[:-(len(src)+3)]
    return {'id':stable_id(url),'title':title,'date':date,'source':src,'url':url,'topics':sorted(set(topic_ids)),'kind':'新聞','note':'','archive_url':'','origin':origin}


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--mode',choices=['recent','rebuild'],default='recent')
    ap.add_argument('--days',type=int,default=0,help='Lookback days; 0 means config recent_days')
    ap.add_argument('--topic',default='all',help='Topic ID or all')
    ap.add_argument('--source',default='all',help='Source name or all')
    a=ap.parse_args()
    cfg=read_json('config.json',{})
    base=read_json('news.json',{'items':[],'meta':{}})
    today=dt.datetime.now(TZ).date()
    limit=max(1,min(30,a.days or int(cfg.get('recent_days',3))))
    earliest=max(dt.date.fromisoformat(cfg.get('start_date','2025-01-01')), today-dt.timedelta(days=limit))
    topics=[t for t in cfg['topics'] if a.topic in ('all',t['id'])]
    sources=[s for s in cfg['sources'] if a.source in ('all',s['name'])]
    if not topics:raise SystemExit('No matching topics; check --topic or data/config.json')
    if not sources:raise SystemExit('No matching sources; check --source or data/config.json')
    by_id={item['id']:item for item in base.get('items',[]) if isinstance(item,dict) and item.get('id')}
    count=fail=searches=0
    def add(item):
        nonlocal count
        if not item:return
        current=by_id.get(item['id'])
        if current:
            current['topics']=sorted(set(current.get('topics',[])+item['topics']))
        else:
            by_id[item['id']]=item
            count+=1
    if a.mode=='recent':
        for topic in topics:
            for term in topic.get('terms',[topic['name']]):
                if not term.strip():continue
                for s in sources:
                    searches+=1
                    try:
                        raws=xml_entries(request(google_query(term,s['site_query'],limit)))
                        for raw in raws:
                            add(make_item(raw,s['name'],[topic['id']],earliest.isoformat(),today.isoformat(),'Google 新聞 RSS'))
                        print(f"{topic['name']} / {s['name']}: {len(raws)} results",flush=True)
                    except (urllib.error.URLError, TimeoutError, ValueError, ET.ParseError, OSError) as ex:
                        fail+=1
                        print(f"WARNING: {topic['name']} / {s['name']}: {ex}",file=sys.stderr,flush=True)
        # Optional official publisher RSS complements Google search, no extra significance filter.
        for feed in cfg.get('rss_feeds',[]):
            if a.source not in ('all',feed.get('name')):continue
            searches+=1
            try:
                for r in xml_entries(request(feed['url'])):
                    text=(r['title']+' '+r['description'])
                    matches=[t['id'] for t in topics if any(term in text for term in t.get('terms',[t['name']]))]
                    if matches:add(make_item(r,feed['name'],matches,earliest.isoformat(),today.isoformat(),'媒體官方 RSS'))
            except (urllib.error.URLError, TimeoutError, ValueError, ET.ParseError, OSError) as ex:
                fail+=1
                print(f"WARNING official RSS {feed['name']}: {ex}",file=sys.stderr,flush=True)
    # Never edit editorial.json or discard existing auto entries on refresh.
    items=sorted(by_id.values(),key=lambda x:(x.get('date',''),x.get('id','')),reverse=True)
    meta={'last_checked':dt.datetime.now(TZ).isoformat(timespec='seconds'), 'mode':a.mode,'lookback_days':limit,'queries_attempted':searches,'query_failures':fail,'added':count,'total_auto':len(items),'warning':'Google 新聞及 RSS 可能漏新聞；不保證全部相關報導。沒有設定重要性或新聞量篩選門檻。'}
    atomic_json('news.json',{'items':items,'meta':meta})
    print('RESULT',json.dumps(meta,ensure_ascii=False),flush=True)
    # Fail if every attempted job failed; a green success must not hide a completely unavailable provider.
    if searches and fail==searches:raise SystemExit('All feeds failed; review GitHub Actions logs')

if __name__=='__main__':main()
