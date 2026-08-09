import { readFileSync, existsSync, appendFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_FILE = resolve(__dirname, "bot-config.json");
const LOG_FILE = resolve(__dirname, "bot-log.txt");

function log(msg, err) {
  const time = new Date().toLocaleTimeString("ru-RU");
  const line = `[${time}] ${msg}`;
  process.stdout.write(line + "\n");
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
  if (err) {
    process.stderr.write(String(err.message || err) + "\n");
    try { appendFileSync(LOG_FILE, String(err.message || err) + "\n"); } catch {}
  }
}

let config = {};
if (existsSync(CONFIG_FILE)) {
  config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || config.telegramToken;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || config.deepseekKey;
const DEEPSEEK_MODEL = process.env.MODEL || config.model || "deepseek-v4-pro";
const GROQ_KEY = process.env.GROQ_KEY || config.groqKey || "";
const OPENAI_KEY = process.env.OPENAI_KEY || config.openaiKey || "";
const TTS_PROVIDER = process.env.TTS_PROVIDER || config.ttsProvider || "google";
const GITHUB_KEY = process.env.GITHUB_KEY || config.githubKey || "";
const GIST_ID = process.env.GIST_ID || config.gistId || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://smkjvihshumsrynnelji.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNta2p2aWhzaHVtc3J5bm5lbGppIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTk1MTg1OSwiZXhwIjoyMTAxNTI3ODU5fQ.3RRL8v9odHXF2YXiLZPKtzpaYp0rpJw16Gg1IqUYVkQ";
const YANDEX_WEATHER_KEY = process.env.YANDEX_WEATHER_KEY || config.yandexWeatherKey || "";
const YANDEX_TOKEN = process.env.YANDEX_TOKEN || config.yandexToken || "y0__wgBEP-tgu8HGNjRRiCBkbfJGDDHmb_wCGej0QbIAcrMmmU1Raw-GxbCsASh";
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || config.pushoverToken || "";
// const PUSHOVER_USER = process.env.PUSHOVER_USER || config.pushoverUser || "";
const PUSHOVER_USER = process.env.PUSHOVER_USER || config.pushoverUser || "";
const BRAVE_SEARCH_KEY = process.env.BRAVE_SEARCH_KEY || config.braveSearchKey || "";
const TAVILY_KEY = process.env.TAVILY_KEY || config.tavilyKey || "";
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || config.obsidianVault || "D:/OBSIDIAN/Leva";
const OBSIDIAN_REPO = process.env.OBSIDIAN_REPO || config.obsidianRepo || "clickgamechannel-source/Leva";

if (!TELEGRAM_TOKEN) { log("TELEGRAM_TOKEN не задан."); process.exit(1); }
if (!DEEPSEEK_KEY) { log("DEEPSEEK_API_KEY не задан."); process.exit(1); }

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DS_API = "https://api.deepseek.com/chat/completions";
const context = new Map();
const pendingResearch = new Map();
const voicePref = new Map();
// 
let offset = 0;

function addToContext(userId, userMsg, botReply) {
  if (!context.has(userId)) context.set(userId, []);
  const msgs = context.get(userId);
  msgs.push({ role: "user", content: userMsg });
  msgs.push({ role: "assistant", content: botReply.slice(0, 500) });
  if (msgs.length > 50) context.set(userId, msgs.slice(-50));
}

let useWebhook = false;
let webhookInfo = null;

try {
  const ri = await fetch(`${TG_API}/getWebhookInfo`);
  webhookInfo = await ri.json();
  if (webhookInfo.ok && webhookInfo.result && webhookInfo.result.url) {
    useWebhook = true;
  }
} catch {}

try {
  await fetch(`${TG_API}/deleteWebhook?drop_pending_updates=true`);
} catch {}
log("Webhook удалён. long polling");
offset = -1;

async function readObsidianFile(sub) {
  if (!GITHUB_KEY) return "Obsidian Git не настроен.";
  try {
    const r = await fetch(`https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encodeURIComponent(sub)}`, {
      headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return "Файл не найден: " + sub;
    const d = await r.json();
    const content = Buffer.from(d.content, "base64").toString("utf8");
    return content.length > 3500 ? content.slice(0, 3500) + "\n..." : content;
  } catch (e) { return "Ошибка: " + e.message; }
}

async function writeObsidianFile(sub, content) {
  if (!YANDEX_TOKEN) return "Яндекс не подключён.";
  try {
    const cleanPath = sub.replace(/\\/g, "/");
    // Пробуем прямую загрузку через save
    const saveR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent("Obsidian/" + cleanPath)}`, {
      method: "PUT", headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
    }).catch(() => {});
    
    // Затем upload
    const uploadR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent("Obsidian/" + cleanPath)}&overwrite=true`, {
      headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
    });
    const uploadD = await uploadR.json();
    if (uploadD.href) {
      const putR = await fetch(uploadD.href, { method: "PUT", body: content });
      if (putR.ok || putR.status === 201) return `Записано: ${sub}`;
    }
    return "Не удалось сохранить на Яндекс.Диск.";
  } catch (e) { return "Ошибка Яндекс.Диска: " + e.message; }
}

async function searchYandexDisk(query) {
  if (!YANDEX_TOKEN) return "Яндекс.Диск не подключён.";
  try {
    // Быстрый поиск — только по названиям файлов
    const r = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent("Obsidian")}&limit=200`, {
      headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
    });
    const d = await r.json();
    const results = [];
    
    async function searchDir(path, depth) {
      if (depth > 3) return; // макс глубина
      const resp = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent("Obsidian/" + path)}&limit=100`, {
        headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
      });
      const dir = await resp.json();
      if (!dir._embedded?.items) return;
      
      for (const item of dir._embedded.items) {
        const name = item.name.toLowerCase();
        const q = query.toLowerCase();
        if (item.type === "dir") {
          if (q && name.includes(q)) results.push(`📁 ${path}${item.name}/`);
          await searchDir(path + item.name + "/", depth + 1);
        } else if (item.type === "file" && item.name.endsWith(".md")) {
          if (!q || name.includes(q)) {
            results.push({ path: `${path}${item.name}`, size: item.size, name: item.name });
          }
        }
      }
    }
    await searchDir("", 0);

    // Если есть запрос — ищем по содержимому (только в найденных по названию)
    if (query && results.length <= 50) {
      const contentResults = [];
      for (const r of results.slice(0, 20)) {
        try {
          const dl = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent("Obsidian/" + r.path)}`, {
            headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
          });
          if (dl.ok) {
            const dd = await dl.json();
            if (dd.href) {
              const fileR = await fetch(dd.href);
              const content = await fileR.text();
              if (content.toLowerCase().includes(query.toLowerCase())) {
                // Найти контекст вокруг совпадения
                const idx = content.toLowerCase().indexOf(query.toLowerCase());
                const start = Math.max(0, idx - 80);
                const end = Math.min(content.length, idx + query.length + 120);
                const snippet = content.slice(start, end).replace(/\n/g, " ");
                contentResults.push(`📄 ${r.path}: ...${snippet}...`);
              }
            }
          }
        } catch {}
      }
      if (contentResults.length) return `Найдено в Obsidian (${contentResults.length} совпадений):\n\n` + contentResults.slice(0, 10).join("\n\n");
    }

    if (!results.length) return query ? `По запросу «${query}» ничего не найдено.` : "Obsidian пуст.";
    
    const list = results.slice(0, 25).map(r => typeof r === "string" ? r : `📄 ${r.path} (${(r.size/1024).toFixed(1)} КБ)`);
    return (query ? `Найдено в Obsidian:\n\n` : "Файлы в Obsidian:\n\n") + list.join("\n") + (results.length > 25 ? `\n...и ещё ${results.length - 25}` : "");
  } catch (e) { return "Ошибка поиска: " + e.message; }
}

function listVault(sub = "") {
  const dir = safePath(sub);
  if (!dir || !existsSync(dir)) return `Путь не найден: ${sub}`;
  const items = readdirSync(dir, { withFileTypes: true });
  const lines = items.map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`));
  return lines.length ? lines.join("\n") : "(пусто)";
}

function readVault(sub) {
  const file = safePath(sub);
  if (!file || !existsSync(file)) return `Файл не найден: ${sub}`;
  try {
    let content = readFileSync(file, "utf8");
    if (content.length > 3500) content = content.slice(0, 3500) + `\n... (${content.length} символов всего)`;
    return content;
  } catch (e) {
    return `Ошибка чтения: ${e.message}`;
  }
}

function writeVault(sub, content) {
  const file = safePath(sub);
  if (!file) return "Недопустимый путь.";
  try {
    writeFileSync(file, content, "utf8");
    return `Записано: ${sub} (${content.length} символов)`;
  } catch (e) {
    return `Ошибка записи: ${e.message}`;
  }
}

function searchVault(term) {
  const results = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "Clippings") continue;
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        try {
          const content = readFileSync(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(term.toLowerCase())) {
              results.push({ path: relative(OBSIDIAN_VAULT, full), line: i + 1, text: lines[i].trim().slice(0, 120) });
              if (results.length >= 15) return;
            }
          }
        } catch {}
      }
    }
  }
  walk(OBSIDIAN_VAULT);
  if (!results.length) return `Ничего не найдено по "${term}".`;
  return results.map((r) => `▪ **${r.path}**:${r.line} — ${r.text}`).join("\n");
}

function learningsContext() {
  if (!botMemory.learnings || !botMemory.learnings.length) return "";
  let ctx = "ЧЕМУ Я НАУЧИЛАСЬ НА ОШИБКАХ:\n";
  for (const l of botMemory.learnings.slice(-10)) ctx += "- " + l.correction + "\n";
  return ctx;
}

function notesSearch(query) {
  if (!botMemory.notes?.length) return "";
  const q = query.toLowerCase();
  const results = botMemory.notes.filter(n => n.content.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
  if (!results.length) return "";
  let ctx = "ЗАМЕТКИ ИЗ OBSIDIAN (облачная копия):\n";
  for (const n of results.slice(-5)) ctx += "- " + n.path + ": " + n.content.slice(0, 300) + "\n";
  return ctx;
}

function vaultSummary() {
  try {
    const dirs = readdirSync(OBSIDIAN_VAULT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => `  📁 ${e.name}/`);
    return dirs.length ? dirs.join("\n") : "(пустой vault)";
  } catch { return "(vault недоступен)"; }
}

async function researchAndSave(chatId, userId, topic) {
  const folder = "Исследования";
  const fname = topic.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\- ]/g, "").slice(0, 60).trim().replace(/\s+/g, " ") || "исследование";
  const ts = new Date().toISOString().slice(0, 10);
  const notePath = `${folder}/${ts} ${fname}.md`;

  const res = await fetch(DS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: "Ты — исследователь. Напиши подробную структурированную заметку в формате Markdown в деловом стиле. Включи: заголовок #, раздел **Кратко**, основные факты, цены (если применимо), технические характеристики (если применимо), список источников или рекомендации. Язык — русский. Без философии, только факты." },
        { role: "user", content: `Напиши заметку по теме: ${topic}` },
      ],
      max_tokens: 3000,
    }),
  });
  const data = await res.json();
  let reply = data.choices?.[0]?.message?.content;
  if (!reply) reply = data.choices?.[0]?.message?.reasoning_content;
  if (!reply) reply = "Не удалось сгенерировать заметку.";

  const note = reply + `\n\n---\n*Создано: ${new Date().toLocaleString("ru-RU")}*`;

  const noteDir = resolve(OBSIDIAN_VAULT, folder);
  if (!existsSync(noteDir)) {
    mkdirSync(noteDir, { recursive: true });
  }
  writeObsidianFile(notePath, note).catch(() => {});
  // Сохраняем заметку также в облачную память
  if (!botMemory.notes) botMemory.notes = [];
  botMemory.notes.push({ path: notePath, content: reply.slice(0, 2000), time: new Date().toISOString() });
  if (botMemory.notes.length > 100) botMemory.notes = botMemory.notes.slice(-100);
  await saveMemory();

  return `Заметка создана: ${notePath}\n\n` + reply.slice(0, 1800);
}

async function tg(method, body) {
  const url = `${TG_API}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function deepseekChat(userId, text) {
  if (!context.has(userId)) context.set(userId, []);
  const messages = context.get(userId);

  let userMsg = text;

  messages.push({ role: "user", content: userMsg });

  const system = `Ты — Race, персональный ассистент. Ты девушка, общаешься тепло и по-человечески. Твоя задача — помогать с информацией из Obsidian-заметок пользователя.

ПРАВИЛА РАБОТЫ:
1. Определи к какому проекту относится запрос (Мавики, ФПВ, Спорт, ИИ, etc.) — ищи в соответствующей папке.
2. Перед ответом ВСЕГДА проверяй Obsidian на релевантные заметки. Если в контексте есть [НАЙДЕНО В OBSIDIAN] — используй эти данные.
3. Если информации нет — честно скажи и предложи: поискать в интернете, создать новую заметку, или спросить иначе.
4. НИКОГДА не придумывай факты. Только из заметок или из поиска.
5. Отвечай структурированно: краткий вывод → детали → рекомендации.
6. Новую информацию сохраняй с тегами: #проект #тема.

Сейчас: ${mskTime().toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} МСК.`;

  const res = await fetch(DS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "system", content: system }, ...messages.slice(-4)],
      max_tokens: 800,
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  let reply = data.choices?.[0]?.message?.content;
  if (!reply || reply.length < 5) reply = "Я сейчас не могу ответить — попробуй еще раз.";
  messages.push({ role: "assistant", content: reply });
  if (messages.length > 40) context.set(userId, messages.slice(-40));
  return reply;
}

const writeQueue = new Map();

// Утренняя погода в 6:00 МСК
setInterval(async () => {
  const now = mskTime();
  if (now.getHours() !== 6 || now.getMinutes() > 5) return;
  const weather = await fetchWeather(48.81, 37.85, "Рай-Александровка", YANDEX_WEATHER_KEY).catch(() => "Погода недоступна");
  tg("sendMessage", { chat_id: defaultChatId, text: "🌅 Доброе утро!\n\n" + weather }).catch(()=>{});
}, 300000);

// Мониторинг ветра — если > 4 м/с, сообщить
let lastWindSpeed = 0;
setInterval(async () => {
  try {
    const r = await fetch(`https://api.weather.yandex.ru/v2/forecast?lat=48.81&lon=37.85&lang=ru_RU&limit=1`, {
      headers: { "X-Yandex-Weather-Key": YANDEX_WEATHER_KEY }, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return;
    const d = await r.json();
    const wind = d.fact?.wind_speed || 0;
    if (wind > 4 && wind !== lastWindSpeed) {
      const dirNames = { nw: "северо-западный", n: "северный", ne: "северо-восточный", e: "восточный", se: "юго-восточный", s: "южный", sw: "юго-западный", w: "западный", c: "штиль" };
      const dir = dirNames[d.fact.wind_dir] || "";
      tg("sendMessage", { chat_id: defaultChatId, text: `💨 Ветер усилился: ${dir} ${wind} м/с в Рай-Александровке` }).catch(()=>{});
    }
    lastWindSpeed = wind;
  } catch {}
}, 900000); // каждые 15 минут

// Автобэкап каждое воскресенье в 23:00
setInterval(async () => {
  const now = mskTime();
  if (now.getDay() !== 0 || now.getHours() !== 23 || now.getMinutes() > 5) return;
  const backup = JSON.stringify(botMemory);
  const ts = now.toISOString().slice(0,10);
  writeObsidianFile(`Бэкапы/backup-${ts}.json`, backup).catch(()=>{});
  tg("sendMessage", { chat_id: defaultChatId, text: "💾 Бэкап сохранён" }).catch(()=>{});
}, 300000);

async function webSearch(query) {
  // Пробуем Tavily (AI-поиск)
  if (TAVILY_KEY) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
        body: JSON.stringify({ query, search_depth: "advanced", max_results: 5, include_answer: true }),
      });
      const d = await r.json();
      if (d.results?.length) {
        let reply = d.answer ? `Ответ: ${d.answer}\n\n` : "";
        d.results.forEach((r, i) => reply += `${i + 1}. ${r.title}\n${r.content?.slice(0, 200) || ""}\n${r.url}\n\n`);
        return reply.slice(0, 3800);
      }
    } catch {}
  }
  // Fallback: Brave Search
  if (!BRAVE_SEARCH_KEY) return "Поиск не настроен. Нужен API ключ.";
  try {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&search_lang=ru`, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_SEARCH_KEY },
    });
    const d = await r.json();
    if (!d.web?.results?.length) return "Ничего не найдено. Попробуй другие слова.";
    let reply = "";
    d.web.results.forEach((r, i) => reply += `${i + 1}. ${r.title}\n${r.description?.slice(0, 150) || ""}\n${r.url}\n\n`);
    return reply.slice(0, 3800);
  } catch (e) { return "Ошибка поиска."; }
}

async function searchObsidian(query) {
  const results = [];
  const q = query.toLowerCase();
  for (const n of (botMemory.notes || [])) {
    if (n.content.toLowerCase().includes(q)) results.push(`📝 ${n.path}: ${n.content.slice(0, 200)}`);
  }
  for (const f of (botMemory.facts || [])) {
    if (f.toLowerCase().includes(q)) results.push(`🧠 ${f}`);
  }
  for (const d of (botMemory.dialogues || [])) {
    const full = (d.user + " " + d.bot).toLowerCase();
    if (full.includes(q)) results.push(`💬 ${d.time?.slice(0,16)||""}: ${d.user.slice(0,100)} → ${d.bot.slice(0,100)}`);
  }
  for (const e of (botMemory.expenses || [])) {
    if (e.raw.toLowerCase().includes(q)) results.push(`💰 ${e.raw}`);
  }
  if (results.length) return `Нашла в памяти (${results.length} совпадений):\n\n` + results.slice(0, 12).join("\n\n") + (results.length > 12 ? `\n\n...и ещё ${results.length - 12}` : "");
  return `В памяти ничего не найдено по «${query}».`;
}

async function aiSearchDialogues(query) {
  if (!OPENAI_KEY) return null;
  try {
    // Получаем embedding для запроса
    const embR = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
    });
    const embD = await embR.json();
    const queryEmb = embD.data?.[0]?.embedding;
    if (!queryEmb) return null;

    // Индексируем диалоги если ещё не
    if (!botMemory.dialogueEmbeddings) botMemory.dialogueEmbeddings = [];
    const dialogues = botMemory.dialogues || [];
    const startIdx = botMemory.dialogueEmbeddings.length;

    for (let i = startIdx; i < dialogues.length && i < startIdx + 5; i++) {
      const text = (dialogues[i].user + " " + dialogues[i].bot).slice(0, 500);
      const r = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
      });
      const d = await r.json();
      if (d.data?.[0]?.embedding) {
        botMemory.dialogueEmbeddings.push({ idx: i, emb: d.data[0].embedding });
      }
    }
    await saveMemory();

    // Косинусное сходство
    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const scored = botMemory.dialogueEmbeddings.map(e => ({ ...e, score: cosine(queryEmb, e.emb) }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5).filter(s => s.score > 0.3);

    if (!top.length) return null;
    let reply = "Смысловой поиск по диалогам:\n\n";
    for (const s of top) {
      const d = dialogues[s.idx];
      if (d) reply += `💬 ${d.time?.slice(0,16)||""} (совпадение ${(s.score*100).toFixed(0)}%):\n> ${d.user.slice(0,150)}\n→ ${d.bot.slice(0,150)}\n\n`;
    }
    return reply;
  } catch (e) { log("AI search error: " + e.message); return null; }
}

async function listObsidianNotes() {
  const parts = [];
  if (botMemory.notes?.length) parts.push(`📝 Заметки (${botMemory.notes.length}):\n` + botMemory.notes.map(n => `- ${n.path}`).join("\n"));
  if (botMemory.facts?.length) parts.push(`🧠 Факты (${botMemory.facts.length}):\n` + botMemory.facts.map(f => `- ${f}`).join("\n"));
  if (botMemory.expenses?.length) parts.push(`💰 Расходы (${botMemory.expenses.length} транзакций)`);
  if (botMemory.newItems?.length) parts.push(`📋 Список дел (${botMemory.newItems.length}):\n` + botMemory.newItems.map(n => `- ${n.item}`).join("\n"));
  return parts.length ? "Твой Obsidian:\n\n" + parts.join("\n\n") : "Obsidian пуст. Скажи «запомни...» чтобы добавить.";
}

async function getExchangeRates(text) {
  const now = mskTime();
  const searchQuery = text.match(/юан|CNY|cny/i) ? "курс юаня к рублю ЦБ РФ сегодня" : text.match(/доллар|USD|usd/i) ? "курс доллара к рублю ЦБ РФ сегодня" : text.match(/евро|EUR|eur/i) ? "курс евро к рублю ЦБ РФ сегодня" : "курс валют ЦБ РФ сегодня";
  try {
    if (TAVILY_KEY) {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
        body: JSON.stringify({ query: searchQuery, search_depth: "basic", max_results: 1, include_answer: true }),
      });
      const d = await r.json();
      if (d.answer) return `Курсы на ${now.toLocaleDateString("ru-RU")}:\n\n${d.answer}`;
      if (d.results?.[0]?.url) {
        try {
          const extractUrl = "https://r.jina.ai/" + d.results[0].url;
          const content = await fetch(extractUrl, { headers: { Accept: "text/markdown" } });
          const text = await content.text();
          const aiR = await fetch(DS_API, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
            body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: 150, messages: [{ role: "user", content: `Найди актуальный курс валюты в тексте. Выведи: валюта — курс. Если несколько валют — все. Только цифры:\n${text.slice(0, 3000)}` }] }),
          });
          const aiD = await aiR.json();
          return `Курсы на ${now.toLocaleDateString("ru-RU")}:\n\n${aiD.choices?.[0]?.message?.content || "не определено"}\n\nИсточник: ${d.results[0].url}`;
        } catch {}
      }
    }
  } catch {}
  return (await webSearch(searchQuery)) || "Не удалось получить курсы.";
}

async function analyzePhoto(photoBase64, prompt, maxTokens = 500, highDetail = false) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o", max_tokens: maxTokens,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photoBase64}`, detail: highDetail ? "high" : "auto" } }
      ]}],
    }),
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "Не удалось обработать фото.";
}

async function editAndSendPhoto(chatId, photoBase64, caption) {
  try {
    const Jimp = (await import("jimp")).default;
    const imgBuf = Buffer.from(photoBase64, "base64");
    const image = await Jimp.read(imgBuf);
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    if (caption.match(/обведи|выдели|отметь|пометь|кружочк|красн|рамк/i)) {
      const coords = await analyzePhoto(photoBase64, `На этом изображении нужно обвести объект красным. Верни ТОЛЬКО JSON в формате: {"x":процент_от_левого_края,"y":процент_от_верха,"w":процент_ширины,"h":процент_высоты}. Например {"x":30,"y":20,"w":40,"h":60}. Выбери самый заметный объект если не указано какой.`, 200);
      try {
        const match = coords.match(/\{[\s\S]*\}/);
        if (match) {
          const c = JSON.parse(match[0]);
          const cx = Math.round(c.x * w / 100), cy = Math.round(c.y * h / 100), cr = Math.min(Math.round(c.w * w / 100), Math.round(c.h * h / 100));
          for (let dx = -cr/2; dx < cr/2; dx += 0.5) {
            for (let dy = -cr/2; dy < cr/2; dy += 0.5) {
              if (dx*dx + dy*dy <= (cr/2)*(cr/2) + 50 && dx*dx + dy*dy >= (cr/2)*(cr/2) - 200) {
                const px = Math.round(cx + dx), py = Math.round(cy + dy);
                if (px >= 0 && px < w && py >= 0 && py < h) {
                  image.setPixelColor(0xFF0000FF, px, py);
                }
              }
            }
          }
          await tg("sendMessage", { chat_id: chatId, text: "Обвела выделенный объект:" });
        }
      } catch {}
    }

    if (caption.match(/чб|чёрно-бел|черно-бел|grayscale/i)) {
      image.grayscale();
      await tg("sendMessage", { chat_id: chatId, text: "Чёрно-белое:" });
    }
    if (caption.match(/ярче|яркость\+/i)) {
      image.brightness(0.2);
      await tg("sendMessage", { chat_id: chatId, text: "Яркость +20%:" });
    }
    if (caption.match(/темнее|яркость\-/i)) {
      image.brightness(-0.2);
      await tg("sendMessage", { chat_id: chatId, text: "Яркость -20%:" });
    }
    if (caption.match(/контраст/i)) {
      image.contrast(0.3);
      await tg("sendMessage", { chat_id: chatId, text: "Контраст +30%:" });
    }
    if (caption.match(/поверни/i)) {
      image.rotate(90);
      await tg("sendMessage", { chat_id: chatId, text: "Повернуто на 90°:" });
    }
    if (caption.match(/отзеркаль|отрази/i)) {
      image.flip(true, false);
      await tg("sendMessage", { chat_id: chatId, text: "Отзеркалено:" });
    }

    const edited = await image.getBuffer("image/jpeg", { quality: 85 });
    const form = new FormData();
    form.append("photo", new Blob([edited], { type: "image/jpeg" }), "edited.jpg");
    await fetch(`${TG_API}/sendPhoto?chat_id=${chatId}`, { method: "POST", body: form });
    return "Обработано";
  } catch (e) {
    log("Photo edit error: " + e.message);
    return "Не удалось отредактировать фото. Возможно, формат не поддерживается.";
  }
}

const weatherMap = { 0: "Ясно", 1: "Малооблачно", 2: "Облачно", 3: "Пасмурно", 45: "Туман", 51: "Морось", 61: "Дождь", 71: "Снег", 80: "Ливень", 95: "Гроза" };
const yandexWeatherMap = { "clear": "Ясно", "partly-cloudy": "Малооблачно", "cloudy": "Облачно", "overcast": "Пасмурно", "drizzle": "Морось", "light-rain": "Дождь", "rain": "Дождь", "heavy-rain": "Ливень", "showers": "Ливень", "wet-snow": "Мокрый снег", "light-snow": "Снег", "snow": "Снег", "hail": "Град", "thunderstorm": "Гроза", "thunderstorm-with-rain": "Гроза с дождём" };
const weatherEmoji = { "clear": "☀️", "partly-cloudy": "🌤", "cloudy": "☁️", "overcast": "☁️", "drizzle": "🌦", "light-rain": "🌧", "rain": "🌧", "heavy-rain": "⛈", "showers": "🌧", "wet-snow": "🌨", "light-snow": "❄️", "snow": "❄️", "hail": "🌨", "thunderstorm": "⛈", "thunderstorm-with-rain": "⛈" };
const periodEmoji = { morning: "🌅", day: "☀️", evening: "🌆", night: "🌙" };

async function getWeather3Day(lat, lon, name) {
  try {
    const r = await fetch(`https://api.weather.yandex.ru/v2/forecast?lat=${lat}&lon=${lon}&lang=ru_RU&limit=3`, {
      headers: { "X-Yandex-Weather-Key": YANDEX_WEATHER_KEY }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "Погода недоступна.";
    const d = await r.json();
    const f = d.fact;
    const cond = yandexWeatherMap[f.condition] || f.condition;
    const windNames = { nw: "С-З", n: "С", ne: "С-В", e: "В", se: "Ю-В", s: "Ю", sw: "Ю-З", w: "З", c: "штиль" };
    let reply = `${weatherEmoji[f.condition]||"🌡"} ${name}: ${cond}, ${f.temp}°C (${f.feels_like}°C)\n💨 ${windNames[f.wind_dir]||f.wind_dir} ${f.wind_speed} м/с\n\n`;
    const periods = { morning: "🌅 Утро", day: "☀️ День", evening: "🌆 Вечер", night: "🌙 Ночь" };
    const dayNames = ["Сегодня", "Завтра", "Послезавтра"];
    for (let di = 0; di < Math.min(3, d.forecasts?.length || 0); di++) {
      const day = d.forecasts[di];
      reply += `📅 ${dayNames[di]} (${day.date}):\n`;
      for (const [part, label] of Object.entries(periods)) {
        const p = day.parts?.[part];
        if (p) {
          const wc = yandexWeatherMap[p.condition] || p.condition;
          let comment = p.condition?.includes("rain") ? "☂️" : p.condition?.includes("snow") ? "❄️" : p.temp_max > 28 ? "🔥" : p.temp_min < 5 ? "🥶" : "";
          reply += `  ${label}: ${weatherEmoji[p.condition]||""} ${p.temp_min}–${p.temp_max}°C, 💨 ${windNames[p.wind_dir]||p.wind_dir} ${p.wind_speed} м/с ${comment}\n`;
        }
      }
      reply += "\n";
    }
    return reply;
  } catch { return "Ошибка прогноза."; }
}

async function fetchWeather(lat, lon, name, key) {
  const w = await getWeather3Day(lat, lon, name);
  return w.split("📅")[0]?.trim() || w.slice(0, 200);
}
async function downloadVoice(fileId) {
  const r = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const d = await r.json();
  if (!d.ok || !d.result) return null;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${d.result.file_path}`;
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribeVoice(audioBuffer) {
  try {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
    form.append("model", "whisper-1");
    form.append("language", "ru");
    form.append("response_format", "text");

    // OpenAI Whisper
    if (OPENAI_KEY) {
      try {
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form,
        });
        if (r.ok) { const text = await r.text(); if (text?.trim()) return text.trim(); }
      } catch {}
    }

    // Groq Whisper (быстрее, иногда точнее)
    if (GROQ_KEY) {
      try {
        const f2 = new FormData();
        f2.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
        f2.append("model", "whisper-large-v3-turbo");
        f2.append("language", "ru");
        const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: f2,
        });
        if (r.ok) { const d = await r.json(); if (d.text?.trim()) return d.text.trim(); }
      } catch {}
    }

    return null;
  } catch (e) { log("STT error: " + e.message); return null; }
}

async function textToVoice(text, voice = "nova") {
  try {
    if (voice !== "google" && TTS_PROVIDER === "openai" && OPENAI_KEY) {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: "tts-1", voice: voice, input: text.slice(0, 800), response_format: "mp3" }),
      });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    }
    const url = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ru&q=" + encodeURIComponent(text.slice(0, 200));
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 100 ? buf : null;
  } catch (e) {
    log("TTS error: " + e.message);
    return null;
  }
}

let botMemory = { facts: [], prefs: { bot_name: "Race", bot_gender: "female", voice: "nova", timezone: 3 }, dialogues: [], reminders: [], learnings: [], events: [] };
const defaultChatId = 7649644701;
const TZ_OFFSET = (botMemory.prefs?.timezone || 3) * 60 * 60 * 1000; // MSK = UTC+3

function mskTime(date) {
  return new Date((date || new Date()).getTime() + TZ_OFFSET);
}

function fromMSK(date) {
  return new Date(date.getTime() - TZ_OFFSET);
}
let dialogueCounter = 0;

async function loadMemory() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_memory?id=eq.1&select=data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const d = await r.json();
    if (d?.length && d[0].data) {
      const loaded = d[0].data;
      botMemory.facts = loaded.facts || [];
      botMemory.prefs = loaded.prefs || { bot_name: "Race", bot_gender: "female", voice: "nova", timezone: 3 };
      botMemory.dialogues = loaded.dialogues || [];
      botMemory.reminders = loaded.reminders || [];
      botMemory.learnings = loaded.learnings || [];
      botMemory.notes = loaded.notes || [];
      botMemory.expenses = loaded.expenses || [];
      botMemory.newItems = loaded.newItems || [];
      botMemory.habits = loaded.habits || {};
      botMemory.shopping = loaded.shopping || [];
      botMemory.searchHistory = loaded.searchHistory || [];
      botMemory.events = loaded.events || [];
    }
    log("Память загружена (Supabase): " + (botMemory.facts?.length || 0) + " фактов, " + (botMemory.notes?.length || 0) + " заметок");
  } catch (e) { log("Ошибка Supabase: " + e.message); }
}

async function saveMemory() {
  try {
    // Supabase (основное)
    await fetch(`${SUPABASE_URL}/rest/v1/bot_memory?id=eq.1`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ data: botMemory, updated_at: new Date().toISOString() }),
    });
    // Gist (резервное)
    if (GITHUB_KEY && GIST_ID) {
      fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ files: { "memory.json": { content: JSON.stringify(botMemory) } } }),
      }).catch(() => {});
    }
  } catch (e) { log("Ошибка сохранения: " + e.message); }
}

// Статистика сообщений
let stats = { messages: 0, searches: 0, photos: 0, voice: 0, startTime: new Date().toISOString() };

async function selfTest() {
  const results = [];
  try { await fetch("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}` }, signal: AbortSignal.timeout(5000) }); results.push("✅ DeepSeek"); } catch { results.push("❌ DeepSeek"); }
  try { await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${OPENAI_KEY}` }, signal: AbortSignal.timeout(5000) }); results.push("✅ OpenAI"); } catch { results.push("❌ OpenAI"); }
  try { await fetch(`${SUPABASE_URL}/rest/v1/bot_memory?id=eq.1&select=id`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, signal: AbortSignal.timeout(5000) }); results.push("✅ Supabase"); } catch { results.push("❌ Supabase"); }
  if (TAVILY_KEY) try { await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` }, body: JSON.stringify({ query: "test", max_results: 1 }), signal: AbortSignal.timeout(5000) }); results.push("✅ Tavily"); } catch { results.push("❌ Tavily"); }
  if (YANDEX_WEATHER_KEY) try { await fetch(`https://api.weather.yandex.ru/v2/forecast?lat=48.77&lon=37.62&lang=ru_RU&limit=1`, { headers: { "X-Yandex-Weather-Key": YANDEX_WEATHER_KEY }, signal: AbortSignal.timeout(5000) }); results.push("✅ Яндекс.Погода"); } catch { results.push("❌ Яндекс.Погода"); }
  if (YANDEX_TOKEN) try { await fetch("https://cloud-api.yandex.net/v1/disk", { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` }, signal: AbortSignal.timeout(5000) }); results.push("✅ Яндекс.Диск"); } catch { results.push("❌ Яндекс.Диск"); }
  if (YANDEX_TOKEN) try { await fetch("https://api.mail.yandex.net/api/v1/messages?limit=1", { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` }, signal: AbortSignal.timeout(5000) }); results.push("✅ Яндекс.Почта"); } catch { results.push("❌ Яндекс.Почта"); }
  if (GROQ_KEY) try { await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${GROQ_KEY}` }, signal: AbortSignal.timeout(5000) }); results.push("✅ Groq"); } catch { results.push("❌ Groq"); }
  return results.join("\n");
}

function memoryContext() {
  if (!botMemory.facts || !botMemory.facts.length) return "";
  let ctx = "ПАМЯТЬ БОТА:\n";
  for (const f of botMemory.facts.slice(-30)) ctx += "- " + f + "\n";
  if (botMemory.prefs && Object.keys(botMemory.prefs).length) {
    ctx += "Предпочтения пользователя:\n";
    for (const [k, v] of Object.entries(botMemory.prefs)) ctx += "- " + k + ": " + v + "\n";
  }
  return ctx;
}

function parseReminder(text) {
  const now = mskTime();
  let clean = text.replace(/^(напомни мне|напомни|поставь напоминание|установи напоминание)\s*/i, "");
  let target = null, msg = "";
  const inMatch = clean.match(/через\s+(\d+)\s+(минут[уы]?|мин|час[ао]?|часов|день|дня|дней|недел[юиь]?)\s+(.+)/i);
  const tomorrowMatch = clean.match(/завтра\s+(?:в|на)\s+(\d{1,2})[:.](\d{2})\s*(.+)/i);
  const timeMatch = clean.match(/(?:в|на)\s+(\d{1,2})[:.](\d{2})\s*(.+)/i);
  if (tomorrowMatch) {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, parseInt(tomorrowMatch[1]), parseInt(tomorrowMatch[2]), 0);
    msg = tomorrowMatch[3].trim();
  } else if (inMatch) {
    const num = parseInt(inMatch[1]), unit = inMatch[2];
    const mul = { минут: 60, минуту: 60, минуты: 60, мин: 60, час: 3600, часа: 3600, часов: 3600, день: 86400, дня: 86400, дней: 86400, неделю: 604800, недели: 604800, недель: 604800 };
    target = new Date(now.getTime() + num * (mul[unit] || 60) * 1000);
    msg = inMatch[3].trim();
  } else if (timeMatch) {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    msg = timeMatch[3].trim();
  }
  if (target && msg && target > now) return { time: fromMSK(target).toISOString(), message: msg, chatId: defaultChatId, created: new Date().toISOString() };
  return null;
}

function checkReminders() {
  const now = new Date();
  const due = [];
  botMemory.reminders = (botMemory.reminders || []).filter((r) => {
    if (new Date(r.time) <= now) { due.push(r); return false; }
    return true;
  });
  for (const r of due) {
    tg("sendMessage", { chat_id: r.chatId || defaultChatId, text: "Напоминаю: " + r.message }).catch(() => {});
    if (PUSHOVER_TOKEN && PUSHOVER_USER) {
      fetch("https://api.pushover.net/1/messages.json", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, message: r.message, title: "Race — напоминание", sound: r.sound || "pushover" }),
      }).catch(() => {});
    }
    if (r.daily) {
      const next = new Date(new Date(r.time).getTime() + 86400000);
      botMemory.reminders.push({ ...r, time: next.toISOString() });
    }
    log("Напоминание: " + r.message);
  }
  if (due.length) saveMemory().catch(() => {});
}
setInterval(checkReminders, 30000);

let lastRates = {};
setInterval(async () => {
  try {
    const r = await fetch("https://api.exchangerate.host/live?base=RUB&source=ecb&places=4", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.success) return;
    const cny = 1/d.rates.CNY, usd = 1/d.rates.USD, eur = 1/d.rates.EUR;
    if (lastRates.cny && Math.abs(cny - lastRates.cny)/lastRates.cny > 0.02) {
      tg("sendMessage", { chat_id: defaultChatId, text: `📈 Курс юаня изменился: ${lastRates.cny.toFixed(2)} → ${cny.toFixed(2)} ₽` }).catch(()=>{});
    }
    if (lastRates.usd && Math.abs(usd - lastRates.usd)/lastRates.usd > 0.02) {
      tg("sendMessage", { chat_id: defaultChatId, text: `📈 Курс доллара изменился: ${lastRates.usd.toFixed(2)} → ${usd.toFixed(2)} ₽` }).catch(()=>{});
    }
    lastRates = { cny, usd, eur };
  } catch {}
}, 3600000); // раз в час

setInterval(async () => {
  const now = mskTime();
  if (now.getHours() !== 21 || now.getMinutes() > 5) return; // 21:00 МСК
  const isSunday = now.getDay() === 0;
  let report = isSunday ? "📊 Недельный отчёт:\n\n" : "📋 Отчёт за день:\n\n";
  const today = now.toISOString().slice(0,10);
  if (botMemory.events?.length) {
    const todayEvents = botMemory.events.filter(e => e.date.startsWith(today));
    if (todayEvents.length) { report += "📅 Встречи:\n"; todayEvents.forEach(e => report += `  ${new Date(e.date).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})} — ${e.description}\n`); }
  }
  if (botMemory.expenses?.length) {
    const todayExp = botMemory.expenses.filter(e => e.date === today);
    if (todayExp.length) report += `\n💰 Расходов сегодня: ${todayExp.length}`;
  }
  if (botMemory.newItems?.length) {
    report += `\n\n📋 В списке дел: ${botMemory.newItems.length} пунктов`;
  }
  try { await fetchWeather(48.81, 37.85, "", YANDEX_WEATHER_KEY).then(w => report += "\n\n" + w.slice(0, 200)); } catch {}
  if (isSunday && botMemory.dialogues?.length) {
    report += `\n\n💬 Диалогов за неделю: ${botMemory.dialogues.length}`;
  }
  tg("sendMessage", { chat_id: defaultChatId, text: report }).catch(()=>{});
  if (isSunday) {
    const noteContent = report + "\n\n---\n*Автоотчёт Race*";
    writeObsidianFile(`Отчёты/${today}.md`, noteContent).catch(()=>{});
  }
}, 300000); // проверка каждые 5 минут

function parseEvent(text) {
  const clean = text.replace(/^(добавь встречу|добавь событие|новая встреча|создай встречу)\s*/i, "");
  let dateStr = "", desc = "";
  const todayMatch = clean.match(/сегодня\s+(?:в|на)\s+(\d{1,2})[:.](\d{2})\s*(.+)/i);
  const tomorrowMatch = clean.match(/завтра\s+(?:в|на)\s+(\d{1,2})[:.](\d{2})\s*(.+)/i);
  const dateMatch = clean.match(/(\d{2})\.(\d{2})(?:\.(\d{4}))?\s+(?:в|на)\s+(\d{1,2})[:.](\d{2})\s*(.+)/);
  if (todayMatch) { const now = mskTime(); dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,"0")}-${now.getDate().toString().padStart(2,"0")}T${todayMatch[1].padStart(2,"0")}:${todayMatch[2]}:00`; desc = todayMatch[3]; }
  else if (tomorrowMatch) { const d = new Date(mskTime().getTime() + 86400000); dateStr = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,"0")}-${d.getDate().toString().padStart(2,"0")}T${tomorrowMatch[1].padStart(2,"0")}:${tomorrowMatch[2]}:00`; desc = tomorrowMatch[3]; }
  else if (dateMatch) { dateStr = `${dateMatch[3]||mskTime().getFullYear()}-${dateMatch[2].padStart(2,"0")}-${dateMatch[1].padStart(2,"0")}T${dateMatch[4].padStart(2,"0")}:${dateMatch[5]}:00`; desc = dateMatch[6]; }
  if (dateStr && desc) return { date: dateStr, description: desc.trim(), created: new Date().toISOString() };
  return null;
}

function detectIntent(text) {
  const t = text.toLowerCase();

  const researchWords = ["найди", "поищи", "узнай", "расскажи про", "что такое", "исследуй", "собери информацию", "кто такой", "найди информацию", "ищи", "поиск", "подробно про", "напиши доклад", "подготовь обзор"];
  const writeWords = ["добавь в заметку", "запиши в", "сохрани в", "запомни", "напиши в обсидиан", "создай заметку", "добавь в", "запиши заметку"];
  const readWords = ["покажи заметку", "прочитай", "открой заметку", "что в заметк", "покажи файл"];

  for (const w of researchWords) if (t.includes(w)) return { intent: "research", topic: text };
  for (const w of writeWords) if (t.includes(w)) {
    const match = t.match(/(?:добавь в заметку|запиши в|сохрани в|запомни|напиши в обсидиан|создай заметку|добавь в|запиши заметку)\s+[(\u0400-\u04FF\w\/\-]+\s*[(\u0400-\u04FF]?/i);
    if (match) {
      const rest = text.slice(match.index + match[0].length).trim();
      return { intent: "write", content: rest };
    }
    return { intent: "write_ask", text };
  }
  for (const w of readWords) if (t.includes(w)) return { intent: "read", text };
  return { intent: "chat", text };
}

async function poll() {
  try {
    const req = await fetch(`${TG_API}/getUpdates?offset=${offset > 0 ? offset : ""}&timeout=30`);
    const data = await req.json();

    if (!data.ok) {
      if (data.description && data.description.includes("Conflict")) {
        log("Conflict: жду 30с...");
        await delay(30000);
        return;
      }
      log("Telegram error: " + data.description);
      await delay(10000);
      return;
    }

    for (const update of data.result) {
      offset = update.update_id + 1;

      // Обработка callback_query (кнопки)
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbChatId = cb.message.chat.id;
        const cbMsgId = cb.message.message_id;
        if (cb.data.startsWith("alarm_")) {
          const hour = parseInt(cb.data.split("_")[1]);
          // Показываем минуты 0-59
          const minButtons = [];
          for (let row = 0; row < 10; row++) {
            const rowBtns = [];
            for (let col = 0; col < 6; col++) {
              const min = row * 6 + col;
              if (min < 60) rowBtns.push({ text: `${hour}:${min.toString().padStart(2,"0")}`, callback_data: `alarmmin_${hour}_${min}` });
            }
            if (rowBtns.length) minButtons.push(rowBtns);
          }
          minButtons.push([{ text: "❌ Отмена", callback_data: "alarm_cancel" }]);
          await fetch(`${TG_API}/editMessageText`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: cbChatId, message_id: cbMsgId, text: `⏰ ${hour}:00 — выбери минуты:`, reply_markup: { inline_keyboard: minButtons } }),
          });
          await tg("answerCallbackQuery", { callback_query_id: cb.id });
        } else if (cb.data.startsWith("alarmmin_")) {
          const parts = cb.data.split("_");
          const hour = parseInt(parts[1]), min = parseInt(parts[2]);
          const target = new Date(mskTime().getFullYear(), mskTime().getMonth(), mskTime().getDate(), hour, min, 0);
          const nowMSK = mskTime();
          if (target <= nowMSK) target.setDate(target.getDate() + 1);
          if (!botMemory.reminders) botMemory.reminders = [];
          botMemory.reminders.push({ time: fromMSK(target).toISOString(), message: "Будильник", chatId: cbChatId, created: new Date().toISOString(), sound: "alien" });
          await saveMemory();
          await fetch(`${TG_API}/editMessageText`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: cbChatId, message_id: cbMsgId, text: `⏰ Будильник на ${hour}:${min.toString().padStart(2,"0")} установлен!` }),
          });
          await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Готово!" });
        } else if (cb.data === "alarm_cancel") {
          await fetch(`${TG_API}/editMessageText`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: cbChatId, message_id: cbMsgId, text: "❌ Будильник отменён" }),
          });
          await tg("answerCallbackQuery", { callback_query_id: cb.id });
        } else if (cb.data.startsWith("weather_")) {
          const parts = cb.data.split("_");
          const lat = parseFloat(parts[1]), lon = parseFloat(parts[2]), name = parts.slice(3).join(" ");
          const w = await getWeather3Day(lat, lon, name);
          await tg("editMessageText", { chat_id: cbChatId, message_id: cbMsgId, text: w.slice(0, 4000) });
          await tg("answerCallbackQuery", { callback_query_id: cb.id });
        }
        continue;
      }

      const msg = update.message || update.edited_message;
      if (!msg) continue;

      const chatId = msg.chat.id;
      const userId = msg.from?.id || chatId;

      let text = msg.text?.trim();
      let voiceRequested = false;
      let reply = "";

      if (msg.photo) {
        const caption = msg.caption?.trim() || "";
        const photo = msg.photo[msg.photo.length - 1];
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        log(`<- [${userId}] [фото] ${caption.slice(0, 60)}`);

        const fileR = await fetch(`${TG_API}/getFile?file_id=${photo.file_id}`);
        const fileD = await fileR.json();
        if (!fileD.ok) { await tg("sendMessage", { chat_id: chatId, text: "Не удалось получить фото." }); continue; }
        const photoUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileD.result.file_path}`;
        const photoData = await fetch(photoUrl);
        const photoBase64 = Buffer.from(await photoData.arrayBuffer()).toString("base64");
        // lastPhoto removed

        if (caption.match(/(?:расход|трат|финанс|бюджет|отч[её]т)/i)) {
          const expenseText = await analyzePhoto(photoBase64, "На этом фото список транзакций или расходов. Внимательно прочитай ВСЕ строки: дату, описание, сумму. Выведи в формате: дата | описание | сумма. Каждую транзакцию с новой строки.", 1500, true);
          if (!botMemory.expenses) botMemory.expenses = [];
          const lines = expenseText.split("\n").filter(l => l.match(/\d/));
          for (const line of lines) {
            botMemory.expenses.push({ raw: line.trim(), date: new Date().toISOString().slice(0, 10), time: new Date().toISOString() });
          }
          await saveMemory();
          reply = `Распознала расходы (${lines.length} транзакций):\n${expenseText.slice(0, 1500)}\n\nСохранено в облако. Скажи «покажи отчёт за месяц» для сводки.`;
        } else if (caption.match(/(?:найди|поищи|артикул|озон|ozon|wb|wildberries)/i)) {
          const marketplace = caption.match(/озон|ozon/i) ? "ozon.ru" : caption.match(/wb|wildberries/i) ? "wildberries.ru" : "";
          const marketLabel = marketplace === "ozon.ru" ? "Ozon" : marketplace === "wildberries.ru" ? "Wildberries" : "интернете";
          // Распознаём всё сразу
          const ocrText = await analyzePhoto(photoBase64, "Ты — эксперт по товарам. На фото товар. Выведи ТОЛЬКО:\n1. Бренд\n2. Модель (точное название)\n3. Артикул\n4. Штрихкод\n5. Категория\n6. Характеристики (цвет, размер)\n\nФормат: Бренд: X | Модель: Y | Артикул: Z\nЕсли чего-то нет — пропусти.", 400, true);
          const searchQuery = ocrText.replace(/[^\w\sа-яё\-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 120) || caption.replace(/(найди|поищи|артикул|озон|ozon|wb|wildberries|на |по )/gi, "").trim();

          reply = `🔍 Распознала:\n${ocrText.slice(0, 300)}\n\nИщу на ${marketLabel}...`;

          // Поиск с site: + цена
          const siteQuery = marketplace ? `site:${marketplace}` : "";
          const searchResult = await webSearch(`${searchQuery} ${siteQuery} цена купить`);

          // Если есть результаты — показываем подробно
          if (searchResult && !searchResult.includes("ничего не найдено")) {
            reply = `🔍 Распознала:\n${ocrText.slice(0, 250)}\n\n📦 На ${marketLabel}:\n\n${searchResult}`;
          } else {
            // Не найдено — предлагаем переснять
            reply = `🔍 Распознала:\n${ocrText.slice(0, 250)}\n\n❌ На ${marketLabel} ничего не найдено.\n\nПопробуй:\n• Сфоткай товар крупнее — чтобы был виден артикул или штрихкод\n• Сфоткай упаковку — там обычно есть модель\n• Напиши название товара текстом — я поищу`;
          }
        } else if (caption.match(/^(прочитай|читай|распознай текст|что написано|ocr)/i)) {
          reply = await analyzePhoto(photoBase64, "Внимательно прочитай ВЕСЬ текст на этом изображении. Выведи только текст, точно как он написан. Если есть QR-код или штрихкод — расшифруй. Если есть цифры — выведи их.", 1000, true);
        } else if (caption.match(/^(опиши|что на фото|что изображено|опиши фото|что это)/i)) {
          reply = await analyzePhoto(photoBase64, "Опиши максимально подробно что на этом фото: предметы, люди, текст, цвета, обстановку. На русском.", 500, true);
        } else if (caption.match(/(обведи|выдели|отметь|пометь|кружочк|красн|рамк)/i)) {
          reply = await editAndSendPhoto(chatId, photoBase64, caption);
          continue;
        } else if (caption.match(/(чб|чёрно-бел|черно-бел|grayscale|ярче|темнее|яркость|контраст|поверни|отзеркаль)/i)) {
          reply = await editAndSendPhoto(chatId, photoBase64, caption);
          continue;
        } else if (caption) {
          reply = await analyzePhoto(photoBase64, caption, 800);
        } else {
          reply = await analyzePhoto(photoBase64, "Опиши максимально подробно что на этом фото: все предметы, люди, текст, цвета, обстановку. Если есть текст — прочитай его. На русском.", 500, true);
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        context.delete(userId);
        continue;
      }

      if (!text && msg.voice) {
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        log(`<- [${userId}] [голосовое]`);
        const audio = await downloadVoice(msg.voice.file_id);
        if (audio) {
          text = await transcribeVoice(audio);
          if (text) {
            voiceRequested = true;
            log(`<- [${userId}] ${text.slice(0, 80)}`);
          }
        }
        if (!text) {
          await tg("sendMessage", { chat_id: chatId, text: "Не удалось распознать голосовое сообщение." });
          continue;
        }
      }

      if (!text) continue;

      log(`<- [${userId}] ${text.slice(0, 80)}`);

      if (text === "/start") {
        await tg("sendMessage", { chat_id: chatId, text: `Привет! Я OpenCode (DeepSeek V4 Pro).\n\nЯ понимаю естественную речь:\n• «найди инфу про...» — найду и сохраню в Obsidian\n• «добавь в заметку ...» — запишу\n• «прочитай заметку ...» — покажу\n\nКоманды: /clear /model /vault` });
        continue;
      }
      if (text === "/clear") { context.delete(userId); await tg("sendMessage", { chat_id: chatId, text: "Контекст очищен." }); continue; }
      if (text === "/model") { await tg("sendMessage", { chat_id: chatId, text: `Модель: ${DEEPSEEK_MODEL}` }); continue; }

      if (text.startsWith("/voice")) {
        const arg = text.slice(7).trim().toLowerCase();
        let vr;
        if (arg === "on" || arg === "вкл") { voicePref.set(userId, true); vr = "Голосовые ответы включены. Буду отвечать и текстом, и голосом."; }
        else if (arg === "off" || arg === "выкл") { voicePref.set(userId, false); vr = "Голосовые ответы выключены."; }
        else { vr = "/voice on — включить голосовые ответы\n/voice off — выключить"; }
        await tg("sendMessage", { chat_id: chatId, text: vr });
        continue;
      }

      if (text.toLowerCase().startsWith("запомни")) {
        const fact = text.slice(7).trim();
        if (fact) {
          botMemory.facts.push(fact);
          await saveMemory();
          reply = "Запомнил: " + fact;
        } else {
          reply = "Что запомнить? Напиши: запомни <факт>";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(что ты помнишь|память|что ты знаешь обо мне)/i)) {
        if (!botMemory.facts.length) {
          reply = "Пока ничего не помню. Скажи «запомни <факт>» чтобы я сохранил.";
        } else {
          reply = "Я помню:\n" + botMemory.facts.map((f, i) => (i + 1) + ". " + f).join("\n");
          if (botMemory.prefs && Object.keys(botMemory.prefs).length) {
            reply += "\n\nПредпочтения:";
            for (const [k, v] of Object.entries(botMemory.prefs)) reply += "\n" + k + ": " + v;
          }
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.toLowerCase().startsWith("забудь")) {
        const idx = parseInt(text.slice(6).trim());
        if (!isNaN(idx) && idx > 0 && idx <= botMemory.facts.length) {
          const removed = botMemory.facts.splice(idx - 1, 1)[0];
          await saveMemory();
          reply = "Забыл: " + removed;
        } else if (text.toLowerCase().startsWith("забудь всё") || text.toLowerCase().startsWith("забудь все")) {
          botMemory.facts = [];
          await saveMemory();
          reply = "Вся память очищена.";
        } else {
          reply = "Что забыть? Напиши: забудь <номер>";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(напомни|о чём мы говорили|поищи в истории)/i) && !text.match(/через\s+\d+|завтра|в \d|послезавтра/)) {
        const query = text.replace(/^(напомни|о чём мы говорили|поищи в истории)\s*/i, "").trim();
        if (!query) { reply = "Что напомнить? Скажи: «напомни про Mavic» или «о чём мы говорили во вторник»."; }
        else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          const results = [];
          const dialDir = resolve(OBSIDIAN_VAULT, "Диалоги");
          if (existsSync(dialDir)) {
            for (const f of readdirSync(dialDir)) {
              if (!f.endsWith(".md")) continue;
              try {
                const content = readFileSync(join(dialDir, f), "utf8");
                const lc = content.toLowerCase();
                if (lc.includes(query.toLowerCase())) {
                  const lines = content.split("\n");
                  const matches = [];
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                      const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 5)).join("\n");
                      matches.push(ctx.slice(0, 300));
                      if (matches.length >= 3) break;
      }

      if (text.match(/^(добавь в вики|создай страницу|новая страница|запиши в вики)\s+(.+)/i)) {
        const rest = text.replace(/^(добавь в вики|создай страницу|новая страница|запиши в вики)\s+/i, "");
        const pageName = rest.replace(/\s+/g, "-").toLowerCase().replace(/[^а-яёa-z0-9\-]/gi, "").slice(0, 60);
        const content = rest;
        const pageContent = `# ${rest}\n\n**Summary**: \n\n**Sources**: \n\n**Last updated**: ${mskTime().toLocaleDateString("ru-RU")}\n\n---\n\n${content}\n\n## Related pages\n\n`;
        const path = `wiki/${pageName}.md`;
        writeObsidianFile(path, pageContent).catch(() => {});
        // Обновить index
        const idxPath = "wiki/index.md";
        const idxEntry = `\n- [[${pageName}]]`;
        try {
          const idxR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent("Obsidian/"+idxPath)}`, { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` } });
          if (idxR.ok) {
            const dd = await idxR.json();
            if (dd.href) {
              const fileR = await fetch(dd.href);
              const existing = await fileR.text();
              if (!existing.includes(`[[${pageName}]]`)) {
                await writeObsidianFile(idxPath, existing + idxEntry);
              }
            }
          }
        } catch {}
        reply = `Страница создана: wiki/${pageName}.md`;
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(линт вики|проверь вики|аудит вики)/i)) {
        reply = "Линт вики:\n";
        try {
          const idxR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent("Obsidian/wiki/index.md")}`, { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` } });
          if (idxR.ok) {
            const dd = await idxR.json();
            if (dd.href) {
              const idxText = await (await fetch(dd.href)).text();
              const links = idxText.match(/\[\[([^\]]+)\]\]/g) || [];
              reply += `• Страниц в индексе: ${links.length}\n`;
              reply += `• Проверь wiki/ в Яндекс.Диске на сиротские страницы\n`;
            }
          } else reply += "• index.md не найден\n";
        } catch { reply += "• Ошибка проверки\n"; }
        reply += "\nСовет: проверь что все страницы в index.md имеют обратные ссылки.";
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }
      }

      if (text === "/obsidian" || text === "/search") {
        reply = "Что найти в Obsidian? Напиши тему или ключевые слова.\nНапример: что в обсидиан про Mavic";
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(расскажи кратко|вкратце|суть|о чём заметка|перескажи|суммируй)\s+(.+)/i)) {
        const q = text.replace(/^(расскажи кратко|вкратце|суть|о чём заметка|перескажи|суммируй)\s+/i, "").trim();
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        const found = await searchYandexDisk(q);
        if (found.includes("ничего не найдено")) { reply = `Заметка «${q}» не найдена.`; }
        else {
          const match = found.match(/📄\s+(\S+\.md)/);
          if (match) {
            try {
              const dl = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent("Obsidian/" + match[1])}`, { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` } });
              if (dl.ok) {
                const dd = await dl.json();
                if (dd.href) {
                  const content = await (await fetch(dd.href)).text();
                  const aiR = await fetch(DS_API, {
                    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
                    body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: 500, messages: [{ role: "system", content: "Перескажи кратко. Главное: о чём, ключевые факты, выводы. На русском." }, { role: "user", content: content.slice(0, 4000) }] }),
                  });
                  const aiD = await aiR.json();
                  reply = `📄 ${match[1]}:\n\n${aiD.choices?.[0]?.message?.content || "Не удалось."}`;
                }
              }
            } catch { reply = "Ошибка чтения."; }
          } else reply = "Нашла несколько. Уточни:\n" + found.slice(0, 500);
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/(?:что в обсидиан|что на диске|прочитай заметк|покажи заметк|что в вики|найди в обсидиан|поищи на диске|что в vault|какие файлы|найди в заметк|поищи в заметк)/i)) {
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        const q = text.replace(/(?:что в обсидиан|что на диске|прочитай заметк|покажи заметк|что в вики|найди в обсидиан|поищи на диске|что в vault|какие файлы)/gi, "").trim();
        reply = await searchYandexDisk(q);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }
                  results.push({ file: f, matches });
                  if (results.length >= 3) break;
                }
              } catch {}
            }
          }
          if (results.length) {
            reply = "Нашла в истории:\n\n";
            for (const r of results) {
              reply += `${r.file}:\n`;
              for (const m of r.matches) reply += `${m}\n...\n`;
            }
            if (reply.length > 3800) reply = reply.slice(0, 3800) + "\n...";
          } else {
            reply = `В истории ничего не найдено по запросу "${query}".`;
          }
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(ответь|скажи|озвучь)\s+(голосом|в голос)/i)) {
        voiceRequested = true;
      }

      if (writeQueue.has(userId)) {
        const sub = writeQueue.get(userId);
        writeQueue.delete(userId);
        const result = writeVault(sub, text);
        await tg("sendMessage", { chat_id: chatId, text: result });
        continue;
      }

      if (pendingResearch.has(userId)) {
        const topic = pendingResearch.get(userId);
        pendingResearch.delete(userId);
        await tg("sendMessage", { chat_id: chatId, text: `Ищу: "${topic}"...` });
        const result = await researchAndSave(chatId, userId, topic);
        const chunks = splitMessage(result);
        for (const chunk of chunks) await tg("sendMessage", { chat_id: chatId, text: chunk });
        continue;
      }

      if (text === "/alarm" || text.match(/^будильник$/i)) {
        const buttons = [];
        for (let row = 0; row < 4; row++) {
          const rowBtns = [];
          for (let col = 0; col < 6; col++) {
            const hour = row * 6 + col + 1;
            if (hour <= 24) rowBtns.push({ text: `${hour}:00`, callback_data: `alarm_${hour}` });
          }
          buttons.push(rowBtns);
        }
        buttons.push([{ text: "❌ Отмена", callback_data: "alarm_cancel" }]);
        await fetch(`${TG_API}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "⏰ Выбери час для будильника:",
            reply_markup: { inline_keyboard: buttons },
          }),
        });
        continue;
      }

      if (text === "/weather" || text === "погода") {
        await fetch(`${TG_API}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "📍 Выбери город:",
            reply_markup: { inline_keyboard: [
              [{ text: "🏙 Москва", callback_data: "weather_55.75_37.62_Moscow" }],
              [{ text: "🏠 Луганск", callback_data: "weather_48.57_39.31_Lugansk" }],
              [{ text: "🏘 Лисичанск", callback_data: "weather_48.90_38.44_Lisichansk" }],
              [{ text: "🌳 Рай-Александровка", callback_data: "weather_48.81_37.85_RayAleksandrovka" }],
            ]}
          }),
        });
        continue;
      }

      if (text.match(/^(сколько времени|который час|какое время|точное время)/i)) {
        const now = mskTime();
        reply = `Сейчас ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} (МСК)\n${now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(какое сегодня число|какая дата|какое число|сегодня число)/i)) {
        const now = mskTime();
        reply = `Сегодня ${now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(напомни мне|напомни|поставь напоминание|установи напоминание)/i) && text.match(/через|завтра|в \d|послезавтра/)) {
        const reminder = parseReminder(text);
        if (reminder) {
          if (!botMemory.reminders) botMemory.reminders = [];
          botMemory.reminders.push(reminder);
          await saveMemory();
          const t = mskTime(new Date(reminder.time));
          reply = `Напоминание: ${t.toLocaleDateString("ru-RU")} в ${t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} (МСК) — «${reminder.message}»`;
        } else {
          reply = "Не поняла когда. Примеры:\n• напомни через 10 минут проверить\n• напомни завтра в 9:00 встреча\n• напомни в 15:30 позвонить";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(таймер|поставь таймер|заведи таймер)/i)) {
        const clean = text.replace(/^(таймер|поставь таймер|заведи таймер)\s+/i, "");
        const match = clean.match(/^(?:на|)\s*(\d+)\s*(минут[уы]?|мин|секунд[уы]?|сек|час[ао]?)\s*(.+)?/i);
        if (match) {
          const num = parseInt(match[1]), unit = match[2], label = (match[3] || "таймер").trim();
          const mul = { минут: 60, минуту: 60, минуты: 60, мин: 60, секунд: 1, секунду: 1, секунды: 1, сек: 1, час: 3600, часа: 3600, часов: 3600 };
          const sec = num * (mul[unit] || 60);
          const target = new Date(mskTime().getTime() + sec * 1000);
          if (!botMemory.reminders) botMemory.reminders = [];
          botMemory.reminders.push({ time: fromMSK(target).toISOString(), message: `Таймер сработал: ${label}`, chatId: defaultChatId, created: new Date().toISOString(), sound: "siren" });
          await saveMemory();
          reply = `Таймер на ${num} ${unit}. Сработает в ${target.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} (МСК)`;
        } else {
          reply = "Примеры:\n• таймер 5 минут\n• таймер на 30 минут обед\n• таймер 10 секунд";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(будильник|поставь будильник|заведи будильник|аларм)/i)) {
        const clean = text.replace(/^(будильник|поставь будильник|заведи будильник|аларм)\s+/i, "").replace(/каждый день|ежедневно|повторять/gi, "").trim();
        const match = clean.match(/(?:в|на)\s*(\d{1,2})[:.](\d{2})\s*(.+)?/i);
        const daily = /каждый день|ежедневно|повторять/i.test(text);
        if (match) {
          const h = parseInt(match[1]), m = parseInt(match[2]), label = (match[3] || "будильник").trim();
          const nowMSK = mskTime();
          let t = new Date(nowMSK.getFullYear(), nowMSK.getMonth(), nowMSK.getDate(), h, m, 0);
          if (t <= nowMSK) t.setDate(t.getDate() + 1);
          if (!botMemory.reminders) botMemory.reminders = [];
          botMemory.reminders.push({ time: fromMSK(t).toISOString(), message: `Будильник: ${label}`, chatId: defaultChatId, created: new Date().toISOString(), daily: daily, sound: "alien" });
          await saveMemory();
          reply = `Будильник на ${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} — «${label}»`;
          if (daily) reply += " (повтор каждый день)";
        } else {
          reply = "Примеры:\n• будильник на 7:30 подъём\n• будильник в 9:00 работа каждый день";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(мои напоминания|список напоминаний|покажи напоминания)/i)) {
        if (!botMemory.reminders?.length) {
          reply = "У тебя нет активных напоминаний.";
        } else {
          reply = "Твои напоминания:\n";
          botMemory.reminders.forEach((r, i) => {
            const t = mskTime(new Date(r.time));
            reply += `${i + 1}. ${t.toLocaleDateString("ru-RU")} ${t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} (МСК) — ${r.message}${r.daily ? " [ежедневно]" : ""}\n`;
          });
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(удали напоминание|убери напоминание|отмени напоминание)/i)) {
        const idx = parseInt(text.match(/\d+/)?.[0]);
        if (idx && idx > 0 && idx <= (botMemory.reminders?.length || 0)) {
          const r = botMemory.reminders.splice(idx - 1, 1)[0];
          await saveMemory();
          reply = `Удалено: «${r.message}»`;
        } else {
          reply = "Какое удалить? Напиши номер. Посмотри список: «мои напоминания»";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(погода|какая погода|прогноз погоды|weather)/i) || (text.includes("погод") && text.length < 80)) {
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        let city = text.replace(/.*погод[а-уё]*/i, "").replace(/[?.,!]/g, "").replace(/\s+(в|на|для|про|сейчас|сегодня|там|какая|какой|какое|как|скажи|мне|так|что|что там)\s+/gi, " ").trim();
        if (!city || city.length < 2) city = "Луганск";
        const knownLocations = {
          "рай-александровка": { name: "Рай-Александровка, ДНР", lat: 48.81, lon: 37.85 },
          "рай александровка": { name: "Рай-Александровка, ДНР", lat: 48.81, lon: 37.85 },
          "райалександровка": { name: "Рай-Александровка, ДНР", lat: 48.81, lon: 37.85 },
          "александровка днр": { name: "Александровка, ДНР", lat: 48.70, lon: 37.60 },
          "александровка": { name: "Александровка, ДНР", lat: 48.70, lon: 37.60 },
          "луганск": { name: "Луганск", lat: 48.57, lon: 39.31 },
        };
        const kl = knownLocations[city.toLowerCase()];
        if (kl) {
          reply = await fetchWeather(kl.lat, kl.lon, kl.name, YANDEX_WEATHER_KEY);
          await tg("sendMessage", { chat_id: chatId, text: reply });
          continue;
        }

      if (text.match(/^добавь\s+(?!в заметку|в обсидиан)(.+)/i)) {
        const item = text.replace(/^добавь\s+/i, "").trim();
        if (!botMemory.newItems) botMemory.newItems = [];
        botMemory.newItems.push({ item, date: new Date().toISOString() });
        await saveMemory();
        reply = `Добавила в «Что нового»: ${item}`;
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(что нового|список дел|что добавить|покажи список)/i)) {
        if (!botMemory.newItems?.length) {
          reply = "Список «Что нового» пуст. Скажи «добавь ...» чтобы внести.";
        } else {
          reply = "Что нового:\n";
          botMemory.newItems.forEach((n, i) => reply += `${i + 1}. ${n.item} (${new Date(n.date).toLocaleDateString("ru-RU")})\n`);
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^убери из нового\s+(\d+)/i)) {
        const idx = parseInt(text.match(/\d+/)[0]);
        if (idx > 0 && idx <= (botMemory.newItems?.length || 0)) {
          const removed = botMemory.newItems.splice(idx - 1, 1)[0];
          await saveMemory();
          reply = `Убрала: ${removed.item}`;
        } else { reply = "Какой номер убрать? «что нового» — покажет список."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }
        try {
          const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru`);
          const gd = await geo.json();
          if (!gd.results?.length) {
            reply = `Город "${city}" не найден.`;
          } else {
            const { name, latitude, longitude, country } = gd.results[0];
            reply = await fetchWeather(latitude, longitude, name + (country ? ", " + country : ""), YANDEX_WEATHER_KEY);
          }
        } catch (e) {
          reply = "Не удалось получить погоду. Попробуй позже.";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^добавь\s+(?!в заметку|в обсидиан)(.+)/i)) {
        const item = text.replace(/^добавь\s+/i, "").trim();
        if (!botMemory.newItems) botMemory.newItems = [];
        botMemory.newItems.push({ item, date: new Date().toISOString() });
        await saveMemory();
        reply = `Добавила в «Что нового»: ${item}`;
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(что нового|список дел|что добавить|покажи список)/i)) {
        if (!botMemory.newItems?.length) reply = "Список пуст. Скажи «добавь ...».";
        else { reply = "Список дел:\n"; botMemory.newItems.forEach((n,i)=>reply+=`${i+1}. ${n.item}\n`); }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^убери из нового\s+(\d+)/i)) {
        const idx = parseInt(text.match(/\d+/)[0]);
        if (idx>0&&idx<=(botMemory.newItems?.length||0)) { const r=botMemory.newItems.splice(idx-1,1)[0];await saveMemory();reply=`Убрала: ${r.item}`; }
        else reply="Какой номер? «что нового» покажет.";
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(добавь встречу|добавь событие|новая встреча|создай встречу)/i)) {
        const event = parseEvent(text);
        if (event) {
          if (!botMemory.events) botMemory.events = [];
          botMemory.events.push(event);
          botMemory.events.sort((a,b) => a.date.localeCompare(b.date));
          await saveMemory();
          const d = new Date(event.date);
          reply = `Встреча добавлена: ${d.toLocaleDateString("ru-RU")} в ${d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})} — «${event.description}»`;
        } else {
          reply = "Не поняла когда. Примеры:\n• добавь встречу завтра в 15:00 созвон\n• добавь встречу сегодня в 10:00 планёрка\n• добавь встречу 15.08 в 14:00 день рождения";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(какие планы|что сегодня|что завтра|что послезавтра|план на|календарь|мои встречи|мои события)/i)) {
        if (!botMemory.events?.length) {
          reply = "В календаре пока пусто. Скажи «добавь встречу ...» чтобы создать.";
        } else {
          let filterDate = "";
          if (text.match(/сегодня/i)) filterDate = mskTime().toISOString().slice(0,10);
          else if (text.match(/завтра/i)) filterDate = new Date(mskTime().getTime()+86400000).toISOString().slice(0,10);
          else if (text.match(/послезавтра/i)) filterDate = new Date(mskTime().getTime()+172800000).toISOString().slice(0,10);
          const filtered = filterDate ? botMemory.events.filter(e => e.date.startsWith(filterDate)) : botMemory.events;
          if (!filtered.length) { reply = `На ${filterDate||"ближайшее время"} встреч нет.`; }
          else {
            reply = filterDate ? `Встречи на ${filterDate}:\n` : "Все встречи:\n";
            filtered.forEach((e,i) => {
              const d = new Date(e.date);
              reply += `${i+1}. ${d.toLocaleDateString("ru-RU")} ${d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})} — ${e.description}\n`;
            });
          }
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(удали встречу|удали событие)\s*(\d+)/i)) {
        const idx = parseInt(text.match(/\d+/)[0]);
        if (idx > 0 && idx <= (botMemory.events?.length || 0)) {
          const removed = botMemory.events.splice(idx - 1, 1)[0];
          await saveMemory();
          reply = `Удалена встреча: «${removed.description}»`;
        } else { reply = "Какую встречу удалить? Напиши номер. «какие планы» покажет список."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(дашборд|dashboard|покажи расходы|отчёт по расходам|расходы за месяц|статистика расходов)/i)) {
        if (!botMemory.expenses?.length) { reply = "Расходов пока нет. Пришли фото с транзакциями и напиши «расходы»."; }
        else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          const byMonth = {};
          for (const e of botMemory.expenses) { const m = e.date.slice(0,7); if (!byMonth[m]) byMonth[m] = []; byMonth[m].push(e); }
          let dash = "# Дашборд расходов\n\n";
          for (const [m, items] of Object.entries(byMonth).sort().reverse()) {
            dash += `## ${m}\n`;
            dash += `| # | Описание | Дата |\n|---|---|---|\n`;
            items.forEach((e,i) => dash += `| ${i+1} | ${e.raw.slice(0,60)} | ${e.date} |\n`);
            dash += `\n*Всего: ${items.length} транзакций*\n\n`;
          }
          const dashPath = `Дашборды/расходы.md`;
          writeObsidianFile(dashPath, dash).catch(()=>{});
          reply = dash.slice(0, 3500) + `\n\n📊 Сохранено в Obsidian: ${dashPath}`;
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(проверь почту|почта|письма|что в почте)/i)) {
        if (!YANDEX_TOKEN) reply = "Яндекс не подключён.";
        else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          try {
            const mr = await fetch("https://api.mail.yandex.net/api/v1/messages?limit=5", { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` } });
            if (mr.ok) {
              const md = await mr.json();
              if (md.messages?.length) { reply = "Последние письма:\n"; for (const m of md.messages.slice(0, 5)) reply += `📧 ${m.subject || "Без темы"}\n`; }
              else reply = "Новых писем нет.";
            } else reply = "Не удалось проверить почту.";
          } catch { reply = "Ошибка доступа к почте."; }
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(сохрани на диск)\s+(.+)/i)) {
        if (!YANDEX_TOKEN) reply = "Яндекс не подключён.";
        else {
          const content = text.replace(/^сохрани на диск\s+/i, "");
          try {
            const uploadR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=Race/заметка-${Date.now()}.md&overwrite=true`, { headers: { Authorization: `OAuth ${YANDEX_TOKEN}` } });
            const uploadD = await uploadR.json();
            if (uploadD.href) { await fetch(uploadD.href, { method: "PUT", body: content }); reply = "Сохранено на Яндекс.Диск ✓"; }
            else reply = "Не удалось сохранить: " + (uploadD.message || "");
          } catch (e) { reply = "Ошибка Яндекс.Диска: " + e.message; }
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(удали заметку|удали файл|удали из обсидиан|удали страницу)\s+(.+)/i)) {
        const target = text.replace(/^(удали заметку|удали файл|удали из обсидиан|удали страницу)\s+/i, "").trim();
        if (!YANDEX_TOKEN) reply = "Яндекс.Диск не подключён.";
        else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          const found = await searchYandexDisk(target);
          if (found.includes("ничего не найдено")) reply = `Файл «${target}» не найден.`;
          else {
            const match = found.match(/📄\s+(\S+\.md)/);
            if (match) {
              try {
                const delR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent("Obsidian/" + match[1])}&permanently=true`, {
                  method: "DELETE", headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
                });
                reply = delR.ok || delR.status === 204 ? `Удалила: ${match[1]}` : "Не удалось удалить.";
              } catch { reply = "Ошибка удаления."; }
            } else reply = "Нашла несколько файлов. Уточни какой:\n" + found.slice(0, 500);
          }
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^переведи\s+(.+)/i)) {
        const rest = text.replace(/^переведи\s+/i, "");
        const langMatch = rest.match(/^(?:на\s+)?(английский|english|русский|russian|китайский|chinese|немецкий|german|испанский|spanish|французский|french|итальянский|italian)/i);
        if (langMatch) {
          const lang = langMatch[1].toLowerCase();
          const target = lang.match(/англ|english/i) ? "en" : lang.match(/кит|chinese/i) ? "zh" : lang.match(/нем|german/i) ? "de" : lang.match(/исп|spanish/i) ? "es" : lang.match(/фран|french/i) ? "fr" : lang.match(/итал|italian/i) ? "it" : "ru";
          const textToTranslate = rest.replace(langMatch[0], "").trim();
          if (textToTranslate) {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=` + encodeURIComponent(textToTranslate);
            try {
              const tr = await fetch(url);
              const td = await tr.json();
              reply = td[0]?.map(p => p[0]).join("") || "Не удалось перевести.";
            } catch { reply = "Ошибка перевода."; }
          } else { reply = "Что перевести? Пример: переведи на английский привет как дела"; }
        } else { reply = "На какой язык? Пример: переведи на английский привет"; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^заметка[:\s]+(.+)/i) || text.match(/^(?:заметка|note)[:\s]+(.+)/i)) {
        let note = text.replace(/^(?:заметка|note)[:\s]*/i, "").trim();
        // Извлекаем теги из текста: #тег
        const tags = note.match(/#(\w+)/g) || [];
        const tagStr = tags.length ? tags.join(" ") + "\n\n" : "";
        if (!botMemory.notes) botMemory.notes = [];
        const ts = new Date().toISOString().slice(0, 16).replace(/:/g, "-");
        const path = `Заметки/${ts}.md`;
        const content = `# Заметка\n\n${tagStr}${note}\n\n---\n*Создано: ${mskTime().toLocaleString("ru-RU")}*`;
        botMemory.notes.push({ path, content: note.slice(0, 500), time: new Date().toISOString() });
        await saveMemory();
        writeObsidianFile(path, content).catch(() => {});
        reply = "Заметка сохранена 💾 " + (tags.length ? "Теги: " + tags.join(", ") : "");
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/(?:повтор|каждый|еженедельн|ежемесячн|каждую неделю|каждый месяц|каждый день)/i) && text.match(/(?:добавь встречу|добавь событие|новая встреча|создай встречу)/i)) {
        const event = parseEvent(text);
        if (event) {
          if (text.match(/кажд(?:ый|ую)\s+(?:день|понедельник|вторник|сред|четверг|пятниц|суббот|воскресенье)/i)) {
            const daysMap = { понедельник: 1, вторник: 2, среда: 3, среду: 3, четверг: 4, пятница: 5, пятницу: 5, суббота: 6, субботу: 6, воскресенье: 0 };
            let targetDay = -1;
            for (const [k, v] of Object.entries(daysMap)) { if (text.toLowerCase().includes(k)) { targetDay = v; break; } }
            if (targetDay >= 0) {
              const d = new Date(event.date);
              while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
              event.date = d.toISOString();
              event.repeat = "weekly";
            }
            if (text.match(/каждый день/i)) event.repeat = "daily";
            if (text.match(/каждый месяц/i)) event.repeat = "monthly";
          }
          if (!botMemory.events) botMemory.events = [];
          botMemory.events.push(event);
          botMemory.events.sort((a,b) => a.date.localeCompare(b.date));
          await saveMemory();
          const d = new Date(event.date);
          reply = `Повторяющаяся встреча: ${d.toLocaleDateString("ru-RU")} в ${d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})} — «${event.description}»`;
        } else {
          reply = "Пример: добавь встречу каждый понедельник в 10:00 планёрка";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(\d+\.?\d*)\s*(юан[ейяь]?|cny|доллар[ов]?|usd|евро|eur|рубл[ейяь]?|rub)\s+в\s+(юан[ейяь]?|cny|доллар[ов]?|usd|евро|eur|рубл[ейяь]?|rub)/i)) {
        const match = text.match(/^(\d+\.?\d*)\s*(юан[ейяь]?|cny|доллар[ов]?|usd|евро|eur|рубл[ейяь]?|rub)\s+в\s+(юан[ейяь]?|cny|доллар[ов]?|usd|евро|eur|рубл[ейяь]?|rub)/i);
        const amount = parseFloat(match[1]);
        const currencyMap = { "юан": "CNY", "юани": "CNY", "юань": "CNY", "юаня": "CNY", "cny": "CNY", "доллар": "USD", "долларов": "USD", "доллара": "USD", "usd": "USD", "евро": "EUR", "eur": "EUR", "рубл": "RUB", "рубль": "RUB", "рубля": "RUB", "рублей": "RUB", "rub": "RUB" };
        const from = currencyMap[match[2].toLowerCase()] || match[2].toUpperCase();
        const to = currencyMap[match[3].toLowerCase()] || match[3].toUpperCase();
        try {
          const r = await fetch(`https://api.exchangerate.host/convert?from=${from}&to=${to}&amount=${amount}`, { signal: AbortSignal.timeout(8000) });
          const d = await r.json();
          if (d.result) reply = `${match[1]} ${from} = ${d.result.toFixed(2)} ${to}`;
          else reply = "Не удалось конвертировать.";
        } catch { reply = "Ошибка конвертации."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(новости|новость)\s+(.+)/i)) {
        const topic = text.replace(/^(новости|новость)\s+/i, "").trim();
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        reply = "Новости: «" + topic + "»\n\n" + await webSearch(topic + " новости 2026", 3);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(скинь фото|найди фото|покажи фото|найди картинку|покажи картинку)\s+(.+)/i)) {
        const query = text.replace(/^(скинь фото|найди фото|покажи фото|найди картинку|покажи картинку)\s+/i, "").trim();
        await tg("sendChatAction", { chat_id: chatId, action: "upload_photo" });
        try {
          if (TAVILY_KEY) {
            const r = await fetch("https://api.tavily.com/search", {
              method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
              body: JSON.stringify({ query, search_depth: "basic", max_results: 3, include_images: true, include_image_descriptions: true }),
            });
            const d = await r.json();
            if (d.images?.length) {
              await tg("sendPhoto", { chat_id: chatId, photo: d.images[0].url || d.images[0], caption: "«" + query + "»" });
              reply = "Вот что нашла ⬆";
              if (d.images.length > 1) reply += "\nЕщё: " + d.images.slice(1, 4).map(i => i.url).join("\n");
            } else reply = `Фото «${query}» не найдено.`;
          } else reply = "Поиск фото не настроен.";
        } catch { reply = "Ошибка поиска."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^сколько\s+от\s+(.+?)\s+до\s+(.+)/i)) {
        const match = text.match(/^сколько\s+от\s+(.+?)\s+до\s+(.+)/i);
        const from = match[1].trim(), to = match[2].trim();
        try {
          const geo1 = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(from)}&count=1`);
          const geo2 = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(to)}&count=1`);
          const g1 = await geo1.json(), g2 = await geo2.json();
          if (g1.results?.[0] && g2.results?.[0]) {
            const lat1 = g1.results[0].latitude, lon1 = g1.results[0].longitude;
            const lat2 = g2.results[0].latitude, lon2 = g2.results[0].longitude;
            const R = 6371;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
            const dist = Math.round(2 * R * Math.asin(Math.sqrt(a)));
            reply = `Расстояние от ${from} до ${to}: ~${dist} км (по прямой)`;
          } else { reply = "Не нашла один из городов."; }
        } catch { reply = "Ошибка расчёта."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      // Трекер привычек
      if (text.match(/^я\s+(сделал|сходил|пробежал|прочитал|позанимался|помедитировал)\s+(.+)/i)) {
        if (!botMemory.habits) botMemory.habits = {};
        const habit = text.replace(/^я\s+(сделал|сходил|пробежал|прочитал|позанимался|помедитировал)\s+/i, "").trim();
        botMemory.habits[habit] = (botMemory.habits[habit] || 0) + 1;
        await saveMemory();
        const streak = botMemory.habits[habit];
        reply = `Отлично! «${habit}» — ${streak} раз${streak===1?"":"а"}! Так держать!`;
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }
      if (text.match(/^(мой прогресс|мои привычки|статистика привычек)/i)) {
        if (!botMemory.habits || !Object.keys(botMemory.habits).length) {
          reply = "Пока нет привычек. Скажи «я сделал зарядку» чтобы начать.";
        } else {
          reply = "Твои привычки:\n";
          for (const [k, v] of Object.entries(botMemory.habits).sort((a,b) => b[1]-a[1])) reply += `${k}: ${v} раз\n`;
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      // Список покупок
      if (text.match(/^добавь в покупки\s+(.+)/i)) {
        if (!botMemory.shopping) botMemory.shopping = [];
        botMemory.shopping.push(text.replace(/^добавь в покупки\s+/i, "").trim());
        await saveMemory();
        reply = "Добавлено в покупки: " + botMemory.shopping[botMemory.shopping.length-1];
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }
      if (text.match(/^(список покупок|что в покупках|покупки)/i)) {
        if (!botMemory.shopping?.length) reply = "Список покупок пуст.";
        else reply = "Список покупок:\n" + botMemory.shopping.map((s,i) => `${i+1}. ${s}`).join("\n");
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }
      if (text.match(/^убери из покупок\s+(\d+)/i)) {
        const idx = parseInt(text.match(/\d+/)[0]);
        if (idx > 0 && idx <= (botMemory.shopping?.length || 0)) {
          const removed = botMemory.shopping.splice(idx-1,1)[0];
          await saveMemory();
          reply = "Убрано: " + removed;
        } else { reply = "Какой номер? Посмотри «список покупок»."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      // Случайный факт
      if (text.match(/^(расскажи что-то интересное|случайный факт|интересный факт|что-нибудь интересное)/i)) {
        const facts = [
          "Осьминоги имеют три сердца, и их кровь голубого цвета.",
          "Самый большой организм на Земле — грибница опёнка в Орегоне, занимающая 9,6 км².",
          "Коалы спят до 22 часов в сутки.",
          "Молния нагревает воздух до 30 000°C — это в 5 раз горячее поверхности Солнца.",
          "Бананы радиоактивны из-за содержания калия-40.",
          "Человеческий нос может различать более триллиона запахов.",
          "В космосе нельзя плакать: слёзы не текут, а собираются в шарики.",
          "Каждый день на Землю падает около 100 тонн космической пыли.",
          "В Японии есть остров кроликов — Окуносима, где живут сотни диких кроликов.",
          "Шансы погибнуть от падения кокоса выше, чем от нападения акулы — по статистике."
        ];
        reply = facts[Math.floor(Math.random() * facts.length)];
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/(?:обсидиан|obsidian|заметк| vault|что у тебя есть|что ты знаешь|поищи в заметк|поищи в памяти|посмотри в заметк|что в заметк|какие заметк|мои заметк|в обсидиане|память|что ты помнишь|что в памяти|истори|диалог|о чём мы говорили)/i)) {
        await saveMemory();
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        const q = text.replace(/(?:обсидиан|obsidian|заметк| vault|что у тебя есть|что ты знаешь|поищи в заметк|посмотри в заметк|что в заметк|какие заметк|мои заметк|в обсидиане|по обсидиану)/gi, "").trim();
        let result = q && q.length > 1 ? await searchObsidian(q) : await listObsidianNotes();
        // Если обычный поиск не нашёл — пробуем AI поиск
        if (result.includes("ничего не найдено") && q.length > 3) {
          const aiResult = await aiSearchDialogues(q);
          if (aiResult) result = aiResult;
        }
        await tg("sendMessage", { chat_id: chatId, text: result });
        continue;
      }

      // Дата-запросы: "вчера", "сегодня", "позавчера"
      if (text.match(/^(?:вчера|сегодня|позавчера|что было)/i) || (text.match(/(?:вчера|сегодня|позавчера)/i) && text.length < 40)) {
        const now = mskTime();
        let targetDate = now.toISOString().slice(0, 10);
        if (text.match(/вчера/i)) targetDate = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
        else if (text.match(/позавчера/i)) targetDate = new Date(now.getTime() - 172800000).toISOString().slice(0, 10);
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        // Читаем диалоги из Яндекс.Диска
        try {
          const path = `Obsidian/Диалоги/${targetDate}.md`;
          const downloadR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(path)}`, {
            headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
          });
          if (downloadR.ok) {
            const dd = await downloadR.json();
            if (dd.href) {
              const fileR = await fetch(dd.href);
              if (fileR.ok) {
                const content = await fileR.text();
                reply = `Диалоги за ${targetDate}:\n\n${content.slice(0, 3500)}`;
                if (content.length > 3500) reply += `\n\n...показано 3500 из ${content.length} символов`;
              }
            }
          } else {
            reply = `За ${targetDate} диалогов не найдено.`;
          }
        } catch { reply = "Не удалось загрузить диалоги."; }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/(?:курс|валют|юан|доллар|евро|рубл|cny|usd|eur|rub)\s+(?:к |в |на |по |)/i) && text.length < 120) {
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        reply = await getExchangeRates(text);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/^(найди в интернете|поищи|search|найди товар|найди где купить|найди цену|поиск товара)/i)) {
        const query = text.replace(/^(найди в интернете|поищи|search|найди товар|найди где купить|найди цену|поиск товара)\s*/i, "").trim();
        if (!query) { reply = "Что искать? Пример: найди в интернете DJI Mavic 3 цена"; }
        else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          reply = await webSearch(query);
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.startsWith("/vault list")) {
        reply = "Облачное хранилище:\n📝 Заметки: " + (botMemory.notes?.length || 0) + "\n💰 Расходы: " + (botMemory.expenses?.length || 0) + "\n📋 Новое: " + (botMemory.newItems?.length || 0) + "\n🧠 Факты: " + (botMemory.facts?.length || 0);
      } else if (text.startsWith("/vault read")) {
        const t = text.slice(12).trim();
        if (t.match(/расход/i)) reply = (botMemory.expenses || []).map(e => e.raw).join("\n") || "Нет";
        else if (t.match(/нов|new/i)) reply = (botMemory.newItems || []).map(n => n.item).join("\n") || "Нет";
        else if (t.match(/замет|note/i)) reply = (botMemory.notes || []).map(n => n.content.slice(0, 200)).join("\n\n") || "Нет";
        else if (t.match(/факт/i)) reply = (botMemory.facts || []).join("\n") || "Нет";
        else if (t.endsWith(".md")) { await tg("sendChatAction", { chat_id: chatId, action: "typing" }); reply = await readObsidianFile(t); }
        else reply = "Что прочитать: расходы / новое / заметки / факты / путь-к-файлу.md";
      } else if (text.startsWith("/vault search")) {
        const q = text.slice(14).trim().toLowerCase();
        if (!q) { reply = "Что искать?"; }
        else {
          const r = [];
          for (const n of (botMemory.notes || [])) if (n.content.toLowerCase().includes(q)) r.push(n.path);
          for (const f of (botMemory.facts || [])) if (f.toLowerCase().includes(q)) r.push("Факт: "+f);
          reply = r.length ? r.slice(0, 10).join("\n") : "Не найдено.";
        }
      } else if (text.startsWith("/vault write")) {
        const t = text.slice(13).trim();
        if (!t) { reply = "Что записать?"; }
        else { if (!botMemory.facts) botMemory.facts = []; botMemory.facts.push(t); await saveMemory(); reply = "Записано: "+t; }
      } else if (text.startsWith("/vault")) {
        reply = `/vault list — облачное хранилище\n/vault read — прочитать\n/vault search — поиск\n/vault write — записать`;
      } else if (false && text.match(/(?:найди|поищи|артикул|озон|ozon|wb|wildberries|что за товар)/i)) {
        const marketplace = text.match(/озон|ozon/i) ? "site:ozon.ru" : text.match(/wb|wildberries/i) ? "site:wildberries.ru" : "";
        const ocrText = await analyzePhoto(null, "На этом фото товар. Внимательно рассмотри и выведи: артикул, штрихкод, название бренда, модель. Только данные, без лишних слов.", 300, true);
        const searchQuery = ocrText.replace(/[^\w\sа-яё\-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 100) || text.replace(/(найди|поищи|артикул|озон|ozon|wb|wildberries|на |по )/gi, "").trim();
        reply = `Распознано: «${ocrText.slice(0, 200)}»\n\n`;
        reply += await webSearch(`${searchQuery} ${marketplace}`);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      } else if (text.match(/(?:расход|трат|финанс|бюджет|отч[её]т|анализ расход)/i)) {
        if (false) {
          const expenseText = await analyzePhoto(null, "На этом фото список транзакций или расходов. Внимательно прочитай ВСЕ строки: дату, описание, сумму. Выведи в формате: дата | описание | сумма. Каждую транзакцию с новой строки.", 1500, true);
          if (!botMemory.expenses) botMemory.expenses = [];
          const lines = expenseText.split("\n").filter(l => l.match(/\d/));
          for (const line of lines) {
            botMemory.expenses.push({ raw: line.trim(), date: new Date().toISOString().slice(0, 10), time: new Date().toISOString() });
          }
          await saveMemory();
          reply = `Распознала расходы (${lines.length} транзакций):\n${expenseText.slice(0, 1500)}\n\nСохранено в облако. Для отчёта скажи «покажи отчёт за месяц».`;
        } else if (text.match(/покажи отч[её]т|собери отч[её]т|отч[её]т за месяц/i)) {
          if (!botMemory.expenses?.length) {
            reply = "Нет сохранённых расходов. Пришли фото с транзакциями и напиши «расходы».";
          } else {
            const byMonth = {};
            for (const e of botMemory.expenses) {
              const m = e.date.slice(0, 7);
              if (!byMonth[m]) byMonth[m] = [];
              byMonth[m].push(e);
            }
            reply = "Отчёт по расходам:\n\n";
            for (const [month, items] of Object.entries(byMonth).sort().reverse()) {
              reply += `${month}:\n`;
              for (const item of items) reply += `  ${item.raw}\n`;
              reply += "\n";
            }
            reply += "\nЧтобы добавить расходы — пришли фото с транзакциями.";
          }
        } else {
          reply = "Для работы с расходами:\n• Пришли фото транзакций\n• Напиши «расходы» чтобы распознать\n• «покажи отчёт за месяц» — сводка";
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      } else if (false && text.match(/^(прочитай|читай|распознай|ocr|опиши|что на фото|что изображено)/i)) {
        reply = await analyzePhoto(null, text, 500);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      } else if (false && text.length < 120 && !text.startsWith("/")) {
        reply = await analyzePhoto(null, text, 800);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      } else if (text.startsWith("/vault read")) {
        const sub = text.slice(12).trim();
        reply = readVault(sub);
      } else if (text.startsWith("/vault search")) {
        const term = text.slice(14).trim();
        if (!term) { reply = "Укажи текст для поиска."; }
        else { await tg("sendChatAction", { chat_id: chatId, action: "typing" }); reply = searchVault(term); }
      } else if (text.startsWith("/vault write")) {
        const sub = text.slice(13).trim();
        if (!sub || !sub.endsWith(".md")) { reply = "Укажи путь к .md файлу. Пример:\n/vault write ИИ общее/заметка.md\nЗатем отправь содержимое."; }
        else { writeQueue.set(userId, sub); reply = `Жду содержимое для: ${sub}\nОтправь текст следующим сообщением.`; }
      } else if (text.startsWith("/vault")) {
        reply = `Поиск Obsidian:\n📁 Показать всё — /vault list\n📄 Прочитать — /vault read путь\n🔍 Поиск — /vault search текст\n✏ Записать — /vault write путь`;
      } else if (text.match(/^поиск\s+(obsidian|обсидиан)/i)) {
        reply = `Поиск Obsidian:\n/vault list — папки и файлы\n/vault list Мавики — содержимое папки\n/vault read путь/к/файлу.md — прочитать\n/vault search текст — найти в заметках\n/vault write путь — записать`;
      } else {
        const intent = detectIntent(text);

        if (intent.intent === "research") {
          let topic = intent.topic.replace(/^(найди информацию про|найди инфу про|расскажи подробно про|собери информацию|подготовь обзор|напиши доклад|расскажи про|найди информацию|найди инфу|найди|поищи|узнай про|узнай|что такое|исследуй|кто такой|ищи|поиск|подробно про)\s*/i, "").trim();
          if (!topic || topic.length < 3) {
            reply = await deepseekChat(userId, text);
          } else {
            await tg("sendMessage", { chat_id: chatId, text: `Ищу: "${topic}"...` });
            reply = await researchAndSave(chatId, userId, topic);
            log(`-> ${reply.slice(0, 80)}`);
            const chunks = splitMessage(reply);
            for (const chunk of chunks) await tg("sendMessage", { chat_id: chatId, text: chunk });
            continue;
          }
        } else if (intent.intent === "write") {
          const content = intent.content;
          if (!content || content.length < 5) {
            reply = "Что добавить и в какую заметку? Скажи, например: «запиши в Мавики/модели Mavic 3 цена 200 000 рублей»";
          } else {
            const match = content.match(/^(.+?\.md)\s+(.+)$/i);
            if (match) {
              const path = match[1];
              const note = match[2];
              reply = writeVault(path, note);
            } else {
              reply = "Уточни путь к заметке. Пример: «запиши в Мавики/модели.md новый текст»";
            }
          }
        } else if (intent.intent === "read") {
          const clean = intent.text.replace(/^(покажи заметку|прочитай|открой заметку|что в заметке|покажи файл)\s*/i, "").trim();
          if (clean) {
            reply = readVault(clean);
          } else {
            reply = "Какую заметку показать?";
          }
        } else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          reply = await deepseekChat(userId, text);
        }
      }

      log(`-> ${reply.slice(0, 80)}`);
      const chunks = splitMessage(reply);
      for (const chunk of chunks) {
        await tg("sendMessage", { chat_id: chatId, text: chunk });
      }

      botMemory.dialogues.push({ time: mskTime().toISOString(), user: text.slice(0, 500), bot: reply.slice(0, 500) });
      dialogueCounter++;

      if (text.match(/(?:нет|не так|неправильно|ошибк|не верно|неверно|исправь|поправь)/i) && text.length > 10) {
        if (!botMemory.learnings) botMemory.learnings = [];
        botMemory.learnings.push({ time: new Date().toISOString(), correction: text.slice(0, 300), context: reply.slice(0, 200) });
        if (botMemory.learnings.length > 50) botMemory.learnings = botMemory.learnings.slice(-50);
      }

      // сохраняем диалог в Obsidian через GitHub API (в фоне, не ждём)
      const today = new Date().toISOString().slice(0, 10);
      const dialEntry = `\n\n**${new Date().toLocaleTimeString("ru-RU")}**\n> ${text.slice(0, 500)}\n\n${reply.slice(0, 500)}\n---`;
      const saveDialogue = async () => {
        try {
          const path = `Obsidian/Диалоги/${today}.md`;
          // Читаем существующий
          let existing = "# Диалоги\n";
          try {
            const readR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(path)}`, {
              headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
            });
            if (readR.ok) {
              const rd = await readR.json();
              if (rd.href) {
                const fileR = await fetch(rd.href);
                if (fileR.ok) existing = await fileR.text();
              }
            }
          } catch {}
          // Записываем
          const newContent = existing + dialEntry;
          const uploadR = await fetch(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(path)}&overwrite=true`, {
            headers: { Authorization: `OAuth ${YANDEX_TOKEN}` },
          });
          const uploadD = await uploadR.json();
          if (uploadD.href) {
            await fetch(uploadD.href, { method: "PUT", body: newContent });
          }
        } catch (e) { log("Ошибка сохранения диалога: " + e.message); }
      };
      saveDialogue().catch(e => log("Ошибка сохранения: " + e.message)); // фоном, с логом ошибок

      await saveMemory(); // сохраняем каждый диалог

      if (voiceRequested || voicePref.get(userId)) {
        const ttsText = reply.slice(0, 800);
        const voice = botMemory.prefs?.voice || "nova";
        await tg("sendChatAction", { chat_id: chatId, action: "record_voice" });
        let voiceBuf = await textToVoice(ttsText, voice);
        if (!voiceBuf && TTS_PROVIDER === "openai") {
          voiceBuf = await textToVoice(ttsText, "google");
          if (voiceBuf) log("-> голос (Google fallback)");
        }
        if (voiceBuf) {
          const form = new FormData();
          form.append("voice", new Blob([voiceBuf], { type: "audio/mpeg" }), "reply.mp3");
          await fetch(`${TG_API}/sendVoice?chat_id=${chatId}`, { method: "POST", body: form });
          log("-> голосовой ответ (" + voice + ")");
        } else {
          log("-> TTS не сработал");
        }
      }
    }

    if (offset === -1 && data.result && data.result.length > 0) {
      offset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch (err) {
    log("Poll error: " + (err.message || err), err);
    await delay(3000);
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function splitMessage(text) {
  if (text.length <= 4000) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let cut = 4000;
    const nl = remaining.lastIndexOf("\n", 4000);
    if (nl > 3000) cut = nl;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

log("Бот запущен. deepseek-v4-pro + Supabase");

// HTTP-сервер для Render (health check)
createServer((req, res) => { res.writeHead(200); res.end("OK"); }).listen(process.env.PORT || 3000);

async function main() {
  await loadMemory();
  while (true) { await poll(); }
}

main().catch((e) => {
  log("FATAL: " + (e.message || e), e);
  process.exit(1);
});
