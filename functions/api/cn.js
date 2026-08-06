// A股指数实时数据 + 量价指标（腾讯行情公开接口）
const INDICES = [
  ["sh000001", "上证指数"],
  ["sz399001", "深证成指"],
  ["sz399006", "创业板指"],
  ["sh000300", "沪深300"],
];

function ma(vals, n) {
  if (vals.length < n) return null;
  const s = vals.slice(-n).reduce((a, b) => a + b, 0);
  return s / n;
}

export async function computeIndices() {
  const codes = INDICES.map(([c]) => c).join(",");
  const r = await fetch(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${INDICES.map(([c]) => c).join("|")}`,
    { headers: { Referer: "https://gu.qq.com/" } }
  );
  const out = [];
  for (const [code, name] of INDICES) {
    const kr = await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,60,qfq`,
      { headers: { Referer: "https://gu.qq.com/" }, cf: { cacheTtl: 300 } }
    );
    const kj = await kr.json();
    const days = (kj.data?.[code]?.day || []).map((d) => ({
      date: d[0], open: +d[1], close: +d[2], high: +d[3], low: +d[4], vol: +d[5],
    }));
    if (days.length < 21) continue;
    const last = days[days.length - 1];
    const prev = days[days.length - 2];
    const closes = days.map((d) => d.close);
    const vols = days.map((d) => d.vol);
    const chgPct = ((last.close - prev.close) / prev.close) * 100;
    const ma5 = ma(closes, 5), ma20 = ma(closes, 20);
    const vma5 = ma(vols.slice(0, -1), 5);
    const volRatio = vma5 ? last.vol / vma5 : null;
    let streak = 0;
    for (let i = days.length - 1; i > 0; i--) {
      const up = days[i].close > days[i - 1].close;
      if (streak === 0) streak = up ? 1 : -1;
      else if ((streak > 0) === up) streak += up ? 1 : -1;
      else break;
    }
    const chg5 = ((last.close - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
    const chg20 = ((last.close - closes[0]) / closes[0]) * 100;
    out.push({
      code, name, date: last.date, close: last.close,
      chg_pct: +chgPct.toFixed(2),
      ma5: +ma5.toFixed(2), ma20: +ma20.toFixed(2),
      above_ma5: last.close > ma5, above_ma20: last.close > ma20,
      vol_ratio: volRatio ? +volRatio.toFixed(2) : null,
      streak, chg5: +chg5.toFixed(2), chg20: +chg20.toFixed(2),
      closes10: closes.slice(-10),
    });
  }
  return out;
}

export async function onRequestGet() {
  const data = await computeIndices();
  return Response.json({ updated: new Date().toISOString(), indices: data },
    { headers: { "cache-control": "public, max-age=300" } });
}
