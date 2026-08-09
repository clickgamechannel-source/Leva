// Race Bot v2 — чистый код
const T = "8437131418:AAGHQ8Afm5HOrPJUHm6ymvojSUVxcmmUVOY";
const API = `https://api.telegram.org/bot${T}`;
const DS = "https://api.deepseek.com/chat/completions";
const DS_KEY = "sk-4808021f4af14a1d8b88ce84756d4e6d";

let offset = 0;

async function send(chat, text) {
  await fetch(`${API}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
}

async function main() {
  console.log("Race v2 запущен");
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
        else {
          const ai = await fetch(DS, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DS_KEY}` },
            body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: text }], max_tokens: 500 }),
          });
          const aiD = await ai.json();
          reply = aiD.choices?.[0]?.message?.content || "Не поняла. Повтори.";
        }
        await send(cid, reply);
        console.log("->", reply.slice(0, 60));
      }
    } catch (e) { console.log("err:", e.message); }
  }
}

main();
