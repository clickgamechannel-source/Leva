// Race Bot v2 — все функции кроме напоминаний
const T = process.env.TELEGRAM_TOKEN || "8437131418:AAGHQ8Afm5HOrPJUHm6ymvojSUVxcmmUVOY", API = `https://api.telegram.org/bot${T}`;
const DK = process.env.DEEPSEEK_KEY || "sk-4808021f4af14a1d8b88ce84756d4e6d";
const OAI = process.env.OPENAI_KEY || "sk-proj-O84...";
const YT = process.env.YANDEX_TOKEN || "y0__wgBEP...";
const YW = process.env.YANDEX_WEATHER_KEY || "4dca8bfd-ef10-45ce-b192-dfa70a03a76d";
const TV = process.env.TAVILY_KEY || "tvly-dev-3WnJ2z...";
const DS = "https://api.deepseek.com/chat/completions";
const SUP = "https://smkjvihshumsrynnelji.supabase.co", SK = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNta2p2aWhzaHVtc3J5bm5lbGppIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTk1MTg1OSwiZXhwIjoyMTAxNTI3ODU5fQ.3RRL8v9odHXF2YXiLZPKtzpaYp0rpJw16Gg1IqUYVkQ";
const UID = 7649644701;

let offset = 0, mem = { facts: [], notes: [], dialogues: [], expenses: [], events: [], habits: {}, shopping: [], newItems: [] };
const voiceOn = new Map(), alarmQ = new Map();
let lastSearch = "", lastMsgId = 0;

const now = () => new Date(new Date().getTime() + 10800000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tg(method, body) { const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.json(); }
async function send(chat, text) { await tg("sendMessage", { chat_id: chat, text }); }

async function ai(msg) {
  const r = await fetch(DS, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DK}` }, body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "system", content: "Ты Race, ассистент. Отвечай кратко, на русском." }, { role: "user", content: msg }], max_tokens: 500, temperature: 0.7 }) });
  const d = await r.json(); return d.choices?.[0]?.message?.content || "Не поняла.";
}

async function searchWeb(query) {
  try { const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TV}` }, body: JSON.stringify({ query, max_results: 5, include_answer: true }) }); const d = await r.json(); return d.answer ? `Ответ: ${d.answer}\n\n${d.results?.map((r,i) => `${i+1}. ${r.title}\n${r.url}`).join("\n") || ""}` : "Ничего не найдено."; } catch { return "Ошибка поиска."; }
}

async function searchObs(query) {
  if (!YT || !query) return "";
  try { const r = []; async function w(p) { const res = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent("Obsidian/"+p)}&limit=30`, { headers: { Authorization: `OAuth ${YT}` } }); const d = await res.json(); if (!d._embedded?.items) return; for (const i of d._embedded.items) { if (i.type === "dir") await w(p+i.name+"/"); else if (i.name.endsWith(".md")) { r.push(`📄 ${p}${i.name}`); if (r.length >= 15) return; } } } await w(""); return r.length ? "\n\n📁 Obsidian:\n"+r.join("\n") : ""; } catch { return ""; }
}

async function weather() {
  try { const r = await fetch("https://api.weather.yandex.ru/v2/forecast?lat=48.81&lon=37.85&lang=ru_RU&limit=1", { headers: { "X-Yandex-Weather-Key": YW } }); const d = await r.json(), f = d.fact; const mc = { clear: "ясно", "partly-cloudy": "малооблачно", cloudy: "облачно", overcast: "пасмурно", rain: "дождь", "light-rain": "дождь", "heavy-rain": "ливень", snow: "снег", thunderstorm: "гроза" }; const me = { clear: "☀️", "partly-cloudy": "🌤", cloudy: "☁️", overcast: "☁️", rain: "🌧", "light-rain": "🌧", "heavy-rain": "⛈", snow: "❄️", thunderstorm: "⛈" }; const md = { nw: "СЗ", n: "С", ne: "СВ", e: "В", se: "ЮВ", s: "Ю", sw: "ЮЗ", w: "З" }; return `${me[f.condition]||"🌡"} Рай-Александровка: ${mc[f.condition]||f.condition}, ${f.temp}°C (${f.feels_like}°C)\n💨 ${md[f.wind_dir]||f.wind_dir} ${f.wind_speed} м/с\n💧 ${f.humidity}%\n📊 ${f.pressure_mm} мм`; } catch { return "Погода недоступна."; }
}

async function tts(text) {
  try { const r = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OAI}` }, body: JSON.stringify({ model: "tts-1", voice: "nova", input: text.slice(0, 400), response_format: "mp3" }) }); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); } catch { return null; }
}
async function stt(buf) {
  try { const f = new FormData(); f.append("file", new Blob([buf], { type: "audio/ogg" }), "v.ogg"); f.append("model", "whisper-1"); f.append("language", "ru"); const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OAI}` }, body: f }); if (!r.ok) return null; const d = await r.json(); return d.text || null; } catch { return null; }
}

async function load() { try { const r = await fetch(`${SUP}/rest/v1/bot_memory?id=eq.1&select=data`, { headers: { apikey: SK, Authorization: `Bearer ${SK}` } }); const d = await r.json(); if (d[0]?.data) { const l = d[0].data; mem.facts = l.facts || []; mem.notes = l.notes || []; mem.dialogues = l.dialogues || []; mem.expenses = l.expenses || []; mem.events = l.events || []; mem.habits = l.habits || {}; mem.shopping = l.shopping || []; mem.newItems = l.newItems || []; } } catch {} }
async function save() { try { await fetch(`${SUP}/rest/v1/bot_memory?id=eq.1`, { method: "PATCH", headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ data: mem, updated_at: new Date().toISOString() }) }); } catch {} }

async function main() {
  console.log("Race v2");
  await load();
  await fetch(`${API}/deleteWebhook?drop_pending_updates=true`);
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?offset=${offset || ""}&timeout=30`); const d = await r.json();
      if (!d.ok) { await sleep(3000); continue; }
      for (const u of d.result || []) {
        offset = u.update_id + 1; const m = u.message; if (!m) continue;
        if (m.voice) { await tg("sendChatAction", { chat_id: m.chat.id, action: "typing" }); const fr = await fetch(`${API}/getFile?file_id=${m.voice.file_id}`); const fd = await fr.json(); if (fd.ok) { const url = `https://api.telegram.org/file/bot${T}/${fd.result.file_path}`; const ab = await fetch(url); const buf = Buffer.from(await ab.arrayBuffer()); const t = await stt(buf); if (t) { m.text = t; } else { await send(m.chat.id, "Не распознала голос."); continue; } } }
        if (!m.text) continue;
        const cid = m.chat.id, text = m.text.trim();
        if (m.message_id <= lastMsgId) continue;
        lastMsgId = m.message_id;
        console.log("<-", text.slice(0, 60));
        let reply = "";

        if (text === "/start") reply = "Привет! Я Race ✨";
        else if (text === "/weather" || text === "погода") reply = await weather();
        else if (text === "/obsidian" || text.match(/^(?:что в обсидиан|заметк|vault|память|найди в заметк)/i)) { const q = text.replace(/(?:что в обсидиан|заметк|vault|память|найди в заметк|в обсидиане|\/obsidian)/gi, "").trim(); reply = await searchObs(q) || "Ничего не найдено."; }
        else if (text === "/alarm") { alarmQ.set(cid, true); reply = "⏰ На сколько поставить будильник?\nНапиши время, например 7:30"; }
        else if (alarmQ.has(cid)) { alarmQ.delete(cid); const m2 = text.match(/(\d{1,2})[:.](\d{2})/); if (m2) { const h = parseInt(m2[1]), mn = parseInt(m2[2]); reply = `⏰ Будильник на ${h.toString().padStart(2,"0")}:${mn.toString().padStart(2,"0")}!\n😴 Сладких снов!`; } else { reply = "Напиши в формате ЧЧ:ММ, например 7:30"; alarmQ.set(cid, true); } }
        else if (text === "/voice") { voiceOn.set(cid, !voiceOn.get(cid)); reply = voiceOn.get(cid) ? "Голосовые ответы включены" : "Голосовые ответы выключены"; }
        else if (text.match(/^(?:найди|поищи|расскажи)\s+/i)) { const q = text.replace(/^(?:найди|поищи|расскажи)\s+/i, "").trim(); reply = await searchWeb(q); lastSearch = reply; }
        else if (text.match(/^(?:курс|валют)\s*(?:юан|доллар|евро|рубл)/i)) reply = await searchWeb("курс "+text.replace(/^(?:курс|валют)\s*/i,"")+" к рублю сегодня ЦБ РФ");
        else if (text.match(/^(?:переведи)\s+(.+)/i)) { const rest = text.replace(/^переведи\s+/i, ""); const lm = rest.match(/^(?:на\s+)?(английский|english|русский|китайский|chinese|немецкий|german|французский|french)/i); if (lm) { const tl = lm[1].match(/англ|english/i) ? "en" : lm[1].match(/кит|chinese/i) ? "zh" : lm[1].match(/нем|german/i) ? "de" : lm[1].match(/фран|french/i) ? "fr" : "ru"; const tt = rest.replace(lm[0], "").trim(); const tr = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=` + encodeURIComponent(tt)); const td = await tr.json(); reply = td[0]?.map(p => p[0]).join("") || "Не удалось."; } else reply = "На какой язык?"; }
        else if (text.match(/^(?:добавь в покупки)\s+(.+)/i)) { mem.shopping.push(text.replace(/^добавь в покупки\s+/i, "").trim()); await save(); reply = "Добавлено."; }
        else if (text.match(/^(?:список покупок|покупки)/i)) { reply = mem.shopping.length ? mem.shopping.map((s, i) => `${i + 1}. ${s}`).join("\n") : "Список пуст."; }
        else if (text.match(/^(?:добавь встречу|новая встреча)\s+(.+)/i)) { const rest = text.replace(/^(?:добавь встречу|новая встреча)\s+/i, ""); mem.events.push({ date: new Date().toISOString(), desc: rest }); await save(); reply = `Встреча добавлена: ${rest}`; }
        else if (text.match(/^(?:какие планы|встречи|мой календарь)/i)) { reply = mem.events.length ? "Встречи:\n" + mem.events.map((e, i) => `${i + 1}. ${e.desc}`).join("\n") : "Встреч нет."; }
        else if (text.match(/^(?:добавь)\s+(.+)/i) && !text.match(/в заметк|в обсидиан|в покупки|встречу/)) { mem.newItems.push(text.replace(/^добавь\s+/i, "").trim()); await save(); reply = "Добавлено в список."; }
        else if (text.match(/^(?:что нового|список дел)/i)) { reply = mem.newItems.length ? mem.newItems.map((n, i) => `${i + 1}. ${n}`).join("\n") : "Список пуст."; }
        else if (text.match(/^(?:я сделал|я сходил|я пробежал)\s+(.+)/i)) { const h = text.replace(/^(?:я сделал|я сходил|я пробежал)\s+/i, "").trim(); mem.habits[h] = (mem.habits[h] || 0) + 1; await save(); reply = `Отлично! «${h}» — ${mem.habits[h]} раз!`; }
        else if (text.match(/^(?:мой прогресс|привычки)/i)) { reply = Object.keys(mem.habits).length ? Object.entries(mem.habits).map(([k, v]) => `${k}: ${v} раз`).join("\n") : "Нет привычек."; }
        else if (text.match(/^(?:сколько времени|который час)/i)) { const n6 = now(); reply = `${n6.toLocaleTimeString("ru-RU")} (МСК)\n${n6.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}`; }
        else {
          let q = text;
          const obs = await searchObs(text);
          if (obs) q = `${text}\n\n[Obsidian:${obs}]`;
          reply = await ai(q);
        }

        await send(cid, reply);
        console.log("->", reply.slice(0, 60));

        if (voiceOn.get(cid) || m.voice) {
          const vbuf = await tts(reply);
          if (vbuf) { const f2 = new FormData(); f2.append("voice", new Blob([vbuf], { type: "audio/mpeg" }), "r.mp3"); await fetch(`${API}/sendVoice?chat_id=${cid}`, { method: "POST", body: f2 }); }
        }

        mem.dialogues.push({ time: now().toISOString(), user: text.slice(0, 300), bot: reply.slice(0, 300) });
        if (mem.dialogues.length % 3 === 0) await save();
      }
    } catch (e) { console.log("err:", e.message); await sleep(3000); }
  }
}

main();
