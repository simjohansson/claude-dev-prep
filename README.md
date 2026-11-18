# Claude Messages API – TypeScript-exempel

Exempel som täcker de tekniker du behöver kunna för **Claude Certified Developer – Foundations**.
Varje fil börjar med en kommentar ”Det här ska du kunna” som sammanfattar begreppen.

## Kom igång

Kräver Node 18+ och en API-nyckel från [platform.claude.com](https://platform.claude.com).

```powershell
npm install
$env:ANTHROPIC_API_KEY = "sk-ant-..."
# valfritt: byt standardmodell (claude-sonnet-5-5)
$env:CLAUDE_MODEL = "claude-opus-5-5"

npm run ex:01        # kör ett exempel
npm run typecheck    # typkontroll av alla exempel
```

### Med OpenRouter i stället för Anthropic-nyckel

```powershell
$env:OPENROUTER_API_KEY = "sk-or-..."
npm run ex:01
```

Klienten pekar då mot OpenRouters Anthropic-kompatibla `/v1/messages` och använder OpenRouters modell-id:n
(`anthropic/claude-sonnet-5.5`). Exempel 01–10 fungerar. **11 (token counting) kräver en Anthropic-nyckel**,
eftersom OpenRouter saknar den endpointen. **12 (batches)** kör via OpenRouters eget Batch API
(`POST /api/v1/batches`) när du använder OpenRouter. Det har ett annat format än Anthropics
`/v1/messages/batches`, som SDK:n anropar. Ange gärna Anthropic som
prioriterad provider i OpenRouter så att caching, citat m.m. beter sig som hos Anthropic.

Exempel 14–18:
- **15 (Agent SDK)** startar Claude Code-motorn och pekar den mot OpenRouter via miljövariabler.
- **17 (context engineering)** kör bara del a) via OpenRouter. Context editing och compaction är beta i Anthropics API och kräver en Anthropic-nyckel.
- **16 (MCP)** startar sin egen lokala server ([src/mcp/kb-server.ts](src/mcp/kb-server.ts)).
- `@hono/node-server` (från MCP SDK:n) varnar för Node < 20. Varningen gäller bara HTTP-transporten, exemplen använder stdio.

## Exempel

| Fil | Ämne | Nyckelbegrepp |
| --- | --- | --- |
| [01-basic-message.ts](src/01-basic-message.ts) | Grundanrop | `model`, `max_tokens`, `messages`, `system`, content blocks, `stop_reason`, `usage` |
| [02-multi-turn.ts](src/02-multi-turn.ts) | Konversation | Tillståndslöst API, växlande roller, skicka tillbaka hela historiken |
| [03-prompt-engineering.ts](src/03-prompt-engineering.ts) | Promptteknik | Systemprompt, XML-taggar, few-shot, `stop_sequences`, modellval, `metadata` |
| [04-streaming.ts](src/04-streaming.ts) | Streaming | `messages.stream()`, SSE-händelser och deras ordning, `finalMessage()` |
| [05-tool-use.ts](src/05-tool-use.ts) | Verktyg | `tools`, agentloop, `tool_result`, parallella anrop, `is_error`, `tool_choice` |
| [06-structured-output.ts](src/06-structured-output.ts) | JSON-output | `output_config.format`, `messages.parse()` + Zod, extraktion via verktyg |
| [07-thinking-and-effort.ts](src/07-thinking-and-effort.ts) | Resonemang | Adaptiv thinking, `output_config.effort`, thinking-tokens |
| [08-vision-and-documents.ts](src/08-vision-and-documents.ts) | Multimodalt | Bilder (url/base64), dokument, citat |
| [09-prompt-caching.ts](src/09-prompt-caching.ts) | Caching | `cache_control`, prefixordning, TTL, cache-usage |
| [10-error-handling.ts](src/10-error-handling.ts) | Robusthet | Felklasser, retries/backoff, timeout, request-id, `max_tokens`-avklippning |
| [11-token-counting.ts](src/11-token-counting.ts) | Tokens & kostnad | `countTokens()`, kostnadsberäkning, trimma historik |
| [12-message-batches.ts](src/12-message-batches.ts) | Batchar | Asynkron bearbetning, `custom_id`, resultattyper |
| [13-evals.ts](src/13-evals.ts) | Evals | Testset med facit och kantfall, kodbedömning, förväxlingsmatris, LLM-as-judge, kalibrering |
| [14-workflows-and-agents.ts](src/14-workflows-and-agents.ts) | Workflows & agenter | Prompt chaining, routing, parallellisering, orchestrator–workers, subagenter, hooks, godkännande |
| [15-agent-sdk.ts](src/15-agent-sdk.ts) | Agent SDK & Claude Code | `query()`, CLAUDE.md, `settingSources`, behörigheter, hooks, subagenter, egna MCP-verktyg, budget |
| [16-mcp.ts](src/16-mcp.ts) | MCP | Server ([kb-server.ts](src/mcp/kb-server.ts)) och klient, tools/resources/prompts, stdio, MCP → Claude-verktyg |
| [17-context-engineering.ts](src/17-context-engineering.ts) | Context engineering | Pruning, context editing (`clear_tool_uses`), compaction, isolering, just-in-time |
| [18-security.ts](src/18-security.ts) | Säkerhet | Input-/output-guardrails, PII-pseudonymisering, behörighet i verktyg, indirekt injection, canary |

Gemensam klient och hjälpfunktioner finns i [src/lib/client.ts](src/lib/client.ts).

## Checklista inför certifieringen

**Request & response**
- Obligatoriskt: `model`, `max_tokens`, `messages`. `system` är en egen parameter.
- `messages` växlar `user`/`assistant`; `content` är en sträng eller en lista av block.
- Svaret är en lista av block (`text`, `thinking`, `tool_use`, …) – läs inte bara `content[0]`.
- `stop_reason`: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`.
- API:et är tillståndslöst – historiken är ditt ansvar.
- Prefill (avsluta med ett `assistant`-meddelande) avvisas av Claude 4.6 och senare.

**Modellval och styrning**
- Haiku: snabb/billig. Sonnet: balans. Opus/Fable: svårast resonemang och långa agentuppgifter.
- `output_config.effort` (`low` → `max`) styr djup vs. kostnad/latens för all output.
- Adaptiv thinking är standard på nyare modeller. Thinking-tokens är output-tokens och räknas mot `max_tokens`.

**Tool use**
- Bra verktygsbeskrivningar är det viktigaste. Använd JSON Schema, gärna `strict: true`.
- Loop: `tool_use` → kör verktyget själv → `tool_result` med rätt `tool_use_id` → upprepa.
- Alla `tool_result` för ett svar i *ett* user-meddelande; fel med `is_error: true`.
- `tool_choice`: `auto`, `any`, `tool`, `none`. Tvingad (`any`/`tool`) avvisas av Opus/Sonnet 5.5 m.fl.

**Output-format**
- Structured outputs (`output_config.format`) garanterar giltig JSON enligt schema.
- Validera ändå och hantera `max_tokens`/`refusal`.

**Prestanda och kostnad**
- Streaming för lägre upplevd latens och långa svar.
- Prompt caching: statiskt innehåll först (tools → system → messages), max 4 brytpunkter, TTL 5 min/1 h.
- Batchar: ca 50 % billigare, asynkront, max 24 h.
- `countTokens()` för budget och kontextfönster.

**Robusthet**
- Försök igen på 429/5xx/529 med backoff; rätta requesten vid 400/401/403/404.
- Logga request-id.

**Agenter och workflows**
- Börja enkelt: ett anrop → workflow med fasta steg (chaining, routing, parallellisering) → agent först när stegen inte går att förutse.
- En agent är en loop: modell + verktyg + miljö. Sätt stoppvillkor (`maxTurns`, budget) och mät tokens.
- Subagenter får egen isolerad kontext och returnerar bara en sammanfattning. Det kostar fler tokens totalt men håller huvudkontexten ren.
- Hooks (PreToolUse/PostToolUse) är deterministiska regler i kod som modellen inte kan prata sig förbi. Kräv godkännande för irreversibla åtgärder.

**Claude Code och Agent SDK**
- `CLAUDE.md` innehåller projektets minne och instruktioner. Hierarkin är enterprise → användare (`~/.claude`) → projekt → underkataloger.
- `.claude/settings.json` (delas i git) och `.claude/settings.local.json` (personlig) styr behörigheter (`allow`/`deny`/`ask`), hooks, env och modell.
- Utökningar:
  - `.claude/commands/` – slash-kommandon (användaren startar)
  - `.claude/agents/` – subagenter
  - `.claude/skills/` – instruktioner som laddas vid behov
  - `.mcp.json` – MCP-servrar för projektet
- Headless: `claude -p "…" --output-format json` i CI/skript. Agent SDK ger samma motor i kod.
- Agent SDK:
  - `settingSources: ["project"]` krävs för att CLAUDE.md ska läsas.
  - Behörigheter styrs med `permissionMode`, `allowedTools`/`disallowedTools` och `canUseTool`.

**MCP**
- Tools styrs av modellen, resources av appen och prompts av användaren.
- Transporter: stdio (lokal subprocess, logga till stderr) eller Streamable HTTP (fjärr, OAuth).
- Med Messages API är din app MCP-klienten. Översätt `inputSchema` till `input_schema` och `isError` till `is_error`.
- Välj rätt utökning:
  - Eget verktyg – logik som bara din app behöver.
  - MCP – integrationen ska återanvändas mellan klienter.
  - Skill – kunskap om *hur* något görs.

**Context engineering**
- Minsta möjliga mängd tokens med hög signal. Mer kontext kan ge sämre svar (context rot).
- Pruna verktygsresultat på klientsidan, eller rensa gamla tool-resultat med context editing.
- Compaction sammanfattar historiken. Isolera tunga deluppgifter i subagenter och hämta data just-in-time med verktyg.

**Säkerhet**
- Försvar i lager:
  1. Input-guardrail
  2. Dataminimering/PII
  3. Behörighet i koden
  4. Minsta behörighet och godkännande
  5. Output-guardrail
  6. Loggning
- Behörighet kontrolleras mot den inloggade användaren, aldrig mot ID:n som modellen anger.
- Indirekt prompt injection kommer via verktygsresultat, dokument och webbsidor. All extern data är opålitlig.
- API-nycklar i miljövariabler eller en secrets manager. Använd separata nycklar per miljö, rotera dem och exponera dem aldrig i klienten.
- Separera användardata från instruktioner med XML-taggar, men lita inte enbart på det.

**Evals**
- Definiera mätbara framgångskriterier först, och bygg sedan ett testset med facit och kantfall.
- Kodbedöm när det går (exakt matchning, schema). Använd LLM-as-judge med rubric för öppna svar.
- Jämför varianter på samma testset och kalibrera domaren med kända dåliga svar.

## Referenser

- [Messages API-referens](https://platform.claude.com/docs/en/api/messages/create)
- [Modellöversikt](https://platform.claude.com/docs/en/models/overview)
- [TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [Model Context Protocol](https://modelcontextprotocol.io)
