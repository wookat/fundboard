// AI 智能体：基于量价指标生成 A 股加/减仓分析（DeepSeek）
import { computeIndices } from "./cn.js";

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
