"""Daily scraper: NASDAQ-100 / S&P 500 tracking QDII funds.

Collects fund NAV, day-over-day change, purchase status and purchase
limit, plus overnight index quotes, and writes web/data.json.
"""
from __future__ import annotations

import datetime
import json
import re
import time
from pathlib import Path

import requests

BASE = Path(__file__).resolve().parent
OUT = BASE / "web" / "data.json"
HIST = BASE / "data" / "history.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://fund.eastmoney.com/",
}

SEARCH_KEYS = ["纳斯达克100", "纳指", "标普500"]
NDX_PAT = re.compile(r"纳斯达克100|纳指100")
SPX_PAT = re.compile(r"标普500")
EXCLUDE_PAT = re.compile(r"港股通|红利|石油|消费|生物|精选|等权|全球|中国|香港|100等权")


def _get(url: str, **kw) -> requests.Response:
    kw.setdefault("headers", HEADERS)
    for i in range(3):
        try:
            r = requests.get(url, timeout=20, **kw)
            if r.status_code == 200:
                return r
        except requests.RequestException:
            pass
        time.sleep(1 + i)
    raise RuntimeError(f"failed: {url}")


def _classify(code: str, name: str, company: str = "") -> dict | None:
    if EXCLUDE_PAT.search(name):
        return None
    if NDX_PAT.search(name):
        track = "NDX"
    elif SPX_PAT.search(name):
        track = "SPX"
    else:
        return None
    return {
        "code": code,
        "name": name,
        "track": track,
        "onmarket": code[:2] in {"15", "51", "56", "58"},
        "company": company,
    }


def discover_funds() -> dict[str, dict]:
    funds: dict[str, dict] = {}
    # open-end index-fund ranking pages (covers all QDII 联接/指数 share classes)
    for pi in range(1, 8):
        url = (
            "https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=zs"
            f"&rs=&gs=0&sc=6yzf&st=desc&pi={pi}&pn=500&dx=1"
        )
        txt = _get(url).text
        entries = re.findall(r'"(\d{6}),([^,"]+),', txt)
        if not entries:
            break
        for code, name in entries:
            info = _classify(code, name)
            if info:
                funds[code] = info
    for key in SEARCH_KEYS:
        url = (
            "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
            f"?m=1&key={requests.utils.quote(key)}&pageindex=0&pagesize=200"
        )
        for item in _get(url).json().get("Datas", []):
            code, name = item["CODE"], item["NAME"]
            base = item.get("FundBaseInfo") or {}
            ftype = base.get("FTYPE", "")
            if not code.isdigit() or len(code) != 6:
                continue
            if "海外" not in ftype and "QDII" not in ftype and "QDII" not in name:
                continue
            if EXCLUDE_PAT.search(name):
                continue
            if NDX_PAT.search(name):
                track = "NDX"
            elif SPX_PAT.search(name):
                track = "SPX"
            else:
                continue
            # 场内 ETF codes start with 15/51/56/58 – keep both, tagged
            onmarket = code[:2] in {"15", "51", "56", "58"}
            funds[code] = {
                "code": code,
                "name": name,
                "track": track,
                "onmarket": onmarket,
                "company": base.get("JJGS", ""),
            }
    return funds


def fetch_navs(codes: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(codes), 50):
        batch = ",".join(codes[i : i + 50])
        url = (
            "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo"
            "?pageIndex=1&pageSize=60&plat=Android&appType=ttjj&product=EFund"
            f"&Version=1&deviceid=x&Fcodes={batch}"
        )
        for d in _get(url).json().get("Datas", []):
            out[d["FCODE"]] = {
                "nav": d.get("NAV"),
                "nav_date": d.get("PDATE"),
                "day_chg_pct": d.get("NAVCHGRT"),
            }
    return out


def fetch_nav_history(code: str, n: int = 10) -> list[dict]:
    url = (
        "https://api.fund.eastmoney.com/f10/lsjz"
        f"?fundCode={code}&pageIndex=1&pageSize={n}"
    )
    r = _get(url, headers={**HEADERS, "Referer": "https://fundf10.eastmoney.com/"})
    rows = r.json().get("Data", {}).get("LSJZList", []) or []
    return [
        {
            "date": x["FSRQ"],
            "nav": x["DWJZ"],
            "chg": x.get("JZZZL") or "0",
            "buy_status": x.get("SGZT", ""),
        }
        for x in rows
    ]


def fetch_purchase_limit(code: str) -> str:
    """Scrape 限购金额 (e.g. 限5元 / 限大额) from the fee page."""
    try:
        html = _get(f"https://fundf10.eastmoney.com/jjfl_{code}.html").text
    except RuntimeError:
        return ""
    m = re.search(r"单日累计购买上限[^0-9]*([0-9,.]+万?元)", html)
    if m:
        return m.group(1)
    m = re.search(r"限\s*([0-9,.]+\s*万?元)", html)
    if m:
        return "限" + m.group(1).replace(" ", "")
    return ""


def fetch_indices() -> dict:
    txt = _get("https://qt.gtimg.cn/q=usNDX,usINX").text
    out = {}
    for key, label in (("usNDX", "NDX"), ("usINX", "SPX")):
        m = re.search(rf'v_{key}="([^"]*)"', txt)
        if not m:
            continue
        f = m.group(1).split("~")
        out[label] = {
            "name": "纳斯达克100" if label == "NDX" else "标普500",
            "price": f[3],
            "chg": f[31],
            "chg_pct": f[32],
            "time": f[30],
        }
    return out


SECTORS: list[tuple[str, str, list[str]]] = [
    ("🧠", "AI算力", ["NVDA", "AMD", "VRT", "ANET"]),
    ("💡", "CPO", ["COHR", "LITE", "AAOI"]),
    ("🔬", "半导体", ["SMH"]),
    ("💾", "存储", ["MU", "WDC", "STX"]),
    ("🗄️", "数据中心", ["EQIX", "DLR", "VRT"]),
    ("☁️", "云计算", ["SKYY"]),
    ("🚀", "商业航天", ["RKLB", "LUNR"]),
    ("🛰️", "卫星", ["ASTS", "IRDM"]),
    ("🤖", "机器人", ["BOTZ"]),
    ("🚗", "自动驾驶", ["TSLA", "MBLY"]),
    ("⚛️", "核电", ["URA", "SMR", "OKLO"]),
    ("⚡", "电网", ["XLU", "GEV"]),
    ("🛡️", "军工", ["ITA"]),
    ("🔋", "新能源", ["ICLN"]),
    ("☀️", "光伏", ["TAN"]),
    ("🔌", "锂电池", ["LIT"]),
    ("🛢️", "石油", ["XLE"]),
    ("🔥", "天然气", ["UNG"]),
    ("🟠", "铜 / 有色", ["COPX"]),
    ("🥇", "黄金", ["GLD"]),
    ("🏦", "银行金融", ["XLF"]),
    ("💊", "生物医药", ["XBI"]),
    ("🛒", "消费", ["XLP"]),
    ("🧲", "稀土", ["REMX"]),
]


def fetch_sectors() -> list[dict]:
    tickers = sorted({t for _, _, ts in SECTORS for t in ts})
    txt = _get("https://qt.gtimg.cn/q=" + ",".join(f"us{t}" for t in tickers)).text
    chg: dict[str, float] = {}
    for t in tickers:
        m = re.search(rf'v_us{t}="([^"]*)"', txt)
        if m:
            f = m.group(1).split("~")
            try:
                chg[t] = float(f[32])
            except (IndexError, ValueError):
                pass
    out = []
    for icon, name, ts in SECTORS:
        vals = [chg[t] for t in ts if t in chg]
        if not vals:
            continue
        out.append(
            {
                "icon": icon,
                "name": name,
                "chg_pct": round(sum(vals) / len(vals), 2),
                "tickers": ts,
            }
        )
    return out


def suggestion(idx_chg_pct: float, streak_up: int) -> tuple[str, str]:
    if idx_chg_pct <= -4:
        return "大幅加仓", "指数单日大跌超4%，可考虑加大批次分批买入"
    if idx_chg_pct <= -2:
        return "分批加仓", "指数单日跌超2%，可考虑分批加仓"
    if idx_chg_pct <= -0.8:
        return "小幅加仓", "指数回调，可小额定投加仓"
    if streak_up >= 5:
        return "谨慎追高", f"指数已连涨{streak_up}日，注意回调风险"
    if idx_chg_pct >= 2:
        return "暂缓加仓", "指数单日涨幅较大，建议等待回调"
    return "正常定投", "波动正常，按既定计划定投即可"


def main() -> None:
    today = datetime.date.today().isoformat()
    funds = discover_funds()
    codes = sorted(funds)
    navs = fetch_navs(codes)
    indices = fetch_indices()
    sectors = fetch_sectors()

    idx_hist: dict[str, list] = {}
    if HIST.exists():
        idx_hist = json.loads(HIST.read_text())

    rows = []
    for code in codes:
        f = funds[code]
        hist = fetch_nav_history(code)
        limit = "" if f["onmarket"] else fetch_purchase_limit(code)
        nav = navs.get(code, {})
        rows.append(
            {
                **f,
                **nav,
                "buy_status": hist[0]["buy_status"] if hist else "",
                "purchase_limit": limit,
                "history": hist[::-1],
            }
        )
        time.sleep(0.3)

    for label, q in indices.items():
        seq = idx_hist.setdefault(label, [])
        if not seq or seq[-1]["date"] != today:
            seq.append({"date": today, "chg_pct": q["chg_pct"]})
        idx_hist[label] = seq[-30:]

    def streak(label: str) -> int:
        s = 0
        for e in reversed(idx_hist.get(label, [])):
            if float(e["chg_pct"]) > 0:
                s += 1
            else:
                break
        return s

    advice = {
        label: dict(
            zip(("action", "reason"), suggestion(float(q["chg_pct"]), streak(label)))
        )
        for label, q in indices.items()
    }

    OUT.write_text(
        json.dumps(
            {
                "updated": datetime.datetime.now().isoformat(timespec="seconds"),
                "indices": indices,
                "sectors": sectors,
                "advice": advice,
                "funds": rows,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    HIST.parent.mkdir(exist_ok=True)
    HIST.write_text(json.dumps(idx_hist, ensure_ascii=False), encoding="utf-8")
    print(f"OK funds={len(rows)} -> {OUT}")


if __name__ == "__main__":
    main()
