"""Offline unit tests; do not contact media sites or write Firebase data."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path

# Tests only the extractor; no Firebase credentials are loaded.
if 'firebase_admin' not in sys.modules:
    f=types.ModuleType('firebase_admin')
    f.credentials=types.SimpleNamespace()
    f.firestore=types.SimpleNamespace()
    sys.modules['firebase_admin']=f
    sys.modules['firebase_admin.credentials']=f.credentials
    sys.modules['firebase_admin.firestore']=f.firestore
try:
    import feedparser
except ImportError:
    sys.modules['feedparser']=types.ModuleType('feedparser')
path=Path(__file__).resolve().parents[1]/'scripts'/'firebase_import.py'
spec=importlib.util.spec_from_file_location('firebase_import',path)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class ParseTests(unittest.TestCase):
    def test_search_url(self):
        s=mod.build_ltn_search('陳淑華','2026-10-17','2026-10-24')
        self.assertIn('start_time=20261017',s)
        self.assertIn('%E9%99%B3',s)
    def test_list_date_next(self):
        html='''<main><ul><li><a href="https://news.ltn.com.tw/news/local/breakingnews/1234567">台中大型公共工程動態與調查報導</a><span>2026/10/24</span></li>
            <li><a href="https://news.ltn.com.tw/news/politics/breakingnews/7654321">陳淑華議會質詢新聞</a><span>2026/10/22</span></li></ul>
            <a href="/list?keyword=%E5%8F%B0%E4%B8%AD&page=2" rel="next">下一頁</a></main>'''
        entries,nexturl=mod.extract_ltn_results(html,'https://search.ltn.com.tw/list?keyword=x','2026-10-20','2026-10-25')
        self.assertEqual(len(entries),2)
        self.assertEqual(entries[0]['date'],'2026-10-24')
        self.assertIn('page=2',nexturl)
    def test_reject_untrusted_links(self):
        html='<a href="https://example.com/news/1234">external</a>'
        self.assertEqual(mod.extract_ltn_results(html,'https://search.ltn.com.tw/list','2026-10-01','2026-10-31')[0],[])
    def test_invalid_date(self):
        self.assertIsNone(mod.date_only('2026/02/30'))

if __name__=='__main__':unittest.main()
