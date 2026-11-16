"""Komorebi v10-3 — daily *completed-session* closing prices only.

Keyless official TWSE + TAIFEX OpenAPI feeds; optional licensed Twelve Data
for international cash indices. Never scrape a web page or publish guesses.
All updates preserve the last verified record when a provider is unavailable.
Usage: python scripts/update_market_quotes.py
       TWELVEDATA_API_KEY=... python scripts/update_market_quotes.py
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'market-quotes.json'
TZ = ZoneInfo('Asia/Taipei')
NOW = dt.datetime.now(dt.timezone.utc)
API_KEY = os.getenv('TWELVEDATA_API_KEY', '').strip()
# Override a symbol via GitHub Actions Variables if the provider uses another symbol.
SYMBOLS = {
    'SPX': 'SPX', 'IXIC': 'IXIC', 'DJI': 'DJI', 'SOX': 'SOX',
    'N225': 'N225', 'KS11': 'KS11', 'STOXX50E': 'STOXX50E',
}
ZONES = {
    'SPX': 'America/New_York', 'IXIC': 'America/New_York',
    'DJI': 'America/New_York', 'SOX': 'America/New_York',
    'N225': 'Asia/Tokyo', 'KS11': 'Asia/Seoul',
    'STOXX50E': 'Europe/Berlin',
}
# Conservative time after which a daily bar can be treated as final.
# The required delay is tested in *local market time* (DST handled by zoneinfo).
END_AFTER = {'SPX': (17, 30), 'IXIC': (17, 30), 'DJI': (17, 30),
             'SOX': (17, 30), 'N225': (17, 0), 'KS11': (17, 0),
             'STOXX50E': (20, 0)}


def request_json(url: str) -> object:
    req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'Komorebi-EOD/1.0'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def number(value) -> float:
    if value is None or isinstance(value, bool):
        raise ValueError('missing number')
    x = float(str(value).strip().replace(',', '').replace('%', ''))
    if not math.isfinite(x):
        raise ValueError('nonfinite number')
    return x


def date_roc(value) -> str:
    s = str(value).strip().replace('/', '').replace('-', '')
    if not re.fullmatch(r'\d{7,8}', s):
        raise ValueError(f'invalid ROC date: {value!r}')
    year = int(s[:-4]); month = int(s[-4:-2]); day = int(s[-2:])
    return dt.date(year + (1911 if year < 1900 else 0), month, day).isoformat()


def iso_date(value) -> str:
    d = dt.date.fromisoformat(str(value)[:10]); return d.isoformat()


def finalized(day: str, zone: str, hhmm: tuple[int,int]) -> bool:
    date = dt.date.fromisoformat(day)
    local_now = NOW.astimezone(ZoneInfo(zone))
    if date > local_now.date() or (date == local_now.date() and
           (local_now.hour, local_now.minute) < hhmm):
        return False
    return True


def make_record(price: float, day: str, source: str, change: float | None = None,
                previous: float | None = None, *, symbol: str = '', note: str = '') -> dict:
    if price <= 0 or dt.date.fromisoformat(day) > NOW.date() + dt.timedelta(days=1):
        raise ValueError('invalid price/date')
    if change is None and previous is not None and previous > 0:
        change = price - previous
    pct = None
    if change is not None:
        prior = previous if previous and previous > 0 else price - change
        if prior > 0:
            pct = 100 * change / prior
    return {'price': round(price, 5), 'marketDate': day,
            'change': round(change, 5) if change is not None else None,
            'changePct': round(pct, 4) if pct is not None else None,
            'source': source, 'symbol': symbol, 'note': note}


def twse() -> dict:
    data = request_json('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX')
    if not isinstance(data, list): raise ValueError('unexpected TWSE data')
    rows = [r for r in data if isinstance(r, dict) and r.get('指數') == '發行量加權股價指數']
    if not rows: raise ValueError('TAIEX not found in TWSE response')
    row = max(rows, key=lambda r: date_roc(r['日期']))
    sign = str(row.get('漲跌', '')).strip()
    change = number(row['漲跌點數']) * (-1 if sign in ('-', '－', '−') else 1)
    if sign not in ('+', '-', '－', '−', 'X', 'x', ''):
        raise ValueError(f'unknown TWSE sign {sign!r}')
    if sign in ('X','x'): change = None
    return make_record(number(row['收盤指數']), date_roc(row['日期']),
                       '臺灣證券交易所', change, symbol='TAIEX')


def val(row, *needles):
    # TAIFEX open-data column names vary; match exact canonical names first.
    for needle in needles:
        if needle in row: return row[needle]
    for key, value in row.items():
        key0 = str(key).strip().replace(' ', '')
        if any(key0.lower() == n.lower().replace(' ', '') for n in needles):
            return value
    return None


def taifex() -> dict:
    """Near-month TX *regular-session closing price*, not settlement/night."""
    data = request_json('https://openapi.taifex.com.tw/v1/DailyMarketReportFut')
    if not isinstance(data, list): raise ValueError('unexpected TAIFEX data')
    candidates = []
    for row in data:
        if not isinstance(row, dict): continue
        product = str(val(row, 'Contract', '契約', '契約代號', '商品代號', '商品') or '').strip()
        if product != 'TX': continue
        session = str(val(row, 'TradingSession', '交易時段', '交易別') or '').strip()
        if not session: continue  # do not guess the session
        if not (session in ('一般', '一般交易', '一般交易時段', 'Regular', '0') or
                session.lower() in ('regular','day')): continue
        month = str(val(row, 'ContractMonth(Week)', 'ContractMonth', '到期月份(週別)', '到期月份', '契約月份') or '').strip()
        if not re.fullmatch(r'\d{6}', month): continue  # exclude spreads, weeklies
        date_raw = val(row, 'Date', '交易日期', '日期')
        if date_raw is None: continue
        day = date_roc(date_raw) if re.fullmatch(r'\d{7}', str(date_raw)) else iso_date(date_raw) if '-' in str(date_raw) else str(date_raw)
        if re.fullmatch(r'\d{8}', day): day = dt.date(int(day[:4]),int(day[4:6]),int(day[6:])).isoformat()
        price_raw = val(row, 'Close', 'ClosePrice', '收盤價', '最後成交價')
        try: price = number(price_raw)
        except (ValueError,TypeError): continue
        if price <= 0: continue
        candidates.append((day, month, price, row))
    if not candidates: raise ValueError('TX regular-session near-month contract not found (schema/license check needed)')
    day = max(x[0] for x in candidates)
    # For the latest session choose the nearest listed regular monthly contract.
    series = sorted((x for x in candidates if x[0] == day), key=lambda x: x[1])
    date_month = day[:4] + day[5:7]
    eligible = [x for x in series if x[1] >= date_month]
    item = (eligible or series)[0]
    if not finalized(day, 'Asia/Taipei', (15, 30)):
        raise ValueError('TX closing bar not yet final')
    # Use only the reported change, never subtract a different expiry contract.
    raw_change = val(item[3], 'Change', '漲跌價', '漲跌價差')
    try: change = number(raw_change)
    except (ValueError, TypeError): change = None
    return make_record(item[2], day, '臺灣期貨交易所', change=change, symbol='TX '+item[1],
                       note='近月 TX 一般交易時段最後成交價；不含夜盤')


def twelvedata(index: str) -> dict:
    symbol = (os.getenv('TD_SYMBOL_'+index) or SYMBOLS[index]).strip()
    url = 'https://api.twelvedata.com/time_series?' + urllib.parse.urlencode({
        'symbol': symbol, 'interval': '1day', 'outputsize': '5',
        'apikey': API_KEY,
    })
    payload = request_json(url)
    if not isinstance(payload, dict) or payload.get('status') == 'error':
        raise ValueError(str(payload.get('message', 'invalid provider response')) if isinstance(payload, dict) else 'bad response')
    # Never accept a result for a different instrument (ETF vs cash index).
    meta = payload.get('meta') or {}
    ptype = str(meta.get('type', '')).lower()
    if ptype and 'index' not in ptype and ptype not in ('indices',):
        raise ValueError(f'not an index: {meta.get("type")}')
    provider_symbol = str(meta.get('symbol', '')).strip()
    if provider_symbol and provider_symbol.upper() != symbol.upper():
        raise ValueError('provider returned a different symbol')
    values = payload.get('values') or []
    if not isinstance(values, list) or len(values) < 2: raise ValueError('missing daily bars')
    bars=[]
    for row in values:
        try: bars.append((iso_date(row['datetime']), number(row['close'])))
        except (KeyError, ValueError, TypeError): continue
    bars.sort(reverse=True)
    if len(bars)<2: raise ValueError('insufficient valid daily bars')
    # Skip today's in-progress daily bar and use latest *completed* session.
    ready = [(d,p) for d,p in bars if finalized(d, ZONES[index], END_AFTER[index])]
    if not ready: raise ValueError('no completed close yet')
    day, close = ready[0]
    prior = next((p for d,p in bars if d < day), None)
    if prior is None: raise ValueError('previous close not available')
    return make_record(close, day, 'Twelve Data', previous=prior, symbol=symbol)


def newer_than(old: dict | None, new: dict) -> bool:
    if not old: return True
    # Do not regress data or re-commit unchanged records.
    old_date = old.get('marketDate') or ''
    return new['marketDate'] > old_date or (new['marketDate'] == old_date and new != old)


def main() -> int:
    try: previous = json.loads(OUT.read_text(encoding='utf-8'))
    except (OSError, ValueError): previous = {}
    items = dict(previous.get('items') or {})
    updated = []
    feeds = [('TAIEX', twse), ('TX', taifex)]
    if API_KEY:
        feeds += [(idx, lambda idx=idx: twelvedata(idx)) for idx in SYMBOLS]
    else: print('TWELVEDATA_API_KEY not set: 7 international index updates are skipped.')
    for name, fetch in feeds:
        try:
            rec = fetch()
            if newer_than(items.get(name), rec):
                items[name] = rec
                updated.append(name)
                print(f'{name}: {rec["marketDate"]} close={rec["price"]} [updated]')
            else:
                print(f'{name}: unchanged ({rec["marketDate"]})')
        except Exception as error:
            print(f'{name}: unavailable — {type(error).__name__}: {error}')
    if updated:
        content = {'updatedAt': NOW.isoformat(timespec='seconds'),
                   'items': items, 'notice': 'Market dates are local exchange trading dates; verify provider display rights.'}
        OUT.write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Updated {len(updated)} of 9 market records; existing records retained.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
