/**
 * 01 – Grundläggande anrop till Messages API
 *
 * Det här ska du kunna:
 * - De tre obligatoriska fälten: model, max_tokens, messages.
 * - `system` är en egen toppnivåparameter (inte ett meddelande med role "system").
 * - Svaret är en lista av content blocks – inte en sträng.
 * - stop_reason talar om VARFÖR modellen slutade generera.
 * - usage visar input-/output-tokens, vilket är vad du betalar för.
 */
import { anthropic, MODEL, printUsage } from "./lib/client.js";

const message = await anthropic.messages.create({
  model: MODEL,
  // Övre gräns för genererade tokens – INKLUSIVE thinking. Sätt den generöst: du betalar
  // bara för det som faktiskt genereras. För lågt tak → tomt svar med stop_reason "max_tokens".
  max_tokens: 4096,
  system: "Du är en pedagogisk assistent. Svara kort och på svenska.",
  messages: [{ role: "user", content: "Förklara vad en token är i två meningar." }],
});

console.log("id:         ", message.id);
console.log("type/role:  ", message.type, "/", message.role); // "message" / "assistant"
console.log("model:      ", message.model);

// Gå igenom alla content blocks. Med adaptiv thinking (standard på nyare modeller)
// kan ett thinking-block komma före texten.
for (const block of message.content) {
  switch (block.type) {
    case "text":
      console.log("\n[text]\n" + block.text);
      break;
    case "thinking":
      console.log(`\n[thinking] (${block.thinking.length} tecken synligt sammanfattat resonemang)`);
      break;
    default:
      console.log(`\n[${block.type}]`);
  }
}

// Möjliga stop_reason-värden:
//   end_turn        – modellen var klar
//   max_tokens      – svaret klipptes av max_tokens (öka gränsen eller be om kortare svar)
//   stop_sequence   – en av dina stop_sequences påträffades (se message.stop_sequence)
//   tool_use        – modellen vill att du kör ett verktyg (se 05-tool-use.ts)
//   pause_turn      – en lång server-verktygstur pausades; skicka tillbaka svaret för att fortsätta
//   refusal         – modellen avböjde av säkerhetsskäl
//   model_context_window_exceeded – kontextfönstret tog slut
console.log();
printUsage(message);
