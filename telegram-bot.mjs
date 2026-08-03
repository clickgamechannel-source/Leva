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

const TELEGRAM_TOKEN = config.telegramToken || process.env.TELEGRAM_TOKEN;
const DEEPSEEK_KEY = config.deepseekKey || process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = config.model || "deepseek-v4-pro";
const GROQ_KEY = config.groqKey || process.env.GROQ_API_KEY || "";
const OPENAI_KEY = config.openaiKey || process.env.OPENAI_API_KEY || "";
const TTS_PROVIDER = config.ttsProvider || "google";
const GITHUB_KEY = config.githubKey || "";
const GIST_ID = config.gistId || "";
const OBSIDIAN_VAULT = config.obsidianVault || "D:/OBSIDIAN/Leva";

if (!TELEGRAM_TOKEN) { log("TELEGRAM_TOKEN не задан."); process.exit(1); }
if (!DEEPSEEK_KEY) { log("DEEPSEEK_API_KEY не задан."); process.exit(1); }

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DS_API = "https://api.deepseek.com/chat/completions";
const context = new Map();
const pendingResearch = new Map();
const voicePref = new Map();
let offset = 0;

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

function safePath(sub) {
  const target = resolve(OBSIDIAN_VAULT, sub.replace(/\\/g, "/"));
  if (!target.startsWith(resolve(OBSIDIAN_VAULT))) return null;
  return target;
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
  writeVault(notePath, note);

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
  if (vaultContext) userMsg = `${text}\n\n[Контекст из Obsidian vault:\n${vaultContext}\n]`;

  messages.push({ role: "user", content: userMsg });

  const system = `Ты — Race, женский ИИ-ассистент в Telegram. Отвечай кратко, на русском, дружелюбно.

Obsidian vault: ${OBSIDIAN_VAULT}
Структура vault:
${vaultSummary()}

${memoryContext()}

Ты можешь работать с vault через команды:
/vault list [путь] — список файлов
/vault read путь — прочитать файл
/vault search текст — поиск по заметкам
/vault write путь — записать (отправь СЛЕДУЮЩИМ сообщением содержимое)

Для поиска информации в интернете и создания заметок:
/research тема — бот найдёт информацию, обработает и сохранит в Obsidian
Также понимаешь фразы: «найди инфу про...», «расскажи про...» и т.д.

Если пользователь спрашивает о заметках или данных из vault, скажи ему использовать эти команды.`;

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

let botMemory = { facts: [], prefs: { bot_name: "Race", bot_gender: "female", voice: "nova" }, dialogues: [] };
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
      botMemory.dialogues = loaded.dialogues || [];
    }
    log("Память загружена: " + (botMemory.facts?.length || 0) + " фактов");
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

      let reply = "";

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

      if (text.startsWith("/vault list")) {
        const sub = text.slice(12).trim();
        reply = listVault(sub || "");
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

      // сохраняем диалог в Obsidian (ежедневный файл)
      const today = new Date().toISOString().slice(0, 10);
      const dialFile = `Диалоги/${today}.md`;
      const safeDial = safePath(dialFile);
      if (safeDial) {
        const dir = resolve(OBSIDIAN_VAULT, "Диалоги");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const entry = `\n\n**${new Date().toLocaleTimeString("ru-RU")}**\n> ${text.slice(0, 500)}\n\n${reply.slice(0, 500)}\n---`;
        try { appendFileSync(safeDial, entry, "utf8"); } catch {}
      }

      if (dialogueCounter % 5 === 0) await saveMemory();

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
