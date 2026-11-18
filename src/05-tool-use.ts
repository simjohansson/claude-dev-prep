/**
 * 05 – Tool use (function calling) och agentloopen
 *
 * Det här ska du kunna:
 * - Ett verktyg definieras med name, description och input_schema (JSON Schema).
 *   Beskrivningen är viktigast: förklara VAD verktyget gör, NÄR det ska användas
 *   och vad parametrarna betyder.
 * - Livscykeln för klientverktyg:
 *     1. Du skickar `tools` + meddelanden.
 *     2. Modellen svarar med stop_reason "tool_use" och ett eller flera tool_use-block.
 *     3. DU kör verktyget (modellen kör aldrig din kod).
 *     4. Du skickar tillbaka assistentens svar oförändrat + ett user-meddelande med
 *        tool_result-block (ett per tool_use, matchat via tool_use_id).
 *     5. Upprepa tills stop_reason inte längre är "tool_use".
 * - Parallella verktygsanrop: flera tool_use-block i samma svar → alla tool_result i
 *   SAMMA user-meddelande (tool_result-blocken först i content).
 * - Fel rapporteras med is_error: true så att modellen kan hantera/försöka igen.
 * - tool_choice: auto (standard), any (måste använda något verktyg),
 *   tool (måste använda ett visst), none (får inte använda verktyg).
 *   OBS: Opus 5.5, Sonnet 5.5, Fable 5.x m.fl. avvisar any/tool med 400 – använd då
 *   auto + tydlig prompt, strict tools eller structured outputs (06).
 * - Sätt alltid en maxgräns för antal iterationer i agentloopen.
 */
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { anthropic, FAST_MODEL, MODEL, getText, printUsage, heading } from "./lib/client.js";

const tools: Tool[] = [
  {
    name: "get_weather",
    description:
      "Hämtar aktuellt väder för en stad. Använd när användaren frågar om väder, temperatur eller vad man ska ha på sig. Returnerar temperatur och förhållanden.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "Stadens namn, t.ex. 'Stockholm'" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperaturenhet" },
      },
      required: ["city"],
      additionalProperties: false,
    },
    // strict: true garanterar att input följer schemat exakt.
    strict: true,
  },
  {
    name: "get_order_status",
    description:
      "Slår upp status för en order i webbutiken via order-id (format ORD-12345). Använd när användaren frågar om leverans eller order.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order-id, t.ex. ORD-12345" },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Lokala implementationer (mockade). I verkligheten: API-anrop, databas, etc.
const weatherDb: Record<string, number> = { stockholm: 4, göteborg: 7, malmö: 8 };
const orderDb: Record<string, string> = { "ORD-12345": "Skickad, levereras i morgon" };

function runTool(block: ToolUseBlock): string {
  const input = block.input as Record<string, string>;
  switch (block.name) {
    case "get_weather": {
      const celsius = weatherDb[input.city.toLowerCase()];
      if (celsius === undefined) throw new Error(`Okänd stad: ${input.city}`);
      const temp = input.unit === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius;
      return JSON.stringify({ city: input.city, temperature: temp, unit: input.unit ?? "celsius", conditions: "mulet" });
    }
    case "get_order_status": {
      const status = orderDb[input.order_id];
      if (!status) throw new Error(`Hittar ingen order med id ${input.order_id}`);
      return JSON.stringify({ order_id: input.order_id, status });
    }
    default:
      throw new Error(`Okänt verktyg: ${block.name}`);
  }
}

async function runAgent(userPrompt: string, maxIterations = 5): Promise<string> {
  const messages: MessageParam[] = [{ role: "user", content: userPrompt }];

  for (let i = 1; i <= maxIterations; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: "Du är en hjälpsam butiksassistent. Använd verktygen vid behov. Svara på svenska.",
      tools,
      tool_choice: { type: "auto" },
      messages,
    });
    printUsage(response, `iteration ${i}`);

    // Assistentens svar (inkl. thinking- och tool_use-block) måste med oförändrat.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return getText(response);
    }

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const results: ToolResultBlockParam[] = toolUses.map((toolUse) => {
      console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
      try {
        return { type: "tool_result", tool_use_id: toolUse.id, content: runTool(toolUse) };
      } catch (err) {
        return { type: "tool_result", tool_use_id: toolUse.id, content: String(err), is_error: true };
      }
    });

    messages.push({ role: "user", content: results });
  }

  throw new Error("Agenten nådde max antal iterationer");
}

heading("Parallella verktygsanrop");
console.log(await runAgent("Vad är det för väder i Stockholm och Malmö? Och var är min order ORD-12345?"));

heading("Felhantering i verktyg (is_error)");
console.log(await runAgent("Hur är vädret i Kiruna?"));

heading("tool_choice: tvinga ett specifikt verktyg (Haiku)");
const forced = await anthropic.messages.create({
  // Tvingad tool_choice stöds på Haiku 5.5 men inte på Sonnet/Opus 5.5.
  model: FAST_MODEL,
  max_tokens: 4096,
  tools,
  // Svaret börjar direkt med verktygsanropet – ingen inledande text eller thinking.
  tool_choice: { type: "tool", name: "get_weather" },
  messages: [{ role: "user", content: "Berätta något om Göteborg." }],
});
const forcedUse = forced.content.find((b): b is ToolUseBlock => b.type === "tool_use");
console.log("stop_reason:", forced.stop_reason, "→", forcedUse?.name, forcedUse?.input);
