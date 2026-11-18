/**
 * 12 – Message Batches API
 *
 * Det här ska du kunna:
 * - Batchar kör många Messages-requests asynkront till ca 50 % lägre kostnad.
 * - Passar när svar inte behövs direkt: utvärderingar (evals), klassificering av stora
 *   datamängder, innehållsgenerering. Inte för interaktiva/realtidsflöden.
 * - De flesta batchar blir klara inom en timme; de som inte är klara inom 24 h löper ut.
 * - Varje request har ett eget `custom_id` – resultaten kan komma i valfri ordning,
 *   så matcha på custom_id.
 * - Resultattyper: succeeded, errored, canceled, expired. Ett fel i en request
 *   påverkar inte de andra.
 * - Flöde: create → polla retrieve tills processing_status = "ended" → results().
 *
 * OpenRouter: har inte Anthropics /v1/messages/batches (SDK:ns messages.batches ger 404),
 * men ett eget Batch API (POST /api/v1/batches) som kan köra /v1/messages-bodies.
 * Annat format: requests[].body i stället för params, status "completed" i stället för
 * "ended", och resultaten ligger direkt i batch-objektet. Se runOpenRouterBatch nedan.
 */
import type { BatchCreateParams } from "@anthropic-ai/sdk/resources/messages/batches";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, FAST_MODEL, heading, usingOpenRouter } from "./lib/client.js";

const reviews = [
  "Fantastisk produkt, levererades snabbt!",
  "Gick sönder efter två dagar. Usel kvalitet.",
  "Den gör vad den ska, varken mer eller mindre.",
];

// Samma Messages-body oavsett om batchen körs hos Anthropic eller OpenRouter.
function buildParams(review: string): MessageCreateParamsNonStreaming {
  return {
    model: FAST_MODEL,
    max_tokens: 20,
    thinking: { type: "disabled" },
    system: "Klassificera recensionens sentiment. Svara med ett ord: positiv, negativ eller neutral.",
    messages: [{ role: "user", content: `<review>${review}</review>` }],
  };
}

if (usingOpenRouter) {
  await runOpenRouterBatch();
  process.exit(0);
}

const requests: BatchCreateParams.Request[] = reviews.map((review, i) => ({
  custom_id: `review-${i}`,
  params: buildParams(review),
}));

heading("Skapar batch");
let batch = await anthropic.messages.batches.create({ requests });
console.log(`id=${batch.id} status=${batch.processing_status}`);

heading("Väntar på resultat (pollar var 10:e sekund, max 15 min)");
const deadline = Date.now() + 15 * 60_000;
while (batch.processing_status !== "ended") {
  if (Date.now() > deadline) {
    console.log(`Inte klar än – hämta senare med batches.retrieve("${batch.id}").`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
  batch = await anthropic.messages.batches.retrieve(batch.id);
  const c = batch.request_counts;
  console.log(`status=${batch.processing_status} processing=${c.processing} succeeded=${c.succeeded} errored=${c.errored}`);
}

heading("Resultat");
for await (const item of await anthropic.messages.batches.results(batch.id)) {
  const review = reviews[Number(item.custom_id.split("-")[1])];
  switch (item.result.type) {
    case "succeeded": {
      const text = item.result.message.content.find((b) => b.type === "text");
      console.log(`${item.custom_id}: ${text?.type === "text" ? text.text.trim() : "?"}  ← "${review}"`);
      break;
    }
    case "errored":
      console.log(`${item.custom_id}: FEL ${JSON.stringify(item.result.error)}`);
      break;
    case "canceled":
    case "expired":
      console.log(`${item.custom_id}: ${item.result.type}`);
      break;
  }
}

// --- OpenRouter Batch API (https://openrouter.ai/docs/batch-quickstart) ---------------
// SDK:n saknar stöd för det här API:et, så vi anropar det med fetch.
interface OpenRouterBatch {
  id: string;
  status: "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "expired" | "cancelled";
  provider: string | null;
  request_counts: { total: number; completed: number; failed: number };
  usage: { cost: number } | null;
  error: { message: string } | null;
  results:
    | {
        custom_id: string;
        // För endpoint /v1/messages är body ett vanligt Anthropic Message-svar.
        response: { status_code: number; body: { content?: { type: string; text?: string }[] } } | null;
        error: { type: string; message: string } | null;
      }[]
    | null;
}

async function runOpenRouterBatch(): Promise<void> {
  const headers = { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
  const base = "https://openrouter.ai/api/v1/batches";

  heading("Skapar batch via OpenRouter");
  const createRes = await fetch(base, {
    method: "POST",
    headers,
    // OpenRouter läser bodyn som en ström: endpoint/model MÅSTE komma före requests, annars 400.
    body: JSON.stringify({
      endpoint: "/v1/messages",
      model: FAST_MODEL,
      requests: reviews.map((review, i) => ({ custom_id: `review-${i}`, body: buildParams(review) })),
    }),
  });
  if (createRes.status !== 202) {
    throw new Error(`Skapa batch misslyckades (${createRes.status}): ${await createRes.text()}`);
  }
  let batch = (await createRes.json()) as OpenRouterBatch;
  console.log(`id=${batch.id} status=${batch.status} provider=${batch.provider}`);

  heading("Väntar på resultat (pollar var 30:e sekund, max 15 min)");
  const final = new Set(["completed", "failed", "expired", "cancelled"]);
  const deadline = Date.now() + 15 * 60_000;
  // results kan vara null en kort stund efter att status blivit "completed".
  while (!final.has(batch.status) || (batch.status === "completed" && batch.results === null)) {
    if (Date.now() > deadline) {
      console.log(`Inte klar än – hämta senare med GET ${base}/${batch.id}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 30_000));
    const res = await fetch(`${base}/${batch.id}`, { headers });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) continue;
      throw new Error(`Polling misslyckades (${res.status}): ${await res.text()}`);
    }
    batch = (await res.json()) as OpenRouterBatch;
    const c = batch.request_counts;
    console.log(`status=${batch.status} completed=${c.completed} failed=${c.failed} total=${c.total}`);
  }

  if (batch.status !== "completed") {
    console.log(`Batchen avslutades som ${batch.status}: ${batch.error?.message ?? "-"}`);
    return;
  }

  heading("Resultat");
  for (const item of batch.results ?? []) {
    const review = reviews[Number(item.custom_id.split("-")[1])];
    if (item.error || !item.response) {
      console.log(`${item.custom_id}: FEL ${item.error?.message ?? "inget svar"}`);
      continue;
    }
    const text = item.response.body.content?.find((b) => b.type === "text")?.text;
    console.log(`${item.custom_id}: ${text?.trim() ?? "?"}  ← "${review}"`);
  }
  console.log(`\nprovider=${batch.provider} kostnad=$${batch.usage?.cost ?? "?"}`);
}
