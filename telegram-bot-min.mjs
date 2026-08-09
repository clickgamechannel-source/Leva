const T = "8437131418:AAGHQ8Afm5HOrPJUHm6ymvojSUVxcmmUVOY";
const API = "https://api.telegram.org/bot" + T;
let o = 0;

console.log("Race v2. Пуск...");

async function poll() {
  try {
    const r = await fetch(API + "/getUpdates?offset=" + (o || "") + "&timeout=30");
    const d = await r.json();
    if (!d.ok) { console.log("TG err:", d.description); return; }
    for (const u of d.result || []) {
      o = u.update_id + 1;
      const m = u.message;
      if (!m?.text) continue;
      const cid = m.chat.id, text = m.text.trim();
      console.log("<-", text.slice(0, 60));
      let reply = "Привет! Я Race.";
      if (text === "/start") reply = "Я Race, ваш ассистент.";
      else if (text.includes("погода")) reply = "Погода: скоро добавлю.";
      try {
        await fetch(API + "/sendMessage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cid, text: reply }),
        });
        console.log("->", reply.slice(0, 60));
      } catch (e) { console.log("send err:", e.message); }
    }
  } catch (e) { console.log("poll err:", e.message); }
}

while (true) { await poll(); }
