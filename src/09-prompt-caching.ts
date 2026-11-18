/**
 * 09 – Prompt caching
 *
 * Det här ska du kunna:
 * - Caching återanvänder ett oförändrat PREFIX av prompten mellan anrop → lägre
 *   kostnad och latens för långa systemprompter, dokument, verktygsdefinitioner.
 * - Prefixordningen är tools → system → messages. Allt FÖRE en cache-brytpunkt måste
 *   vara byte-identiskt för att ge träff. Lägg statiskt innehåll först och varierande
 *   innehåll (tidsstämplar, användarens fråga) sist.
 * - Två sätt: explicita brytpunkter med `cache_control` på block (max 4 st), eller
 *   automatisk caching med `cache_control` på toppnivå (bra för växande konversationer).
 * - TTL: "5m" (standard, förnyas vid varje träff) eller "1h" (dyrare att skriva).
 * - Cache-skrivning kostar lite mer än vanlig input, cache-läsning betydligt mindre.
 * - Prompten måste vara minst en viss längd för att cachas (varierar per modell).
 * - Följ upp via usage.cache_creation_input_tokens och usage.cache_read_input_tokens.
 */
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, MODEL, getText, printUsage, heading } from "./lib/client.js";

// En lång, statisk "handbok" – i verkligheten t.ex. en produktmanual eller kodbas.
const handbook = Array.from(
  { length: 120 },
  (_, i) =>
    `§${i + 1}. Regel ${i + 1}: Kunder med medlemsnivå ${["Brons", "Silver", "Guld"][i % 3]} får ` +
    `${(i % 10) + 5} % rabatt på produktkategori ${i % 7} och fri frakt över ${300 + i * 5} kr.`,
).join("\n");

const system: TextBlockParam[] = [
  { type: "text", text: "Du är kundtjänst för Butiken AB. Svara kort och hänvisa till paragraf." },
  {
    type: "text",
    text: `<handbook>\n${handbook}\n</handbook>`,
    // Brytpunkt: allt till och med detta block (tools + system) cachas.
    cache_control: { type: "ephemeral" },
  },
];

const questions = [
  "Vilken rabatt gäller enligt §12?",
  "Från vilket belopp är frakten gratis enligt §40?",
  "Vilken medlemsnivå gäller i §77?",
];

heading("Explicit brytpunkt på systemprompten");
for (const [i, question] of questions.entries()) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: question }],
  });
  console.log(`\nFråga ${i + 1}: ${question}\n${getText(response)}`);
  // Anrop 1: cache_write > 0. Anrop 2–3: cache_read > 0 (om inom TTL).
  printUsage(response, `anrop ${i + 1}`);
}

heading("Automatisk caching (toppnivå) i en konversation");
const auto = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  output_config: { effort: "low" },
  // API:et sätter brytpunkten på sista cachebara blocket och flyttar den
  // framåt när konversationen växer.
  cache_control: { type: "ephemeral" },
  system: `<handbook>\n${handbook}\n</handbook>`,
  messages: [{ role: "user", content: "Sammanfatta §1 i en mening." }],
});
console.log(getText(auto));
printUsage(auto, "auto");
