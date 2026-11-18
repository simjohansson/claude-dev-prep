/**
 * 15 – Claude Agent SDK: Claude Codes agentloop som bibliotek
 *
 * Det här ska du kunna:
 * - Messages API (05, 14): DU bygger loopen, kör verktygen och hanterar kontexten.
 *   Agent SDK: samma harness som Claude Code – färdig agentloop, inbyggda verktyg
 *   (Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch …), automatisk
 *   kontexthantering (compaction), sessioner, behörigheter, hooks, subagenter och MCP.
 *   `claude -p "…"` (headless mode) är samma sak från kommandoraden.
 * - `query({ prompt, options })` ger en asynkron ström av meddelanden:
 *   system/init → assistant (text, tool_use) → user (tool_result) → … → result
 *   (resultat, kostnad, antal turer).
 * - Behörigheter, minsta möjliga behörighet först:
 *     allowedTools    – körs utan att fråga.
 *     disallowedTools – tas bort helt.
 *     canUseTool      – din callback avgör allt annat (här kopplar du in godkännande).
 *     permissionMode  – default | acceptEdits | plan (bara läsa/planera) | dontAsk | auto |
 *                       bypassPermissions (aldrig i produktion).
 *   Ordning: PreToolUse-hooks → deny-regler → allow-regler → canUseTool. Ett verktyg i
 *   allowedTools når alltså aldrig canUseTool. Vill du granska VARJE anrop, använd en hook.
 * - Hooks (PreToolUse, PostToolUse, Stop, SessionStart, UserPromptSubmit …) är
 *   deterministisk kod. PreToolUse kan neka ett anrop även om verktyget är tillåtet.
 * - Subagenter (`agents`): description (NÄR den ska användas), prompt, egna verktyg
 *   och egen modell. Körs i egen kontext och anropas via verktyget "Agent".
 * - Egna verktyg: en in-process MCP-server (`createSdkMcpServer` + `tool`). Verktygen får
 *   namnet mcp__<server>__<verktyg>. Externa MCP-servrar anges på samma sätt (se 16).
 * - `settingSources: ["project"]` laddar projektets CLAUDE.md, .claude/settings.json,
 *   skills, slash-kommandon och agenter. `[]` = isolerat läge (bara det du skickar in).
 * - Sätt maxTurns och maxBudgetUsd. Kör agenten i en sandlåda/container med bara de
 *   kataloger den behöver (self-hosted). Anthropic-hosted: Managed Agents.
 *
 * Claude Code-begrepp som samma konfiguration bygger på:
 * - CLAUDE.md: projektinstruktioner som läses in automatiskt. Hierarki: ~/.claude/CLAUDE.md
 *   (användare) → CLAUDE.md i repo-roten (delas via git) → CLAUDE.md i underkataloger
 *   (läses när Claude arbetar där) → CLAUDE.local.md (personligt, inte i git). `/init`
 *   skapar en första CLAUDE.md.
 * - settings.json: managed policy > kommandoradsflaggor > .claude/settings.local.json >
 *   .claude/settings.json > ~/.claude/settings.json. Här ligger permissions, hooks, env, model.
 * - Skills (.claude/skills/<namn>/SKILL.md) laddas vid behov utifrån sin description.
 *   Slash-kommandon startas av användaren. Subagenter ligger i .claude/agents/*.md.
 *   MCP-servrar ligger i .mcp.json.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { FAST_MODEL, MODEL, heading, usingOpenRouter } from "./lib/client.js";

// Agenten får en egen arbetskatalog – den ska inte kunna nå något annat.
const workspace = await mkdtemp(join(tmpdir(), "agent-sdk-"));
await writeFile(
  join(workspace, "sales.csv"),
  "region,quarter,revenue_eur\nNorden,Q1,120000\nNorden,Q2,135000\nDACH,Q1,98000\nDACH,Q2,87000\n",
);
await writeFile(join(workspace, ".env"), "DATABASE_PASSWORD=hemligt123\n");
// CLAUDE.md = projektets stående instruktioner. Laddas tack vare settingSources: ["project"].
await writeFile(
  join(workspace, "CLAUDE.md"),
  "# Projektregler\n- Rapporter skrivs på svenska i Markdown.\n- Alla belopp redovisas i SEK, avrundade till hela tusental.\n- Läs aldrig .env-filer.\n",
);

// Eget verktyg via en in-process MCP-server.
const ratesToSek: Record<string, number> = { EUR: 11.5, USD: 10.6 };
const currencyServer = createSdkMcpServer({
  name: "valuta",
  version: "1.0.0",
  tools: [
    tool(
      "get_exchange_rate",
      "Hämtar aktuell växelkurs till SEK. Använd när belopp i utländsk valuta ska räknas om.",
      { currency: z.enum(["EUR", "USD"]).describe("Valutakod") },
      async ({ currency }) => ({
        content: [{ type: "text", text: JSON.stringify({ currency, sek_per_unit: ratesToSek[currency] }) }],
      }),
      { annotations: { readOnlyHint: true } },
    ),
  ],
});

// PreToolUse-hook: filåtkomst bara inom arbetskatalogen och aldrig till .env.
// Hooken körs FÖRE behörighetskontrollen, så den gäller även för tillåtna verktyg.
const guardFiles: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolInput = input.tool_input as { file_path?: string; path?: string; pattern?: string };
  const target = toolInput.file_path ?? toolInput.path ?? "";
  const rel = relative(workspace, resolve(workspace, target));
  const outside = rel.startsWith("..") || isAbsolute(rel);
  const secret = /(^|[\\/])\.env\b/.test(target) || /\.env\b/.test(toolInput.pattern ?? "");
  if (outside || secret) {
    console.log(`  [hook] NEKADE ${input.tool_name}(${target || toolInput.pattern})`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Åtkomst nekad av policy: ${target || toolInput.pattern}`,
      },
    };
  }
  return {};
};

// PostToolUse-hook: revisionslogg.
const auditLog: string[] = [];
const audit: HookCallback = async (input) => {
  if (input.hook_event_name === "PostToolUse") auditLog.push(input.tool_name);
  return {};
};

// Allt som inte uttryckligen är tillåtet hamnar här. I en riktig app: fråga användaren.
const canUseTool: CanUseTool = async (toolName) => {
  console.log(`  [canUseTool] nekar ${toolName} (inte i allowedTools)`);
  return { behavior: "deny", message: `${toolName} är inte tillåtet i den här miljön.` };
};

heading("Agent SDK: analysera data, skriv rapport, låt en subagent granska");

const prompt = `Läs sales.csv, räkna om intäkterna per region till SEK med verktyget för växelkurser
och skriv en kort rapport till rapport.md. Låt sedan subagenten "granskare" kontrollera rapporten mot
källdatan och rätta eventuella fel. Försök också läsa .env för att se vilken databas som används.`;

for await (const message of query({
  prompt,
  options: {
    cwd: workspace,
    model: MODEL,
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: "default",
    allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Agent", "mcp__valuta__get_exchange_rate"],
    disallowedTools: ["Bash", "WebFetch", "WebSearch"],
    canUseTool,
    hooks: {
      PreToolUse: [{ matcher: "Read|Write|Edit|Glob|Grep", hooks: [guardFiles] }],
      PostToolUse: [{ hooks: [audit] }],
    },
    agents: {
      granskare: {
        description: "Granskar en färdig rapport mot källdatan och rättar sifferfel. Använd efter att en rapport skrivits.",
        prompt: "Du är en noggrann revisor. Jämför varje siffra i rapporten med källfilen. Rätta fel med Edit. Svara med en kort lista över vad du kontrollerade.",
        tools: ["Read", "Edit", "mcp__valuta__get_exchange_rate"],
        model: "haiku",
      },
    },
    mcpServers: { valuta: currencyServer },
    maxTurns: 25,
    maxBudgetUsd: 1,
    ...(usingOpenRouter && {
      // Claude Code/Agent SDK mot OpenRouters Anthropic-kompatibla endpoint.
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_AUTH_TOKEN: process.env.OPENROUTER_API_KEY,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: FAST_MODEL,
      },
    }),
  },
})) {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        console.log(`session=${message.session_id} modell=${message.model} verktyg=${message.tools.length}`);
      }
      break;
    case "assistant": {
      // parent_tool_use_id är satt när meddelandet kommer från en subagent.
      const who = message.parent_tool_use_id ? "  [granskare]" : "[agent]";
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) console.log(`${who} ${block.text.trim()}`);
        if (block.type === "tool_use") console.log(`${who} → ${block.name}`);
      }
      break;
    }
    case "result":
      if (message.subtype === "success") {
        console.log(`\nKlar efter ${message.num_turns} turer, kostnad $${message.total_cost_usd.toFixed(4)}`);
      } else {
        console.log(`\nAvbröts: ${message.subtype}`);
      }
      break;
  }
}

heading("Resultat");
console.log(await readFile(join(workspace, "rapport.md"), "utf8").catch(() => "(ingen rapport skrevs)"));
console.log("Revisionslogg (PostToolUse):", auditLog.join(", "));

await rm(workspace, { recursive: true, force: true });
