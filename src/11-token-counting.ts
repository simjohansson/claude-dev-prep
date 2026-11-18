/**
 * 11 – Tokenräkning och kostnadsuppskattning
 *
 * Det här ska du kunna:
 * - `messages.countTokens()` räknar input-tokens (meddelanden, system, verktyg,
 *   bilder, dokument) UTAN att generera svar – gratis att anropa (separat rate limit).
 * - Använd det för att hålla dig inom kontextfönstret, välja när historik ska
 *   trimmas/sammanfattas och uppskatta kostnad innan du skickar.
 * - Kostnad = input_tokens × inpris + output_tokens × utpris (per miljon tokens).
 *   Output (inkl. thinking) är dyrare än input. Cache-läsning och batchar är billigare.
 * - Verktygsdefinitioner och systemprompt räknas också som input-tokens.
 */
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, MODEL, printUsage, heading, usingOpenRouter } from "./lib/client.js";

if (usingOpenRouter) {
  console.error("OpenRouter stödjer inte /v1/messages/count_tokens – kör detta exempel med en Anthropic-nyckel.");
  process.exit(1);
}

// Exempelpriser i USD per miljon tokens – kontrollera aktuell prislista.
const PRICE_PER_MTOK = { input: 2, output: 10 };

const tools: Tool[] = [
  {
    name: "search_products",
    description: "Söker i produktkatalogen.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

const messages: MessageParam[] = [
  { role: "user", content: "Jag letar efter vattentäta vandringskängor i storlek 42 under 1500 kr." },
];

heading("Räkna tokens innan anropet");
const withoutTools = await anthropic.messages.countTokens({ model: MODEL, messages });
const withTools = await anthropic.messages.countTokens({
  model: MODEL,
  system: "Du är en butiksassistent.",
  tools,
  messages,
});
console.log(`Bara meddelandet:        ${withoutTools.input_tokens} tokens`);
console.log(`+ system + verktyg:      ${withTools.input_tokens} tokens`);

heading("Jämför med faktisk usage");
const response = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  system: "Du är en butiksassistent.",
  tools,
  messages,
});
printUsage(response);

const cost =
  (response.usage.input_tokens / 1_000_000) * PRICE_PER_MTOK.input +
  (response.usage.output_tokens / 1_000_000) * PRICE_PER_MTOK.output;
console.log(`Uppskattad kostnad: $${cost.toFixed(6)}`);

heading("Enkel kontexthantering: trimma äldsta turerna vid behov");
async function fitToBudget(history: MessageParam[], maxInputTokens: number): Promise<MessageParam[]> {
  const trimmed = [...history];
  while (trimmed.length > 1) {
    const { input_tokens } = await anthropic.messages.countTokens({ model: MODEL, messages: trimmed });
    if (input_tokens <= maxInputTokens) break;
    // Ta bort ett user/assistant-par så att rollerna fortsätter växla och början är "user".
    trimmed.splice(0, 2);
  }
  return trimmed;
}

const longHistory: MessageParam[] = Array.from({ length: 10 }, (_, i): MessageParam[] => [
  { role: "user", content: `Fråga ${i + 1}: ${"lorem ipsum ".repeat(50)}` },
  { role: "assistant", content: `Svar ${i + 1}: ${"dolor sit amet ".repeat(50)}` },
]).flat();
longHistory.push({ role: "user", content: "Sista frågan." });

const fitted = await fitToBudget(longHistory, 1500);
console.log(`Historik: ${longHistory.length} → ${fitted.length} meddelanden`);
