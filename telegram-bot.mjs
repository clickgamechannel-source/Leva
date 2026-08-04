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
const YANDEX_WEATHER_KEY = process.env.YANDEX_WEATHER_KEY || config.yandexWeatherKey || "";
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || config.pushoverToken || "";
const PUSHOVER_USER = process.env.PUSHOVER_USER || config.pushoverUser || "";
const BRAVE_SEARCH_KEY = process.env.BRAVE_SEARCH_KEY || config.braveSearchKey || "";
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || config.obsidianVault || "D:/OBSIDIAN/Leva";
const OBSIDIAN_REPO = process.env.OBSIDIAN_REPO || config.obsidianRepo || "clickgamechannel-source/Leva";

if (!TELEGRAM_TOKEN) { log("TELEGRAM_TOKEN не задан."); process.exit(1); }
if (!DEEPSEEK_KEY) { log("DEEPSEEK_API_KEY не задан."); process.exit(1); }

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DS_API = "https://api.deepseek.com/chat/completions";
const context = new Map();
const pendingResearch = new Map();
const voicePref = new Map();
const lastPhoto = new Map();
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

if (!useWebhook) {
  const del = await fetch(`${TG_API}/deleteWebhook?drop_pending_updates=true`);
  const d = await del.json();
  log("Webhook сброшен. long polling");
  offset = -1;
} else {
  log("Webhook обнаружен: " + webhookInfo.result.url);
  offset = -1;
  const dup = await fetch(`${TG_API}/getUpdates?limit=1`);
  const dp = await dup.json();
  if (dp.result && dp.result.length > 0) {
    offset = dp.result[dp.result.length - 1].update_id + 1;
    log("пропущены старые обновления до offset=" + offset);
  }
}

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
  if (!GITHUB_KEY) return "Obsidian Git не настроен.";
  try {
    let sha = null;
    try {
      const gr = await fetch(`https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encodeURIComponent(sub)}`, {
        headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (gr.ok) { const gd = await gr.json(); sha = gd.sha; }
    } catch {}
    const body = { message: "Race: " + sub, content: Buffer.from(content).toString("base64") };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encodeURIComponent(sub)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    return d.content ? `Записано: ${sub}` : "Ошибка: " + (d.message || "");
  } catch (e) { return "Ошибка: " + e.message; }
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

async function deepseekChat(userId, text, vaultContext) {
  if (!context.has(userId)) context.set(userId, []);
  const messages = context.get(userId);

  let userMsg = text;
  const vaultCtx = notesSearch(text) || memoryContext();
  if (vaultCtx) userMsg = `${text}\n\n[${vaultCtx}\n]`;

  messages.push({ role: "user", content: userMsg });

  const system = `Ты — Race, дружелюбная девушка-ассистент. Отвечай кратко, естественно, не повторяйся. Если не можешь помочь — предложи 2-3 варианта решения.

Сейчас: ${mskTime().toLocaleString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })} МСК.`;

  const res = await fetch(DS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "system", content: system }, ...messages.slice(-24)],
      max_tokens: 2000,
    }),
  });

  const data = await res.json();
  let reply = data.choices?.[0]?.message?.content;
  if (!reply) reply = data.choices?.[0]?.message?.reasoning_content;
  if (!reply) reply = "Ошибка ответа от DeepSeek.";
  messages.push({ role: "assistant", content: reply });
  if (messages.length > 50) context.set(userId, messages.slice(-50));
  return reply;
}

const writeQueue = new Map();

async function webSearch(query) {
  if (!BRAVE_SEARCH_KEY) return "Поиск не настроен. Нужен Brave Search API ключ.";
  try {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&search_lang=ru`, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_SEARCH_KEY },
    });
    const d = await r.json();
    if (!d.web?.results?.length) return `По запросу «${query}» ничего не найдено.\n\nЧто можно попробовать:\n• Упрости запрос (меньше слов)\n• Поищи на конкретном сайте: «найди site:ozon.ru товар»\n• Используй другие ключевые слова\n• Пришли фото товара — я распознаю и найду`;
    let reply = `Результаты поиска: «${query}»\n\n`;
    d.web.results.forEach((r, i) => {
      reply += `${i + 1}. ${r.title}\n${r.description?.slice(0, 150) || ""}\n${r.url}\n\n`;
    });
    return reply.slice(0, 3800);
  } catch (e) { return "Ошибка поиска: " + e.message; }
}

async function getExchangeRates(text) {
  const now = mskTime();
  let reply = `Курсы валют на ${now.toLocaleDateString("ru-RU")}:\n\n`;
  try {
    // Try exchangerate.host free API
    const r = await fetch("https://api.exchangerate.host/live?base=RUB&source=ecb&places=2", { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      if (d.success && d.rates) {
        const cny = (1 / d.rates.CNY).toFixed(2);
        const usd = (1 / d.rates.USD).toFixed(2);
        const eur = (1 / d.rates.EUR).toFixed(2);
        reply += `CNY/RUB: 1 ¥ = ${cny} ₽\n`;
        reply += `USD/RUB: 1 $ = ${usd} ₽\n`;
        reply += `EUR/RUB: 1 € = ${eur} ₽\n`;
        reply += `\nИсточник: exchangerate.host (ЕЦБ)`;
        return reply;
      }
    }
  } catch {}
  // Fallback: search via Brave
  try {
    const searchR = await fetch(`https://api.search.brave.com/res/v1/web/search?q=курс+юаня+к+рублю+сегодня+ЦБ+РФ&count=3&search_lang=ru`, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_SEARCH_KEY },
    });
    const sd = await searchR.json();
    if (sd.web?.results?.length) {
      reply += "Данные из поиска:\n";
      sd.web.results.forEach((r, i) => reply += `${r.title}: ${r.description?.slice(0, 100) || ""}\n${r.url}\n`);
      return reply;
    }
  } catch {}
  return reply + "Не удалось получить курсы. Попробуй позже.";
}

async function analyzePhoto(photoBase64, prompt, maxTokens = 500, highDetail = false) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", max_tokens: maxTokens,
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

async function fetchWeather(lat, lon, name, yandexKey) {
  try {
    if (yandexKey) {
      const r = await fetch(`https://api.weather.yandex.ru/v2/forecast?lat=${lat}&lon=${lon}&lang=ru_RU&limit=1&hours=false`, { headers: { "X-Yandex-Weather-Key": yandexKey }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d = await r.json();
        const f = d.fact;
        const cond = yandexWeatherMap[f.condition] || f.condition;
        const dirMap = { "nw": "СЗ", "n": "С", "ne": "СВ", "e": "В", "se": "ЮВ", "s": "Ю", "sw": "ЮЗ", "w": "З", "c": "Штиль" };
        let reply = `Погода в ${name} (Яндекс):\n\n${weatherEmoji[f.condition] || "🌡"} Сейчас: ${cond}, ${f.temp}°C (ощущается ${f.feels_like}°C)\n💨 Ветер: ${dirMap[f.wind_dir] || f.wind_dir} ${f.wind_speed} м/с\n💧 Влажность: ${f.humidity}%\n📊 Давление: ${f.pressure_mm} мм\n\n`;
        const periodNames = { morning: "Утро", day: "День", evening: "Вечер", night: "Ночь" };
        for (const day of (d.forecasts || []).slice(0, 1)) {
          reply += `${day.date}:\n`;
          for (const part of ["morning", "day", "evening", "night"]) {
            const p = day.parts?.[part];
            if (p) {
              reply += `${periodEmoji[part] || ""} ${periodNames[part]}: ${weatherEmoji[p.condition] || ""} ${yandexWeatherMap[p.condition] || "—"}, ${p.temp_min}–${p.temp_max}°C, 💨 ${dirMap[p.wind_dir] || p.wind_dir} ${p.wind_speed} м/с\n`;
            }
          }
        }
        return reply;
      }
    }
  } catch {}
  // Open-Meteo fallback
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant&timezone=auto&forecast_days=3`);
  const wd = await w.json();
  const c = wd.current;
  let reply = `Погода в ${name}:\n\nСейчас: ${weatherMap[c.weather_code] || "—"}, ${c.temperature_2m}°C (ощущается ${c.apparent_temperature}°C)\nВетер: ${c.wind_speed_10m} м/с\nВлажность: ${c.relative_humidity_2m}%\n\nПрогноз:\n`;
  for (let i = 0; i < Math.min(3, wd.daily.time.length); i++) {
    reply += `${wd.daily.time[i]}: ${wd.daily.temperature_2m_min[i]}°C / ${wd.daily.temperature_2m_max[i]}°C, осадки ${wd.daily.precipitation_probability_max[i]}%, ветер ${wd.daily.wind_speed_10m_max[i]} м/с\n`;
  }
  return reply;
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
    const blob = new Blob([audioBuffer], { type: "audio/ogg" });
    form.append("file", blob, "voice.ogg");
    form.append("model", "whisper-1");
    form.append("language", "ru");

    // пробуем OpenAI, если ключ есть
    if (OPENAI_KEY) {
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
        body: form,
      });
      if (r.ok) {
        const d = await r.json();
        return d.text || null;
      }
    }

    // fallback на Groq
    if (GROQ_KEY) {
      const form2 = new FormData();
      const blob2 = new Blob([audioBuffer], { type: "audio/ogg" });
      form2.append("file", blob2, "voice.ogg");
      form2.append("model", "whisper-large-v3");
      form2.append("language", "ru");
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: form2,
      });
      if (r.ok) {
        const d = await r.json();
        return d.text || null;
      }
    }
    return null;
  } catch (e) {
    log("STT error: " + e.message);
    return null;
  }
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

let botMemory = { facts: [], prefs: { bot_name: "Race", bot_gender: "female", voice: "nova", timezone: 3 }, dialogues: [], reminders: [], learnings: [] };
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
  if (!GITHUB_KEY || !GIST_ID) return;
  try {
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    const d = await r.json();
    const content = d.files?.["memory.json"]?.content;
    if (content) {
      const loaded = JSON.parse(content);
      botMemory.facts = loaded.facts || [];
      botMemory.prefs = loaded.prefs || { bot_name: "Race", bot_gender: "female", voice: "nova" };
      botMemory.reminders = loaded.reminders || [];
      botMemory.learnings = loaded.learnings || [];
      botMemory.notes = loaded.notes || [];
      botMemory.expenses = loaded.expenses || [];
      botMemory.newItems = loaded.newItems || [];
    }
    log("Память загружена: " + (botMemory.facts?.length || 0) + " фактов, " + (botMemory.notes?.length || 0) + " заметок");
  } catch (e) {
    log("Ошибка загрузки памяти: " + e.message);
  }
}

async function saveMemory() {
  if (!GITHUB_KEY || !GIST_ID) return;
  try {
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ files: { "memory.json": { content: JSON.stringify(botMemory, null, 2) } } }),
    });
    if (r.ok) log("Память сохранена");
    else log("Ошибка сохранения: " + r.status);
  } catch (e) {
    log("Ошибка сохранения памяти: " + e.message);
  }
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
        lastPhoto.set(userId, photoBase64);

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
          const marketplace = caption.match(/озон|ozon/i) ? "site:ozon.ru" : caption.match(/wb|wildberries/i) ? "site:wildberries.ru" : "";
          const ocrText = await analyzePhoto(photoBase64, "На этом фото товар. Внимательно рассмотри и выведи: артикул, штрихкод, название бренда, модель, любые цифры и буквы которые могут быть артикулом. Без лишних слов — только данные.", 300, true);
          const searchQuery = ocrText.replace(/[^\w\sа-яё\-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 100) || caption.replace(/(найди|поищи|артикул|озон|ozon|wb|wildberries|на |по )/gi, "").trim();
          reply = `Распознано: «${ocrText.slice(0, 200)}»\n\n`;
          if (marketplace) {
            reply += await webSearch(`${searchQuery} ${marketplace}`);
          } else {
            reply += await webSearch(searchQuery);
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

      if (text.match(/^(напомни|о чём мы говорили|поищи в истории)/i)) {
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

      if (text === "/weather" || text === "погода") {
        reply = await fetchWeather(48.77, 37.62, "Рай-Александровка, ДНР", YANDEX_WEATHER_KEY);
        await tg("sendMessage", { chat_id: chatId, text: reply });
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
        let city = text.replace(/^(погода|какая погода|прогноз погоды|weather)\s*/i, "").trim();
        if (!city || city.length < 2) city = "Луганск";
        const knownLocations = {
          "рай-александровка": { name: "Рай-Александровка, ДНР", lat: 48.77, lon: 37.62 },
          "рай александровка": { name: "Рай-Александровка, ДНР", lat: 48.77, lon: 37.62 },
          "райалександровка": { name: "Рай-Александровка, ДНР", lat: 48.77, lon: 37.62 },
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

      if (text.match(/^(найди в интернете|поищи|search|найди товар|найди где купить|найди цену|поиск товара)/i)) {
        const query = text.replace(/^(найди в интернете|поищи|search|найди товар|найди где купить|найди цену|поиск товара)\s*/i, "").trim();
        if (!query) { reply = "Что искать? Пример: найди в интернете DJI Mavic 3 цена"; }
        else {
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          reply = await webSearch(query);
          addToContext(userId, text, reply);
        }
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      }

      if (text.match(/(?:курс|валют|юан|доллар|евро|рубл|cny|usd|eur|rub)/i) && text.length < 120) {
        await tg("sendChatAction", { chat_id: chatId, action: "typing" });
        reply = await getExchangeRates(text);
        addToContext(userId, text, reply);
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
        const editResult = await editAndSendPhoto(chatId, lastPhoto.get(userId), text);
        if (editResult !== "Обработано") await tg("sendMessage", { chat_id: chatId, text: editResult });
        continue;
      } else if (lastPhoto.has(userId) && text.match(/(?:найди|поищи|артикул|озон|ozon|wb|wildberries|что за товар)/i)) {
        const marketplace = text.match(/озон|ozon/i) ? "site:ozon.ru" : text.match(/wb|wildberries/i) ? "site:wildberries.ru" : "";
        const ocrText = await analyzePhoto(lastPhoto.get(userId), "На этом фото товар. Внимательно рассмотри и выведи: артикул, штрихкод, название бренда, модель. Только данные, без лишних слов.", 300, true);
        const searchQuery = ocrText.replace(/[^\w\sа-яё\-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 100) || text.replace(/(найди|поищи|артикул|озон|ozon|wb|wildberries|на |по )/gi, "").trim();
        reply = `Распознано: «${ocrText.slice(0, 200)}»\n\n`;
        reply += await webSearch(`${searchQuery} ${marketplace}`);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      } else if (text.match(/(?:расход|трат|финанс|бюджет|отч[её]т|анализ расход)/i)) {
        if (lastPhoto.has(userId)) {
          const expenseText = await analyzePhoto(lastPhoto.get(userId), "На этом фото список транзакций или расходов. Внимательно прочитай ВСЕ строки: дату, описание, сумму. Выведи в формате: дата | описание | сумма. Каждую транзакцию с новой строки.", 1500, true);
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
      } else if (lastPhoto.has(userId) && text.match(/^(прочитай|читай|распознай|ocr|опиши|что на фото|что изображено)/i)) {
        reply = await analyzePhoto(lastPhoto.get(userId), text, 500);
        await tg("sendMessage", { chat_id: chatId, text: reply });
        continue;
      } else if (lastPhoto.has(userId) && text.length < 120 && !text.startsWith("/")) {
        reply = await analyzePhoto(lastPhoto.get(userId), text, 800);
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

      botMemory.dialogues.push({ time: new Date().toISOString(), user: text.slice(0, 500), bot: reply.slice(0, 500) });
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
          const encPath = encodeURIComponent(`Диалоги/${today}.md`);
          let sha = null;
          const gr = await fetch(`https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encPath}`, {
            headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          });
          if (gr.ok) { const gd = await gr.json(); sha = gd.sha; }
          let existing = "# Диалоги\n";
          if (sha) {
            try {
              const raw = await fetch(`https://raw.githubusercontent.com/${OBSIDIAN_REPO}/main/${encodeURIComponent(`Диалоги/${today}.md`)}`);
              if (raw.ok) existing = await raw.text();
            } catch {}
          }
          const newContent = existing + dialEntry;
          const updateBody = { message: `Диалог ${today}`, content: Buffer.from(newContent).toString("base64") };
          if (sha) updateBody.sha = sha;
          const putR = await fetch(`https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encPath}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${GITHUB_KEY}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
            body: JSON.stringify(updateBody),
          });
          if (!putR.ok) log("Ошибка сохранения диалога: " + putR.status);
        } catch (e) { log("Ошибка сохранения диалога: " + e.message); }
      };
      saveDialogue().catch(e => log("Ошибка сохранения: " + e.message)); // фоном, с логом ошибок

      if (dialogueCounter % 3 === 0) await saveMemory();

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

log("Бот запущен. deepseek-v4-pro + Obsidian vault + research + voice + cloud memory");
tg("sendMessage", { chat_id: defaultChatId, text: "Обновление выполнено! Бот запущен и готов к работе." }).catch(() => {});

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
