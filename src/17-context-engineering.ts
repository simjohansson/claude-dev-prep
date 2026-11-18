/**
 * 17 – Context engineering: håll kontexten liten, relevant och billig
 *
 * Det här ska du kunna:
 * - Kontexten är en begränsad resurs. Fler tokens kostar mer, gör anropen långsammare och kan
 *   försämra kvaliteten ("context rot": relevant information drunknar i brus). Målet är
 *   minsta möjliga mängd tokens med hög signal.
 * - Verktyg för att hålla nere kontexten:
 *     Pruning på klientsidan – filtrera och sammanfatta stora verktygsresultat INNAN de skickas
 *       (logga: bara fel + antal; API: bara relevanta fält). Det billigaste och mest
 *       kontrollerbara alternativet.
 *     Context editing (beta) – API:et rensar gamla tool_result (clear_tool_uses) eller
 *       thinking-block (clear_thinking) på serversidan. Klienten behåller hela historiken.
 *       Rensning ändrar prefixet och ogiltigförklarar cachen, så använd clear_at_least för
 *       att det ska löna sig.
 *     Compaction (beta) – ersätt historiken med en sammanfattning och fortsätt i samma
 *       uppgift. On-demand (`compaction` på anropet) eller automatiskt vid en tröskel
 *       (context_management-edit compact_20260112). Signaturen i compaction-blocket måste
 *       skickas tillbaka oförändrad.
 *     Isolering – låt subagenter läsa mycket i egen kontext och returnera bara en
 *       sammanfattning (se 14 och 15).
 *     Just-in-time retrieval – ge modellen verktyg för att hämta data vid behov (sök,
 *       läs fil, MCP-resource) i stället för att lägga allt i prompten.
 *     Strukturerat minne – låt agenten skriva anteckningar (t.ex. NOTES.md, CLAUDE.md) som
 *       finns kvar efter rensning eller i en ny session.
 * - Placering: lägg långa dokument först och frågan sist (03), stabilt innehåll först för
  *   prompt caching (09), och historiken trimmas från början, aldrig mitt i ett
 *   tool_use/tool_result-par (11).
 */
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages";
import { anthropic, MODEL, FAST_MODEL, getText, printUsage, heading, usingOpenRouter } from "./lib/client.js";

function betaText(message: BetaMessage): string {
  return message.content.map((b: BetaContentBlock) => (b.type === "text" ? b.text : "")).join("");
}

function betaUsage(message: BetaMessage, label: string): void {
  console.log(
    `[${label}] stop_reason=${message.stop_reason} input=${message.usage.input_tokens} output=${message.usage.output_tokens}`,
  );
}

// Syntetisk applogg: mest brus, några fel.
function makeLog(service: string, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const ts = new Date(Date.UTC(2026, 0, 15, 8, 0, i)).toISOString();
    if (i % 97 === 13) out.push(`${ts} ERROR ${service} timeout mot betaltjänsten efter 30000 ms (order ${1000 + i})`);
    else if (i % 61 === 7) out.push(`${ts} WARN  ${service} långsam fråga 2400 ms`);
    else out.push(`${ts} INFO  ${service} GET /api/health 200 3 ms`);
  }
  return out.join("\n");
}

heading("a) Pruning på klientsidan: skicka bara det som behövs");
const rawLog = makeLog("checkout", 500);
function pruneLog(log: string): string {
  const lines = log.split("\n");
  const errors = lines.filter((l) => l.includes(" ERROR "));
  const warns = lines.filter((l) => l.includes(" WARN ")).length;
  return [`${lines.length} rader totalt, ${errors.length} ERROR, ${warns} WARN. Felrader:`, ...errors].join("\n");
}
const pruned = pruneLog(rawLog);

const question = "Vad är det vanligaste felet och vilka ordrar påverkas?";
// countTokens finns inte via OpenRouter – där blir det en grov uppskattning (~4 tecken/token).
async function tokens(log: string): Promise<string> {
  const content = `<logg>\n${log}\n</logg>\n${question}`;
  if (usingOpenRouter) return `~${Math.round(content.length / 4)}`;
  const { input_tokens } = await anthropic.messages.countTokens({
    model: FAST_MODEL,
    messages: [{ role: "user", content }],
  });
  return String(input_tokens);
}
console.log(`Rå logg:     ${await tokens(rawLog)} tokens`);
console.log(`Prunad logg: ${await tokens(pruned)} tokens`);

const answer = await anthropic.messages.create({
  model: FAST_MODEL,
  max_tokens: 1024,
  messages: [{ role: "user", content: `<logg>\n${pruned}\n</logg>\n${question}` }],
});
printUsage(answer, "prunad");
console.log(getText(answer));

if (usingOpenRouter) {
  heading("b) och c) hoppas över");
  console.log("Context editing och compaction är beta-funktioner i Anthropics API. Kör med ANTHROPIC_API_KEY.");
  process.exit(0);
}

heading("b) Context editing: API:et rensar gamla verktygsresultat");
// Varje verktygsanrop ger ~5k tokens. Efter 3 tool_use rensas alla utom det senaste
// resultatet på serversidan. Modellen ser en platshållare i stället för innehållet.
const services = ["checkout", "betalning", "lager", "frakt", "konto"];
const tools: BetaTool[] = [
  {
    name: "read_log",
    description: "Läser hela dagens logg (500 rader) för en tjänst.",
    input_schema: {
      type: "object",
      properties: { service: { type: "string", enum: services } },
      required: ["service"],
    },
  },
];
const messages: BetaMessageParam[] = [
  {
    role: "user",
    content:
      `Gå igenom loggarna för ${services.join(", ")}, en tjänst i taget. ` +
      "Anteckna kort antalet ERROR per tjänst i ditt svar efter varje logg, eftersom gamla loggar kan rensas ur kontexten. " +
      "Avsluta med en tabell.",
  },
];

for (let i = 1; i <= 10; i++) {
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    betas: ["context-management-2025-06-27"],
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: 3 },
          keep: { type: "tool_uses", value: 1 },
          clear_at_least: { type: "input_tokens", value: 2000 },
        },
      ],
    },
    tools,
    messages,
  });
  betaUsage(response, `iteration ${i}`);
  for (const edit of response.context_management?.applied_edits ?? []) {
    if (edit.type === "clear_tool_uses_20250919") {
      console.log(`  ✂ rensade ${edit.cleared_tool_uses} tool_use (${edit.cleared_input_tokens} tokens)`);
    }
  }
  // Klienten skickar alltid HELA historiken – rensningen görs på serversidan per anrop.
  messages.push({ role: "assistant", content: response.content });
  if (response.stop_reason !== "tool_use") {
    console.log("\n" + betaText(response));
    break;
  }
  const results: BetaToolResultBlockParam[] = response.content
    .filter((b): b is BetaToolUseBlock => b.type === "tool_use")
    .map((call) => {
      const { service } = call.input as { service: string };
      console.log(`  → read_log(${service})`);
      return { type: "tool_result", tool_use_id: call.id, content: makeLog(service, 500) };
    });
  messages.push({ role: "user", content: results });
}

heading("c) Compaction: sammanfatta historiken och fortsätt");
// En lång planeringskonversation där tidiga beslut måste överleva sammanfattningen.
const filler = "Vi diskuterade även alternativ som vi förkastade. ".repeat(150);
const history: BetaMessageParam[] = [
  { role: "user", content: "Vi planerar en ny webbshop. Budget 1,2 MSEK, lansering 1 oktober." },
  { role: "assistant", content: `Noterat: budget 1,2 MSEK, lansering 1 oktober. ${filler}` },
  { role: "user", content: "Vi väljer Stripe för betalning och Postnord för frakt. Klarna väljs bort." },
  { role: "assistant", content: `Beslut: Stripe och Postnord, inte Klarna. ${filler}` },
  { role: "user", content: "Öppen fråga: ska vi ha egen app eller bara PWA? Anna återkommer fredag." },
  { role: "assistant", content: `Öppen fråga noterad: app eller PWA, Anna svarar fredag. ${filler}` },
];

const compacted = await anthropic.beta.messages.create({
  model: MODEL,
  max_tokens: 8000,
  betas: ["compact-2026-09-04"],
  compaction: { type: "summarize", instructions: "Bevara alla beslut, siffror, datum, namn och öppna frågor." },
  messages: history,
});
betaUsage(compacted, "compaction");
const summary = compacted.content.find((b) => b.type === "compaction");
if (compacted.stop_reason !== "compaction" || !summary?.content) {
  console.log("Ingen compaction returnerades – fortsätter inte.");
  process.exit(0);
}
console.log(summary.content);

// Byt ut historiken mot compaction-blocket (oförändrat, med signatur) och fortsätt.
// Beta-headern måste skickas på alla följande anrop som innehåller blocket.
const followUp = await anthropic.beta.messages.create({
  model: MODEL,
  max_tokens: 1024,
  betas: ["compact-2026-09-04"],
  messages: [
    { role: "assistant", content: compacted.content },
    { role: "user", content: "Vilken betallösning valde vi, vad är budgeten och vad väntar vi på?" },
  ],
});
betaUsage(followUp, "efter compaction");
console.log(betaText(followUp));
