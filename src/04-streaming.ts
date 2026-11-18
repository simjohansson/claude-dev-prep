/**
 * 04 – Streaming
 *
 * Det här ska du kunna:
 * - Streaming (SSE) ger lägre upplevd latens: visa text medan den genereras.
 * - Använd streaming för långa svar / höga max_tokens så att anslutningen inte tidsgränsas.
 * - Händelseordningen:
 *     message_start → (content_block_start → content_block_delta* → content_block_stop)*
 *     → message_delta (stop_reason + slutlig usage) → message_stop
 *   samt eventuella `ping` och `error`-händelser.
 * - Delta-typer: text_delta, input_json_delta (verktygsinput), thinking_delta, signature_delta.
 * - SDK-hjälparen `messages.stream()` samlar ihop allt till ett färdigt Message.
 */
import { anthropic, MODEL, printUsage, heading } from "./lib/client.js";

heading("A) Högnivå: messages.stream() med händelsehanterare");

const stream = anthropic.messages
  .stream({
    model: MODEL,
    // Thinking-tokens räknas mot max_tokens. Är taket för lågt kan resonemanget äta upp
    // allt och svaret blir tomt med stop_reason "max_tokens".
    max_tokens: 4096,
    // Låg effort → mindre thinking för en enkel uppgift.
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Skriv en kort dikt (4 rader) om TypeScript på svenska." }],
  })
  .on("thinking", () => process.stdout.write("."))
  .on("text", (delta) => process.stdout.write(delta));

// finalMessage() väntar in hela strömmen och returnerar ett vanligt Message-objekt.
const final = await stream.finalMessage();
console.log("\n");
printUsage(final);
if (final.stop_reason === "max_tokens") console.log("Svaret klipptes – höj max_tokens eller sänk effort.");

heading("B) Lågnivå: create({ stream: true }) och råa händelser");

const raw = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  output_config: { effort: "low" },
  stream: true,
  messages: [{ role: "user", content: "Räkna från 1 till 5 med ord." }],
});

const counts: Record<string, number> = {};
for await (const event of raw) {
  counts[event.type] = (counts[event.type] ?? 0) + 1;

  switch (event.type) {
    case "message_start":
      console.log(`message_start  (input_tokens=${event.message.usage.input_tokens})`);
      break;
    case "content_block_start":
      console.log(`content_block_start  index=${event.index} type=${event.content_block.type}`);
      break;
    case "content_block_delta":
      if (event.delta.type === "text_delta") process.stdout.write(event.delta.text);
      // thinking_delta (resonemang) och signature_delta (krypterad signatur) skrivs inte ut här.
      break;
    case "content_block_stop":
      console.log(`\ncontent_block_stop  index=${event.index}`);
      break;
    case "message_delta":
      // stop_reason och slutligt antal output-tokens kommer först här.
      console.log(`message_delta  stop_reason=${event.delta.stop_reason} output_tokens=${event.usage.output_tokens}`);
      break;
    case "message_stop":
      console.log("message_stop");
      break;
  }
}
console.log("\nAntal händelser per typ:", counts);
