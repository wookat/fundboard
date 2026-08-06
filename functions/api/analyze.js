// AI 智能体：基于量价指标生成 A 股加/减仓分析（DeepSeek）
import { computeIndices } from "./cn.js";

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };

async function fetchHolding(code) {
  const info = await (await fetch(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=1&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=x&Fcodes=${code}`,
    { headers: UA }
  )).json();
  const d = (info.Datas || [])[0];
  if (!d) return null;
  const hist = await (await fetch(
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=21`,
    { headers: UA }
  )).json();
  const rows = (hist.Data?.LSJZList || []).map((r) => +r.DWJZ).filter((v) => v > 0);
  const navs = rows.slice().reverse(); // oldest -> newest
  const pct = (a, b) => (b ? +(((a - b) / b) * 100).toFixed(2) : null);
  const last = navs[navs.length - 1];
  return {
    code,
    name: d.SHORTNAME,
    nav: d.DWJZ,
    nav_date: d.PDATE,
    day_chg_pct: d.NAVCHGRT,
    chg5: navs.length > 5 ? pct(last, navs[navs.length - 6]) : null,
    chg20: navs.length > 20 ? pct(last, navs[0]) : null,
    history: navs.slice(-10),
  };
}

function indexLines(indices) {
  return indices.map((i) =>
    `${i.name}: 收盘${i.close}(${i.chg_pct > 0 ? "+" : ""}${i.chg_pct}%), MA5=${i.ma5}(${i.above_ma5 ? "站上" : "跌破"}), MA20=${i.ma20}(${i.above_ma20 ? "站上" : "跌破"}), 量比(对5日均量)=${i.vol_ratio}, 连${i.streak > 0 ? "涨" : "跌"}${Math.abs(i.streak)}日, 近5日${i.chg5 > 0 ? "+" : ""}${i.chg5}%, 近20日${i.chg20 > 0 ? "+" : ""}${i.chg20}%`
  ).join("\n");
}

async function callDeepSeek(env, prompt, maxTokens) {
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3, max_tokens: maxTokens,
    }),
  });
  const j = await r.json();
  let text = j.choices?.[0]?.message?.content || "";
  text = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(text);
}

const US_INDICES = [["usNDX", "纳斯达克100"], ["usINX", "标普500"]];

function maOf(vals, n) {
  if (vals.length < n) return null;
  return vals.slice(-n).reduce((a, b) => a + b, 0) / n;
}

async function computeUS() {
  const out = [];
  for (const [code, name] of US_INDICES) {
    const kj = await (await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${code},day,,,60,qfq`,
      { headers: { Referer: "https://gu.qq.com/" } }
    )).json();
    const days = (kj.data?.[code]?.day || []).map((d) => ({ date: d[0], close: +d[2], vol: +d[5] }));
    if (days.length < 21) continue;
    const closes = days.map((d) => d.close);
    const vols = days.map((d) => d.vol);
    const last = days[days.length - 1], prev = days[days.length - 2];
    const chgPct = ((last.close - prev.close) / prev.close) * 100;
    const ma5 = maOf(closes, 5), ma20 = maOf(closes, 20);
    const vma5 = maOf(vols.slice(0, -1), 5);
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
      vol_ratio: vma5 ? +(last.vol / vma5).toFixed(2) : null,
      streak, chg5: +chg5.toFixed(2), chg20: +chg20.toFixed(2),
    });
  }
  return out;
}

async function handlePlan(env, plan) {
  const target = plan.target === "SPX" ? "标普500" : "纳斯达克100";
  const base = Math.max(1, Math.min(1000000, +plan.base || 0));
  if (!base) return Response.json({ error: "请设置基准定投金额" });
  const usIdx = await computeUS();
  const prompt = `你是一位专业的美股指数定投顾问。用户设定的定投计划：标的=${target}，基准每日定投金额=${base}元。

今日美股指数量价数据：
${indexLines(usIdx)}

请按专业定投策略（大跌加码、高位缩量连涨减码或暂停、均线趋势与乖离、波动环境），结合${target}当前状态，给出今日建议投入金额（可为0表示暂停一天，加码一般不超过基准3倍），并简要说明依据。输出JSON格式：{"today_amount":数字,"multiplier":"如1.5x/0.5x/暂停","view":"两三句专业依据（量价、均线、动量）","signal":"加码/正常/减码/暂停之一"}。只输出JSON，不要markdown代码块。`;
  let result;
  try {
    result = await callDeepSeek(env, prompt, 800);
  } catch (e) {
    result = { error: "AI分析暂不可用，请稍后重试" };
  }
  return Response.json({ updated: new Date().toISOString(), indices: usIdx, target, base, ai: result });
}

// 持仓个性化分析：POST {holdings:["000001",...]} 或定投计划 {plan:{target,base}}
export async function onRequestPost(context) {
  const { env, request } = context;
  let codes = [], plan = null;
  try {
    const body = await request.json();
    plan = body.plan || null;
    codes = (body.holdings || []).filter((c) => /^\d{6}$/.test(c)).slice(0, 10);
  } catch (e) { /* ignore */ }
  if (plan) return handlePlan(env, plan);
  if (!codes.length) return Response.json({ error: "请先添加持仓基金" });

  const indices = await computeIndices();
  const holdings = (await Promise.all(codes.map((c) => fetchHolding(c).catch(() => null)))).filter(Boolean);
  if (!holdings.length) return Response.json({ error: "未查到持仓基金数据，请检查基金代码" });

  const hLines = holdings.map((h) =>
    `${h.name}(${h.code}): 最新净值${h.nav}(${h.nav_date}), 当日${h.day_chg_pct > 0 ? "+" : ""}${h.day_chg_pct}%, 近5日${h.chg5 == null ? "--" : (h.chg5 > 0 ? "+" : "") + h.chg5 + "%"}, 近20日${h.chg20 == null ? "--" : (h.chg20 > 0 ? "+" : "") + h.chg20 + "%"}`
  ).join("\n");

  const prompt = `你是一位专业的A股基金投资顾问。今日A股主要指数量价数据：
${indexLines(indices)}

用户当前持仓基金及其近期表现：
${hLines}

请结合今日市场量价环境（量能、均线趋势、动量）与每只基金自身走势和跟踪方向，从专业角度逐只给出操作判断。输出JSON格式：{"holdings":[{"code":"基金代码","name":"基金名","view":"两三句结合大盘与该基金走势的专业分析","signal":"加仓/减仓/持有之一"}],"overall":{"signal":"加仓/减仓/持有观望之一","reason":"结合持仓结构与今日市况的两三句总体建议"}}。只输出JSON，不要markdown代码块。`;

  let result;
  try {
    result = await callDeepSeek(env, prompt, 1600);
  } catch (e) {
    result = { error: "AI分析暂不可用，请稍后重试" };
  }
  return Response.json({ updated: new Date().toISOString(), holdings, ai: result });
}

export async function onRequestGet(context) {
  const { env } = context;
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/api/analyze-v2");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const indices = await computeIndices();
  const lines = indices.map((i) =>
    `${i.name}: 收盘${i.close}(${i.chg_pct > 0 ? "+" : ""}${i.chg_pct}%), MA5=${i.ma5}(${i.above_ma5 ? "站上" : "跌破"}), MA20=${i.ma20}(${i.above_ma20 ? "站上" : "跌破"}), 量比(对5日均量)=${i.vol_ratio}, 连${i.streak > 0 ? "涨" : "跌"}${Math.abs(i.streak)}日, 近5日${i.chg5 > 0 ? "+" : ""}${i.chg5}%, 近20日${i.chg20 > 0 ? "+" : ""}${i.chg20}%`
  ).join("\n");

  const prompt = `你是一位专业的A股技术分析师。以下是今日A股主要指数的量价数据：\n${lines}\n\n请按专业炒股思路（量价关系：放量上涨/缩量回调/放量下跌等，均线趋势：MA5与MA20的多空排列与乖离，动量：连涨连跌与近期涨跌幅）逐个指数简要分析，然后给出总体仓位建议。输出JSON格式：{"analysis":[{"name":"指数名","view":"两三句量价与趋势分析","signal":"加仓/减仓/持有观望之一"}],"overall":{"signal":"加仓/减仓/持有观望之一","reason":"两三句总体理由"}}。只输出JSON，不要markdown代码块。`;

  let result;
  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3, max_tokens: 1200,
      }),
    });
    const j = await r.json();
    let text = j.choices?.[0]?.message?.content || "";
    text = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
    result = JSON.parse(text);
  } catch (e) {
    result = { error: "AI分析暂不可用，请稍后刷新重试", detail: String(e).slice(0, 200) };
  }

  const resp = Response.json(
    { updated: new Date().toISOString(), indices, ai: result },
    { headers: { "cache-control": "public, max-age=900" } }
  );
  if (!result.error) await cache.put(cacheKey, resp.clone());
  return resp;
}
