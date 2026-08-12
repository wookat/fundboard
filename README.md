# FundBoard — 纳指/标普 QDII 基金日报看板

追踪 NDX / SPX 相关 QDII 基金的每日数据看板：净值、溢价率、申购状态等，帮助场外投资者快速比较各只 QDII 基金的当日状态。

## 结构

- `scraper.py` — 数据抓取脚本（每日运行，产出 `data/`）
- `data/` — 抓取到的基金数据
- `web/` — 看板前端
- `functions/` — Cloudflare Pages Functions 接口

## 运行

```bash
pip install -r requirements.txt
python scraper.py
```
