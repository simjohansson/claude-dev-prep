/**
 * 03 – Promptteknik via API:et
 *
 * Det här ska du kunna:
 * - Systemprompt för roll, ton och regler.
 * - XML-taggar för att skilja instruktioner från data (minskar prompt injection
 *   och gör det tydligt vad som är vad).
 * - Few-shot/multishot: ge exempel på önskad in- och utdata.
 * - Be om ett bestämt utdataformat och använd stop_sequences för att stoppa.
 * - Välj en mindre/snabbare modell för enkla uppgifter (klassificering).
 * - Prefill (avsluta med ett assistant-meddelande) avvisas med 400 av Claude 4.6 och
 *   senare – använd structured outputs (06) för att styra formatet.
 */
import { anthropic, FAST_MODEL, MODEL, getText, printUsage, heading } from "./lib/client.js";

const tickets = [
  "Jag har blivit debiterad två gånger för samma order!",
  "Hur ändrar jag mitt lösenord?",
  "Appen kraschar varje gång jag öppnar kameran.",
];

heading("Klassificering med XML-taggar + few-shot (snabb modell)");

const classifierSystem = `Du klassificerar supportärenden i exakt en kategori:
BILLING, ACCOUNT eller BUG.

<examples>
<example>
<ticket>Mitt kort drogs fast jag avbröt köpet.</ticket>
<category>BILLING</category>
</example>
<example>
<ticket>Jag kommer inte in, kontot verkar låst.</ticket>
<category>ACCOUNT</category>
</example>
<example>
<ticket>Knappen "Spara" gör ingenting.</ticket>
<category>BUG</category>
</example>
</examples>

Svara ENDAST med <category>KATEGORI</category>.`;

for (const ticket of tickets) {
  const response = await anthropic.messages.create({
    model: FAST_MODEL,
    max_tokens: 50,
    // Enkel klassificering behöver inget resonemang. Haiku 5.5 tillåter att thinking
    // stängs av (Sonnet/Opus 5.5 gör det inte) – annars kan thinking äta upp de 50 tokens.
    thinking: { type: "disabled" },
    system: classifierSystem,
    // Användardata ligger inom taggar: modellen ska behandla det som data, inte instruktioner.
    messages: [{ role: "user", content: `<ticket>${ticket}</ticket>` }],
    // Stoppa direkt efter sluttaggen → mindre output, lättare att parsa.
    stop_sequences: ["</category>"],
  });

  const category = getText(response).replace("<category>", "").trim();
  console.log(`${category.padEnd(8)} ← ${ticket}  (stop_reason=${response.stop_reason})`);
}

heading("Strukturerad uppgift: be modellen tänka i taggar och svara i taggar");

const article = `Företaget X ökade sin omsättning med 12 % under Q3, främst tack vare
nya kunder i Norden. Samtidigt steg kostnaderna för molntjänster med 30 %.`;

const analysis = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  system: "Du är en finansanalytiker. Var saklig och koncis.",
  messages: [
    {
      role: "user",
      content: `Analysera rapporten nedan.

<report>
${article}
</report>

Instruktioner:
1. Lista de viktigaste siffrorna i <facts>.
2. Ge en risk i <risk>.
3. Ge en rekommendation i <recommendation>.`,
    },
  ],
});
console.log(getText(analysis));
printUsage(analysis);

heading("metadata.user_id: koppla anrop till en slutanvändare");

// Ett opakt id för slutanvändaren i din app (internt id eller hash – aldrig namn, e-post
// eller telefonnummer). Låter Anthropic upptäcka missbruk per användare i stället för
// att hela API-nyckeln drabbas. Fältet skickas bara till servern: det påverkar inte svaret
// och ekas inte tillbaka i det.
const endUserId = "user-7f3a2c";
const withMetadata = await anthropic.messages.create({
  model: FAST_MODEL,
  max_tokens: 20,
  thinking: { type: "disabled" },
  metadata: { user_id: endUserId },
  messages: [{ role: "user", content: "Säg hej." }],
});
console.log(`Skickade metadata.user_id="${endUserId}" → svar: ${getText(withMetadata)}`);
console.log(`Logga request-id tillsammans med ditt user-id för spårbarhet: ${withMetadata._request_id}`);
