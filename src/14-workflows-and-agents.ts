/**
 * 14 – Workflows, agenter, subagenter och hooks (med rena Messages API:et)
 *
 * Det här ska du kunna:
 * - Workflow eller agent?
 *     Workflow = DIN kod bestämmer stegen (förutsägbart, billigt, lätt att testa).
 *     Agent    = MODELLEN bestämmer nästa steg i en loop med verktyg (flexibelt men
 *                dyrare, långsammare och svårare att testa).
 *   Börja med det enklaste som fungerar: ett anrop → workflow → agent bara när stegen
 *   inte går att förutse i förväg.
 * - Vanliga workflow-mönster:
 *     Prompt chaining   – steg i följd, med en kontroll ("gate") i kod mellan stegen.
 *     Routing           – klassificera först, skicka sedan till specialiserad prompt/modell.
 *     Parallelization   – oberoende delar samtidigt (sectioning) eller flera röster (voting).
 *     Orchestrator–workers – en huvudmodell delar upp uppgiften dynamiskt och delegerar.
 *     Evaluator–optimizer  – en modell genererar, en annan bedömer, upprepa.
 * - Subagenter: en arbetare med EGEN kontext (egen messages-lista, systemprompt och
 *   minsta möjliga verktyg). Den får en självständig uppgift och returnerar bara en
 *   kondenserad sammanfattning → huvudagentens kontext hålls liten och fokuserad.
 *   Det är både ett arkitekturmönster (manager/supervisor-hierarki) och context engineering.
 * - Hooks = deterministisk kod som körs före/efter verktygsanrop i din harness.
 *   PreToolUse kan blockera (t.ex. destruktiva åtgärder), PostToolUse kan logga/maskera.
 *   En hook är en garanti – en instruktion i prompten är bara en uppmaning.
 * - Human-in-the-loop: kräv mänskligt godkännande för åtgärder med sidoeffekter.
 * - Sätt alltid en maxgräns för antal iterationer (och gärna för kostnad).
 * - Minne mellan sessioner: spara tillstånd utanför kontexten (fil, databas, memory tool)
 *   och hämta in det vid behov.
 * - Samma begrepp finns i Claude Agent SDK (15) och i ramverk som LangGraph, Strands och
 *   PydanticAI. Self-hosted (du kör loopen/SDK:n i din infrastruktur) eller
 *   Anthropic-hosted (Managed Agents – Anthropic kör loopen och miljön åt dig).
 */
import type { Tool, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import type Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { anthropic, FAST_MODEL, MODEL, getText, heading } from "./lib/client.js";

// ---------------------------------------------------------------------------
// En liten återanvändbar harness: agentloop + hooks
// ---------------------------------------------------------------------------
type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>;
type HookDecision = { allow: true } | { allow: false; reason: string };
type PreToolUseHook = (call: ToolUseBlock) => HookDecision | Promise<HookDecision>;
type PostToolUseHook = (call: ToolUseBlock, result: string, isError: boolean) => void;

interface LoopOptions {
  label: string;
  system: string;
  prompt: string;
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
  model?: Anthropic.Model;
  preToolUse?: PreToolUseHook[];
  postToolUse?: PostToolUseHook[];
  maxIterations?: number;
}

interface LoopResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.prompt }];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 1; i <= (opts.maxIterations ?? 6); i++) {
    const response = await anthropic.messages.create({
      model: opts.model ?? MODEL,
      max_tokens: 8192,
      system: opts.system,
      tools: opts.tools,
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return { text: getText(response), inputTokens, outputTokens };
    }

    const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    // Hooks körs i tur och ordning (t.ex. så att godkännandefrågor inte krockar)...
    const decisions: HookDecision[] = [];
    for (const call of calls) {
      console.log(`  [${opts.label}] → ${call.name}(${JSON.stringify(call.input)})`);
      let decision: HookDecision = { allow: true };
      for (const hook of opts.preToolUse ?? []) {
        decision = await hook(call);
        if (!decision.allow) break;
      }
      decisions.push(decision);
    }

    // ...medan de tillåtna verktygen körs parallellt.
    const results: ToolResultBlockParam[] = await Promise.all(
      calls.map(async (call, i): Promise<ToolResultBlockParam> => {
        const decision = decisions[i];
        let content: string;
        let isError = false;
        if (!decision.allow) {
          // Blockerat anrop rapporteras som ett fel så att modellen kan välja en annan väg.
          content = `Blockerat av policy: ${decision.reason}`;
          isError = true;
        } else {
          try {
            const handler = opts.handlers[call.name];
            if (!handler) throw new Error(`Okänt verktyg: ${call.name}`);
            content = await handler(call.input as Record<string, unknown>);
          } catch (err) {
            content = String(err);
            isError = true;
          }
        }
        for (const hook of opts.postToolUse ?? []) hook(call, content, isError);
        return { type: "tool_result", tool_use_id: call.id, content, is_error: isError };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  throw new Error(`[${opts.label}] nådde max antal iterationer`);
}

// Enkelt anrop utan verktyg – byggstenen i alla workflows.
async function ask(prompt: string, system: string, model: Anthropic.Model = MODEL, maxTokens = 4096): Promise<string> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return getText(response);
}

// ---------------------------------------------------------------------------
heading("Workflow 1: Prompt chaining med gate i kod");
// ---------------------------------------------------------------------------
const outline = await ask(
  "Skriv en disposition i exakt 3 punkter (en per rad, börja varje rad med '- ') för en kort text om varför man ska versionshantera promptar.",
  "Du skriver koncisa dispositioner på svenska.",
);
const points = outline.split("\n").filter((line) => line.trim().startsWith("- "));
console.log(outline);

// Gate: deterministisk kontroll innan nästa (dyrare) steg. Avbryt eller försök igen vid fel.
if (points.length !== 3) {
  console.log(`Gate misslyckades: förväntade 3 punkter, fick ${points.length}. Avbryter kedjan.`);
} else {
  const article = await ask(
    `Skriv ett stycke (max 80 ord) per punkt i dispositionen.\n<outline>\n${outline}\n</outline>`,
    "Du skriver sakligt och kort på svenska.",
  );
  console.log("\n" + article);
}

// ---------------------------------------------------------------------------
heading("Workflow 2: Routing – billig klassificering, sedan specialiserad hantering");
// ---------------------------------------------------------------------------
const routes = {
  BILLING: { system: "Du är faktureringsexpert. Svara kort och be alltid om fakturanummer.", model: FAST_MODEL },
  TECHNICAL: { system: "Du är en senior supporttekniker. Ge felsökningssteg i numrerad lista.", model: MODEL },
  OTHER: { system: "Du är en vänlig kundtjänstmedarbetare. Svara kort.", model: FAST_MODEL },
} satisfies Record<string, { system: string; model: Anthropic.Model }>;

const ticket = "Appen kraschar när jag laddar upp en bild större än 10 MB.";
const routeResponse = await anthropic.messages.create({
  model: FAST_MODEL,
  max_tokens: 20,
  thinking: { type: "disabled" },
  system: "Klassificera ärendet. Svara med exakt ett ord: BILLING, TECHNICAL eller OTHER.",
  messages: [{ role: "user", content: `<ticket>${ticket}</ticket>` }],
});
const routeKey = getText(routeResponse).trim().toUpperCase();
// Validera modellens val – fall tillbaka till en säker standardväg.
const route = routes[routeKey as keyof typeof routes] ?? routes.OTHER;
console.log(`Route: ${routeKey} → modell ${route.model}`);
console.log(await ask(ticket, route.system, route.model));

// ---------------------------------------------------------------------------
heading("Workflow 3: Parallelization (sectioning) – oberoende granskningar samtidigt");
// ---------------------------------------------------------------------------
const code = `function getUser(id) {
  return db.query("SELECT * FROM users WHERE id = " + id);
}`;
const aspects = ["säkerhet", "prestanda", "läsbarhet"];
const reviews = await Promise.all(
  aspects.map((aspect) =>
    ask(
      `<code>\n${code}\n</code>\nGranska ENDAST ur perspektivet ${aspect}. Max 2 meningar.`,
      "Du är en erfaren kodgranskare.",
      FAST_MODEL,
      1024,
    ),
  ),
);
aspects.forEach((aspect, i) => console.log(`[${aspect}] ${reviews[i]}`));

// ---------------------------------------------------------------------------
heading("Orchestrator–workers: subagenter med isolerad kontext");
// ---------------------------------------------------------------------------
// Stor, "brusig" kunskapsbas – bara subagenten ser rådatan.
const knowledgeBase: Record<string, string> = {
  "caching.md": `Prompt caching: cache_control markerar slutet på ett cachebart prefix. Max 4 brytpunkter. TTL 5 min (standard) eller 1 h. ${"Utfyllnadstext om caching. ".repeat(80)}`,
  "batches.md": `Message Batches: ca 50 % rabatt, asynkront, resultat inom 24 h, matcha på custom_id. ${"Utfyllnadstext om batchar. ".repeat(80)}`,
  "streaming.md": `Streaming: SSE-händelser message_start, content_block_delta, message_stop. ${"Utfyllnadstext om streaming. ".repeat(80)}`,
};

const searchTool: Tool = {
  name: "read_doc",
  description: `Läser ett dokument ur kunskapsbasen. Tillgängliga filer: ${Object.keys(knowledgeBase).join(", ")}.`,
  input_schema: {
    type: "object",
    properties: { file: { type: "string", enum: Object.keys(knowledgeBase) } },
    required: ["file"],
    additionalProperties: false,
  },
  strict: true,
};

let subagentTokens = 0;
async function runResearchSubagent(task: string): Promise<string> {
  // Ny, tom kontext: subagenten ser INTE orkestrerarens konversation – bara uppgiften.
  const result = await runLoop({
    label: "subagent",
    model: FAST_MODEL,
    system:
      "Du är en researchagent. Läs relevanta dokument och returnera en faktasammanfattning på max 3 meningar. Inga utfyllnadsord.",
    prompt: task,
    tools: [searchTool], // Minsta möjliga verktyg: bara läsrätt.
    handlers: { read_doc: (input) => knowledgeBase[String(input.file)] ?? "Filen finns inte." },
  });
  subagentTokens += result.inputTokens;
  return result.text;
}

const delegateTool: Tool = {
  name: "delegate_research",
  description:
    "Delegerar en avgränsad researchuppgift till en subagent som kan läsa kunskapsbasen. Subagenten ser INTE den här konversationen, så beskriv uppgiften självständigt och fullständigt. Returnerar en kort sammanfattning. Delegera oberoende deluppgifter parallellt.",
  input_schema: {
    type: "object",
    properties: { task: { type: "string", description: "Självständig uppgiftsbeskrivning" } },
    required: ["task"],
    additionalProperties: false,
  },
  strict: true,
};

const orchestrator = await runLoop({
  label: "orkestrerare",
  system:
    "Du är en tekniskt ansvarig som planerar. Dela upp frågan i deluppgifter, delegera research till subagenter och sammanställ ett beslut. Läs aldrig dokument själv.",
  prompt:
    "Vi ska klassificera 100 000 historiska supportärenden en gång i natt, med samma långa systemprompt. Vilka två API-funktioner sänker kostnaden mest, och varför?",
  tools: [delegateTool],
  handlers: { delegate_research: (input) => runResearchSubagent(String(input.task)) },
});
console.log("\n" + orchestrator.text);
console.log(
  `\nInput-tokens: orkestrerare=${orchestrator.inputTokens}, subagenter=${subagentTokens}. ` +
    "Rådatan stannade i subagenternas kontext – orkestreraren såg bara sammanfattningarna.",
);

// ---------------------------------------------------------------------------
heading("Hooks + human-in-the-loop: deterministiska skydd runt verktygen");
// ---------------------------------------------------------------------------
const files = new Map<string, string>([
  ["/tmp/cache.tmp", "temporär data"],
  ["/data/kunder.db", "VIKTIG PRODUKTIONSDATA"],
  ["/tmp/gammal.log", "gamla loggar"],
]);

const fileTools: Tool[] = [
  {
    name: "list_files",
    description: "Listar alla filer.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delete_file",
    description: "Raderar en fil permanent. Kan inte ångras.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// PreToolUse-hook 1: hård regel som INTE går att prata sig förbi med en prompt.
const protectProductionData: PreToolUseHook = (call) => {
  const path = String((call.input as { path?: string }).path ?? "");
  if (call.name === "delete_file" && !path.startsWith("/tmp/")) {
    return { allow: false, reason: `radering utanför /tmp/ är förbjuden (${path})` };
  }
  return { allow: true };
};

// PreToolUse-hook 2: kräv godkännande av människa för åtgärder med sidoeffekter.
const requireApproval: PreToolUseHook = async (call) => {
  if (call.name !== "delete_file") return { allow: true };
  if (!process.stdin.isTTY) {
    // Ingen människa tillgänglig (t.ex. i CI) → säker standard: neka.
    return { allow: false, reason: "inget godkännande (icke-interaktiv körning)" };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Godkänn ${call.name}(${JSON.stringify(call.input)})? [j/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "j" ? { allow: true } : { allow: false, reason: "nekades av användaren" };
};

// PostToolUse-hook: revisionslogg över alla verktygsanrop.
const auditLog: string[] = [];
const audit: PostToolUseHook = (call, result, isError) => {
  auditLog.push(`${new Date().toISOString()} ${call.name} ${JSON.stringify(call.input)} → ${isError ? "FEL" : "OK"}`);
};

const cleanup = await runLoop({
  label: "städagent",
  system: "Du städar disken. Radera alla filer som inte behövs.",
  // Instruktionen nedan är riskabel – hooken skyddar oavsett vad modellen bestämmer sig för.
  prompt: "Frigör så mycket diskutrymme som möjligt. Radera alla filer.",
  tools: fileTools,
  handlers: {
    list_files: () => JSON.stringify([...files.keys()]),
    delete_file: (input) => {
      files.delete(String(input.path));
      return `Raderade ${input.path}`;
    },
  },
  preToolUse: [protectProductionData, requireApproval],
  postToolUse: [audit],
});
console.log("\n" + cleanup.text);
console.log("\nKvarvarande filer:", [...files.keys()]);
console.log("Revisionslogg:\n  " + auditLog.join("\n  "));
