/**
 * 07 – Thinking och effort
 *
 * Det här ska du kunna:
 * - Thinking låter modellen resonera innan svaret. Resonemanget kommer i
 *   `thinking`-block före `text`-blocken.
 * - Adaptiv thinking (`{ type: "adaptive" }`) är standard på nyare modeller: modellen
 *   avgör själv när och hur mycket den tänker. Manuell budget (`type: "enabled"` +
 *   `budget_tokens`) avvisas av de nyaste modellerna.
 * - `output_config.effort` (low | medium | high | xhigh | max) är det rekommenderade
 *   reglaget för djup vs. kostnad/latens. Effort påverkar ALLA output-tokens, även
 *   textsvar och verktygsanrop.
 * - Thinking-tokens faktureras som output-tokens och räknas mot max_tokens –
 *   sätt max_tokens generöst.
 * - `display: "summarized"` returnerar en sammanfattning av resonemanget;
 *   `"omitted"` returnerar tomma thinking-block (men med signature).
 * - I flerturs-/verktygskonversationer: skicka tillbaka thinking-block oförändrade
 *   (signature krävs).
 */
import type { ThinkingBlock } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, MODEL, getText, printUsage, heading } from "./lib/client.js";

const problem = `En butik säljer pennor för 7 kr och suddgummin för 4 kr.
Lisa köpte exakt 20 saker för totalt 107 kr. Hur många pennor köpte hon?
Visa kort hur du kontrollerar svaret.`;

for (const effort of ["low", "high"] as const) {
  heading(`effort = ${effort}`);

  const started = Date.now();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16_000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    messages: [{ role: "user", content: problem }],
  });

  for (const block of response.content) {
    if (block.type === "thinking") {
      const preview = (block as ThinkingBlock).thinking.slice(0, 300);
      console.log(`[thinking-sammanfattning] ${preview}${preview.length === 300 ? "…" : ""}`);
    } else if (block.type === "redacted_thinking") {
      console.log("[redacted_thinking] (krypterat – skicka tillbaka oförändrat)");
    }
  }
  if (!response.content.some((b) => b.type === "thinking" || b.type === "redacted_thinking")) {
    // Adaptiv thinking: modellen bedömde att uppgiften inte krävde resonemang.
    console.log("[ingen thinking – modellen valde att svara direkt]");
  }

  console.log("\n[svar]\n" + getText(response));
  printUsage(response);
  console.log(`tid: ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
