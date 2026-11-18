/**
 * 06 – Strukturerad output (JSON)
 *
 * Det här ska du kunna:
 * - Structured outputs: `output_config.format` med ett JSON-schema garanterar att
 *   svaret följer schemat. SDK:ns `messages.parse()` + `zodOutputFormat()` validerar
 *   och ger ett typat `parsed_output`.
 * - Den klassiska tekniken: ett "extraktionsverktyg" + tool_choice som tvingar modellen
 *   att anropa verktyget → `tool_use.input` blir din JSON. Tvingad tool_choice avvisas
 *   av Opus/Sonnet 5.5 m.fl. – där är structured outputs (A) rätt väg.
 * - Validera alltid output i din kod och hantera stop_reason "max_tokens"/"refusal"
 *   (då kan JSON vara ofullständig eller saknas).
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, FAST_MODEL, printUsage, heading } from "./lib/client.js";

const email = `Hej! Jag heter Erik Svensson och beställde en kaffebryggare (order ORD-98765)
den 3 november. Den kom trasig och jag vill ha pengarna tillbaka så snart som möjligt.
Ni når mig på 070-123 45 67. Mycket besviken.`;

const Complaint = z.object({
  customer_name: z.string(),
  order_id: z.string().nullable(),
  product: z.string(),
  issue: z.string().describe("Kort beskrivning av problemet"),
  requested_action: z.enum(["refund", "replacement", "repair", "other"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  urgency: z.number().int().min(1).max(5),
});

heading("A) Structured outputs med messages.parse() + Zod");

const parsed = await anthropic.messages.parse({
  model: FAST_MODEL,
  max_tokens: 4096,
  system: "Extrahera uppgifter ur kundmejl.",
  messages: [{ role: "user", content: `<email>\n${email}\n</email>` }],
  output_config: { format: zodOutputFormat(Complaint) },
});

if (parsed.stop_reason !== "end_turn" || !parsed.parsed_output) {
  throw new Error(`Ingen giltig output (stop_reason=${parsed.stop_reason})`);
}
// parsed_output är typat som z.infer<typeof Complaint>.
const complaint = parsed.parsed_output;
console.log(complaint);
console.log("Åtgärd:", complaint.requested_action, "| Brådska:", complaint.urgency);
printUsage(parsed);

heading("B) Tvingat verktygsanrop som extraktionsmetod");

const response = await anthropic.messages.create({
  model: FAST_MODEL,
  max_tokens: 4096,
  tools: [
    {
      name: "record_complaint",
      description: "Spara ett strukturerat kundklagomål.",
      input_schema: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          product: { type: "string" },
          requested_action: { type: "string", enum: ["refund", "replacement", "repair", "other"] },
        },
        required: ["customer_name", "product", "requested_action"],
        additionalProperties: false,
      },
      strict: true,
    },
  ],
  tool_choice: { type: "tool", name: "record_complaint" },
  messages: [{ role: "user", content: `<email>\n${email}\n</email>` }],
});

const toolUse = response.content.find((b): b is ToolUseBlock => b.type === "tool_use");
// Vi kör inte "verktyget" – vi använder bara dess input som strukturerad data.
console.log(toolUse?.input);
printUsage(response);
