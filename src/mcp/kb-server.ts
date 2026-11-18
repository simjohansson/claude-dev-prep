/**
 * MCP-server för exempel 16: en liten kunskapsbas för kundtjänst över stdio.
 *
 * Startas som subprocess av 16-mcp.ts. Samma server kan kopplas till Claude Code:
 *   claude mcp add kunskapsbas -- npx tsx src/mcp/kb-server.ts
 * (eller läggas i projektets .mcp.json så att hela teamet får den).
 *
 * OBS: med stdio-transport ÄR stdout protokollkanalen (JSON-RPC). Logga därför
 * alltid till stderr (console.error) – console.log förstör protokollet.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const articles: Record<string, { title: string; body: string }> = {
  returer: {
    title: "Returer",
    body: "Varor kan returneras inom 30 dagar i oskadat skick. Kunden betalar returfrakten utom vid fel på varan.",
  },
  leverans: {
    title: "Leverans",
    body: "Standardleverans tar 2–4 arbetsdagar. Expressleverans (nästa vardag) kostar 99 kr.",
  },
  garanti: {
    title: "Garanti",
    body: "Elektronik har 2 års garanti. Garantin gäller inte fukt- eller tappskador.",
  },
};

const tickets: { id: string; title: string; priority: string }[] = [];

const server = new McpServer(
  { name: "kunskapsbas", version: "1.0.0" },
  { instructions: "Kunskapsbas för kundtjänst. Sök alltid i artiklarna innan du svarar på policyfrågor." },
);

// --- Tools: modellstyrda. Modellen väljer själv när de ska anropas. ---
server.registerTool(
  "search_articles",
  {
    title: "Sök i kunskapsbasen",
    description:
      "Söker bland kundtjänstartiklar (returer, leverans, garanti) på ett nyckelord. Returnerar matchande artiklar med id, titel och text.",
    inputSchema: { query: z.string().describe("Sökord, t.ex. 'retur' eller 'garanti'") },
    // Annotations är tips till klienten (t.ex. för godkännandeflöden), inte en säkerhetsgaranti.
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query }) => {
    console.error(`[kb-server] search_articles("${query}")`);
    const q = query.toLowerCase();
    const hits = Object.entries(articles)
      .filter(([id, a]) => id.includes(q) || a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q))
      .map(([id, a]) => ({ id, ...a }));
    if (hits.length === 0) {
      // Verktygsfel returneras som resultat med isError – inte som protokollfel –
      // så att modellen ser felet och kan försöka igen.
      return { isError: true, content: [{ type: "text", text: `Inga artiklar matchar "${query}". Prova ett annat sökord.` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(hits) }] };
  },
);

server.registerTool(
  "create_ticket",
  {
    title: "Skapa ärende",
    description: "Skapar ett supportärende som en människa följer upp. Använd bara när kunden behöver hjälp utöver policytexterna.",
    inputSchema: {
      title: z.string().describe("Kort sammanfattning av ärendet"),
      priority: z.enum(["low", "normal", "high"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ title, priority }) => {
    const id = `T-${1000 + tickets.length + 1}`;
    tickets.push({ id, title, priority });
    console.error(`[kb-server] create_ticket → ${id}`);
    return { content: [{ type: "text", text: JSON.stringify({ id, status: "created" }) }] };
  },
);

// --- Resources: applikationsstyrda. Klienten väljer vad som läses in som kontext. ---
server.registerResource(
  "kontaktuppgifter",
  "kb://info/contact",
  { title: "Kontaktuppgifter", description: "Kundtjänstens öppettider och kontaktvägar", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: "Kundtjänst: vardagar 8–17, chatt på webben, telefon 010-123 45 00." }],
  }),
);

server.registerResource(
  "artikel",
  new ResourceTemplate("kb://articles/{id}", {
    list: async () => ({
      resources: Object.entries(articles).map(([id, a]) => ({ uri: `kb://articles/${id}`, name: a.title })),
    }),
  }),
  { title: "Artikel", description: "En kundtjänstartikel", mimeType: "text/plain" },
  async (uri, { id }) => ({
    contents: [{ uri: uri.href, text: articles[String(id)]?.body ?? "Artikeln finns inte." }],
  }),
);

// --- Prompts: användarstyrda mallar (visas t.ex. som slash-kommandon i Claude Code). ---
server.registerPrompt(
  "svara_kund",
  {
    title: "Svara kund",
    description: "Skriv ett vänligt svar på ett kundmeddelande med stöd av kunskapsbasen",
    argsSchema: { meddelande: z.string() },
  },
  ({ meddelande }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Sök i kunskapsbasen och skriv ett vänligt, kort svar (max 3 meningar) på kundens meddelande. Hitta inte på regler som inte står i artiklarna.\n<kundmeddelande>\n${meddelande}\n</kundmeddelande>`,
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
console.error("[kb-server] redo på stdio");
