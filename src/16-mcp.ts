/**
 * 16 – MCP (Model Context Protocol): bygg en server och använd den med Claude
 *
 * Det här ska du kunna:
 * - MCP är ett öppet protokoll (JSON-RPC 2.0) för att koppla verktyg och data till
 *   AI-appar. Skriv integrationen en gång och använd den i Claude Code, Claude Desktop,
 *   claude.ai, Agent SDK (15) och din egen app.
 * - Roller: host (appen, t.ex. Claude Code) → client (en per serveranslutning) → server.
 * - Tre primitiver – och vem som styr dem:
 *     Tools     – MODELLEN väljer när de anropas (funktioner med sidoeffekter eller sök).
 *     Resources – APPEN väljer vad som läses in som kontext (data via URI, t.ex. kb://…).
 *     Prompts   – ANVÄNDAREN väljer (färdiga mallar, t.ex. slash-kommandon).
 * - Transporter:
 *     stdio           – lokal subprocess. stdout är protokollkanalen, logga till stderr.
 *     Streamable HTTP – fjärrserver, många klienter, autentisering (OAuth). SSE är den
 *                       äldre HTTP-transporten.
 * - Livscykel: initialize (version + capabilities förhandlas) → list → call/read/get → close.
 * - Med Messages API är DIN app MCP-klienten: lista verktygen, översätt till Claude-format
 *   (inputSchema → input_schema), skicka tool_use vidare till callTool och returnera
 *   resultatet som tool_result. Verktygsfel (isError) → is_error: true.
 *   Alternativ: MCP-connectorn i API:et (`mcp_servers`, beta) låter Anthropic ansluta
 *   direkt till en fjärrserver över HTTP – då behövs ingen egen klientkod.
 * - Säkerhet: en MCP-server kör kod på din maskin, och dess verktygsresultat är opålitlig
 *   input (indirekt prompt injection). Använd bara betrodda servrar, ge minsta möjliga
 *   behörighet och kräv godkännande för skrivande verktyg. Annotations som readOnlyHint
 *   är tips, inte garantier.
 *
 * Inbyggda verktyg, egna verktyg, Skills eller MCP?
 *   Inbyggda/serververktyg (web search, code execution, text editor, bash) – färdiga,
 *     använd dem när de räcker.
 *   Eget verktyg (05) – logik som bara din app behöver. Enklast, ingen extra process.
 *   MCP-server – samma integration ska återanvändas av flera klienter/team, eller så finns
 *     redan en server för systemet (GitHub, Jira, databaser).
 *   Skill – paketerade instruktioner (+ ev. skript och filer) som laddas vid behov utifrån
 *     sin description. En skill lär Claude HUR något görs, MCP ger åtkomst till system och data.
 *
 * Servern ligger i src/mcp/kb-server.ts.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MessageParam, Tool, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, MODEL, getText, printUsage, heading } from "./lib/client.js";

heading("Anslut till MCP-servern över stdio");
// Klienten startar servern som subprocess och pratar JSON-RPC över stdin/stdout.
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const serverPath = fileURLToPath(new URL("./mcp/kb-server.ts", import.meta.url));
const mcp = new Client({ name: "claude-dev-exempel", version: "1.0.0" });
await mcp.connect(
  new StdioClientTransport({ command: process.execPath, args: [tsxCli, serverPath], stderr: "inherit" }),
);
console.log("Server:", mcp.getServerVersion());
console.log("Capabilities:", Object.keys(mcp.getServerCapabilities() ?? {}).join(", "));

heading("Upptäck förmågor: tools, resources, prompts");
const { tools: mcpTools } = await mcp.listTools();
const { resources } = await mcp.listResources();
const { resourceTemplates } = await mcp.listResourceTemplates();
const { prompts } = await mcp.listPrompts();
for (const t of mcpTools) {
  console.log(`tool     ${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : " (skrivande – kräv godkännande i produktion)"}`);
}
for (const r of resources) console.log(`resource ${r.uri}  – ${r.name}`);
for (const r of resourceTemplates) console.log(`template ${r.uriTemplate}`);
for (const p of prompts) console.log(`prompt   ${p.name}  – ${p.description}`);

// MCP-verktyg → Claude-verktyg. Namn, beskrivning och JSON Schema följer med.
const claudeTools: Tool[] = mcpTools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema as Tool["input_schema"],
}));

heading("Resource: appen väljer kontext att läsa in");
const contact = await mcp.readResource({ uri: "kb://info/contact" });
const contactText = contact.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
console.log(contactText);

heading("Prompt + tools: kör en servermall genom agentloopen");
const template = await mcp.getPrompt({
  name: "svara_kund",
  arguments: { meddelande: "Mina hörlurar slutade fungera efter att de blev blöta. Gäller garantin? Hur når jag er?" },
});
const messages: MessageParam[] = template.messages.map((m) => ({
  role: m.role,
  content: m.content.type === "text" ? m.content.text : "",
}));

const system = `Du är kundtjänstagent.
<server_instructions>
${mcp.getInstructions() ?? ""}
</server_instructions>
<kontaktuppgifter>
${contactText}
</kontaktuppgifter>`;

for (let i = 1; i <= 6; i++) {
  const response = await anthropic.messages.create({ model: MODEL, max_tokens: 4096, system, tools: claudeTools, messages });
  printUsage(response, `iteration ${i}`);
  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason !== "tool_use") {
    console.log("\n" + getText(response));
    break;
  }

  const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const results = await Promise.all(
    calls.map(async (call): Promise<ToolResultBlockParam> => {
      console.log(`  → mcp.callTool(${call.name}, ${JSON.stringify(call.input)})`);
      const result = await mcp.callTool({ name: call.name, arguments: call.input as Record<string, unknown> });
      const text = (result.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { type: "tool_result", tool_use_id: call.id, content: text, is_error: Boolean(result.isError) };
    }),
  );
  messages.push({ role: "user", content: results });
}

await mcp.close();
