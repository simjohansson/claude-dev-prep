/**
 * 10 – Felhantering, omförsök och stop_reason
 *
 * Det här ska du kunna:
 * - HTTP-fel → typade undantag: 400 BadRequestError, 401 AuthenticationError,
 *   403 PermissionDeniedError, 404 NotFoundError, 413 för stor request,
 *   429 RateLimitError, 500 InternalServerError, 529 överbelastad (OverloadedError).
 * - 429 och 5xx/529 är tillfälliga → försök igen med exponentiell backoff
 *   (respektera retry-after). SDK:n gör detta automatiskt (maxRetries).
 * - 400/401/403/404 är permanenta → rätta requesten, försök inte igen.
 * - Logga request-id (`_request_id` / `error.requestID`) – behövs vid support.
 * - Ett lyckat HTTP-svar kan ändå vara "fel": kontrollera stop_reason
 *   (max_tokens = avklippt svar, refusal = avböjt).
 * - Timeout och maxRetries kan sättas per klient eller per anrop.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL, getText, heading, usingOpenRouter } from "./lib/client.js";

function describe(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return `429 rate limit – vänta ${err.headers?.get("retry-after") ?? "?"} s (request-id ${err.requestID})`;
  }
  if (err instanceof Anthropic.AuthenticationError) return "401 – kontrollera API-nyckeln";
  if (err instanceof Anthropic.NotFoundError) return `404 – fel modellnamn eller resurs (request-id ${err.requestID})`;
  if (err instanceof Anthropic.BadRequestError) return `400 – ogiltig request: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return `${err.status} – serverfel/överbelastning, försök igen senare`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "Timeout – öka timeout eller använd streaming";
  if (err instanceof Anthropic.APIConnectionError) return "Nätverksfel";
  if (err instanceof Anthropic.APIError) return `${err.status} – ${err.message}`;
  return String(err);
}

heading("1) Ogiltigt modellnamn → NotFoundError (404)");
try {
  await anthropic.messages.create({
    model: "claude-finns-inte",
    max_tokens: 10,
    messages: [{ role: "user", content: "Hej" }],
  });
} catch (err) {
  console.log(describe(err));
  if (usingOpenRouter && err instanceof Anthropic.BadRequestError) {
    console.log("(OpenRouter svarar 400 för okänd modell – Anthropics API svarar 404 not_found_error.)");
  }
}

heading("2) Ogiltig request → BadRequestError (400)");
try {
  await anthropic.messages.create({
    model: MODEL,
    max_tokens: 10,
    // Första meddelandet får inte vara tomt.
    messages: [{ role: "user", content: "" }],
  });
} catch (err) {
  console.log(describe(err));
}

heading("3) Inställningar per anrop: timeout och maxRetries");
try {
  await anthropic.messages.create(
    { model: MODEL, max_tokens: 2000, messages: [{ role: "user", content: "Skriv en lång essä om moln." }] },
    // Avsiktligt för kort timeout så att felet visas.
    { timeout: 500, maxRetries: 0 },
  );
} catch (err) {
  console.log(describe(err));
}

heading("4) HTTP 200 men avklippt svar: stop_reason = max_tokens");
const truncated = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 40,
  output_config: { effort: "low" },
  messages: [{ role: "user", content: "Lista alla Sveriges landskap med en mening om varje." }],
});
console.log(`request-id: ${truncated._request_id}`);
console.log(`stop_reason: ${truncated.stop_reason}`);
if (truncated.stop_reason === "max_tokens") {
  // Med thinking påslaget kan hela budgeten gå åt till resonemang → tomt delsvar.
  console.log("Svaret klipptes! Öka max_tokens, sänk effort, be om kortare svar eller fortsätt i en ny tur.");
  console.log(`Delsvar: ${getText(truncated)}`);
}

heading("5) Robust omslutning med egen backoff (utöver SDK:ns)");
async function withBackoff<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable =
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError;
      if (!retryable || attempt >= attempts) throw err;
      const delayMs = 2 ** attempt * 500 + Math.random() * 250;
      console.log(`Försök ${attempt} misslyckades (${describe(err)}), väntar ${Math.round(delayMs)} ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const ok = await withBackoff(() =>
  anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Säg OK." }],
  }),
);
console.log(getText(ok));
