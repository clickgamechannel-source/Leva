// Race Bot v2 — чистый код
const T = "8437131418:AAGHQ8Afm5HOrPJUHm6ymvojSUVxcmmUVOY";
const API = `https://api.telegram.org/bot${T}`;
const DS = "https://api.deepseek.com/chat/completions";
const DS_KEY = "sk-4808021f4af14a1d8b88ce84756d4e6d";
const YT = "y0__wgBEP-tgu8HGNjRRiCBkbfJGDDHmb_wCGej0QbIAcrMmmU1Raw-GxbCsASh";
const YW = "4dca8bfd-ef10-45ce-b192-dfa70a03a76d";

let offset = 0;

async function send(chat, text) {
  await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }) });
}

async function aiReply(text) {
  const r = await fetch(DS, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DS_KEY}` }, body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: text }], max_tokens: 500 }) });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "Не поняла.";
}

async function searchObsidian(query) {
  if (!YT) return "Яндекс не подключён.";
  try {
    const results = [];
    async function walk(path) {
      const r = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent("Obsidian/" + path)}&limit=50`, { headers: { Authorization: `OAuth ${YT}` } });
      const d = await r.json();
      if (!d._embedded?.items) return;
      for (const item of d._embedded.items) {
        if (item.type === "dir") { await walk(path + item.name + "/"); }
        else if (item.type === "file" && item.name.endsWith(".md")) {
          if (!query || item.name.toLowerCase().includes(query.toLowerCase())) results.push(`📄 ${path}${item.name}`);
          else if (query) {
            try {
              const dl = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent("Obsidian/" + path + item.name)}`, { headers: { Authorization: `OAuth ${YT}` } });
              if (dl.ok) { const dd = await dl.json(); if (dd.href) { const fr = await fetch(dd.href); const c = await fr.text(); if (c.toLowerCase().includes(query.toLowerCase())) results.push(`📄 ${path}${item.name}`); } }
            } catch {}
          }
        }
      }
    }
    await walk("");
    return results.length ? "Найдено в Obsidian:\n" + results.slice(0, 10).join("\n") : "Ничего не найдено.";
  } catch { return "Ошибка поиска."; }
}

async function weather() {
  try {
    const r = await fetch("https://api.weather.yandex.ru/v2/forecast?lat=48.81&lon=37.85&lang=ru_RU&limit=1", { headers: { "X-Yandex-Weather-Key": YW } });
    const d = await r.json();
    const f = d.fact;
    const map = { clear: "ясно", "partly-cloudy": "малооблачно", cloudy: "облачно", overcast: "пасмурно", rain: "дождь", "light-rain": "дождь", "heavy-rain": "ливень", snow: "снег", thunderstorm: "гроза" };
    const em = { clear: "☀️", "partly-cloudy": "🌤", cloudy: "☁️", overcast: "☁️", rain: "🌧", "light-rain": "🌧", "heavy-rain": "⛈", snow: "❄️", thunderstorm: "⛈" };
    const dir = { nw: "СЗ", n: "С", ne: "СВ", e: "В", se: "ЮВ", s: "Ю", sw: "ЮЗ", w: "З", c: "штиль" };
    return `🌡 Рай-Александровка: ${map[f.condition]||f.condition}, ${f.temp}°C (${f.feels_like}°C)\n💨 Ветер: ${dir[f.wind_dir]||f.wind_dir}, ${f.wind_speed} м/с`;
  } catch { return "Погода недоступна."; }
}

async function main() {
  console.log("Race v2 запущен");
  await fetch(`${API}/deleteWebhook?drop_pending_updates=true`);
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?offset=${offset || ""}&timeout=30`);
      const d = await r.json();
      if (!d.ok) { await new Promise(r => setTimeout(r, 3000)); continue; }
      for (const u of d.result || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        const cid = m.chat.id, text = m.text.trim();
        console.log("<-", text.slice(0, 60));
        let reply = "";
        
        if (text === "/start") reply = "Привет! Я Race. Спроси меня о чём-нибудь.";
        else if (text === "/weather" || text === "погода") reply = await weather();
        else if (text.match(/(?:обсидиан|obsidian|заметк|vault|память)/i)) {
          const q = text.replace(/(?:обсидиан|obsidian|заметк|vault|память|в обсидиане|по обсидиану)/gi, "").trim();
          reply = await searchObsidian(q);
        }
        else reply = await aiReply(text);
        
        await send(cid, reply);
        console.log("->", reply.slice(0, 60));
      }
    } catch (e) { console.log("err:", e.message); }
  }
}

main();
