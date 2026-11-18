/**
 * 02 – Konversationer med flera turer
 *
 * Det här ska du kunna:
 * - API:et är TILLSTÅNDSLÖST: du måste skicka hela historiken i varje anrop.
 * - Roller växlar user/assistant. Första meddelandet ska vara från user.
 * - Skicka tillbaka assistentens content blocks oförändrade (inklusive thinking-block
 *   med signature) – inte bara texten.
 * - Varje tur kostar input-tokens för HELA historiken → historiken växer linjärt
 *   (prompt caching i 09 och trimning/sammanfattning hjälper).
 */
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, MODEL, getText, printUsage, heading } from "./lib/client.js";

const history: MessageParam[] = [];

async function chat(userText: string): Promise<string> {
  history.push({ role: "user", content: userText });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: "Du är en vänlig resecoach. Svara kort på svenska.",
    messages: history,
  });

  history.push({ role: "assistant", content: response.content });

  printUsage(response, `tur ${history.length / 2}`);
  return getText(response);
}

heading("Tur 1");
console.log(await chat("Jag heter Anna och vill åka på semester i mars. Ge ett förslag."));

heading("Tur 2");
// Modellen "minns" bara för att vi skickar med tidigare turer.
console.log(await chat("Vad hette jag nu igen, och vilken månad ville jag resa?"));

heading("Utan historik");
// Samma fråga utan historik → modellen vet ingenting.
const fresh = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  messages: [{ role: "user", content: "Vad hette jag nu igen?" }],
});
console.log(getText(fresh));

heading("Historikens form");
console.log(history.map((m) => `${m.role}: ${typeof m.content === "string" ? "string" : `${m.content.length} block`}`));
