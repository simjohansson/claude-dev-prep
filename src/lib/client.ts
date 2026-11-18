import Anthropic from "@anthropic-ai/sdk";
import type { Message, TextBlock } from "@anthropic-ai/sdk/resources/messages";

const openRouterKey = process.env.OPENROUTER_API_KEY;
export const usingOpenRouter = Boolean(openRouterKey);

if (!process.env.ANTHROPIC_API_KEY && !openRouterKey) {
  console.error(
    'Saknar API-nyckel. Sätt t.ex. $env:ANTHROPIC_API_KEY = "sk-ant-..." eller $env:OPENROUTER_API_KEY = "sk-or-..."',
  );
  process.exit(1);
}

// Lägg aldrig nyckeln i koden – läs den från miljön.
// SDK:n gör automatiska omförsök (exponentiell backoff) på 408/409/429/5xx och nätverksfel.
export const anthropic = new Anthropic({
  maxRetries: 2,
  timeout: 120_000,
  // OpenRouter exponerar ett Anthropic-kompatibelt /v1/messages och autentiserar med Bearer-token.
  ...(openRouterKey && { baseURL: "https://openrouter.ai/api", apiKey: null, authToken: openRouterKey }),
});

// Välj modell efter uppgift: Haiku = snabb/billig (klassificering, extraktion),
// Sonnet = balans, Opus/Fable = svårast resonemang och långa agentuppgifter.
// OpenRouter använder egna modell-id:n (anthropic/claude-sonnet-5.5).
export const MODEL: Anthropic.Model =
  process.env.CLAUDE_MODEL ?? (usingOpenRouter ? "anthropic/claude-sonnet-5.5" : "claude-sonnet-5-5");
export const FAST_MODEL: Anthropic.Model = usingOpenRouter ? "anthropic/claude-haiku-5.5" : "claude-haiku-5-5";

// Svaret är en lista av content blocks (text, thinking, tool_use, ...). Plocka ut texten.
export function getText(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function printUsage(message: Message, label = "usage"): void {
  const u = message.usage;
  console.log(
    `[${label}] stop_reason=${message.stop_reason} input=${u.input_tokens} output=${u.output_tokens}` +
      ` (thinking=${u.output_tokens_details?.thinking_tokens ?? 0})` +
      ` cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`,
  );
}

export function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}
