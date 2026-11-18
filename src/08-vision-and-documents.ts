/**
 * 08 – Bilder, PDF:er, dokument och citat
 *
 * Det här ska du kunna:
 * - Content kan vara en lista av block: text, image, document.
 * - Bildkällor: base64 (med media_type), url eller file_id (Files API).
 * - Lägg bilder/dokument FÖRE frågan i samma user-meddelande för bäst resultat.
 * - Dokument (PDF eller ren text) kan ha `citations: { enabled: true }` – då
 *   pekar svarets text-block ut exakt vilka avsnitt de bygger på.
 * - Bilder och dokument kostar tokens (beror på storlek/antal sidor).
 *
 * Kör med en egen bild: npm run ex:08 -- ./min-bild.png
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ContentBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { anthropic, MODEL, getText, printUsage, heading } from "./lib/client.js";

async function imageFromFile(path: string): Promise<ImageBlockParam> {
  const mediaTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as const;
  const mediaType = mediaTypes[extname(path).toLowerCase() as keyof typeof mediaTypes];
  if (!mediaType) throw new Error(`Bildformatet stöds inte: ${path}`);
  const data = (await readFile(path)).toString("base64");
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

heading("A) Bildanalys (vision)");

const localPath = process.argv[2];
const image: ImageBlockParam = localPath
  ? await imageFromFile(localPath)
  : {
      type: "image",
      source: {
        type: "url",
        url: "https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg",
      },
    };

const vision = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  messages: [
    {
      role: "user",
      content: [image, { type: "text", text: "Beskriv bilden i tre meningar på svenska." }],
    },
  ],
});
console.log(getText(vision));
printUsage(vision);

heading("B) Dokument med citat");

const policy = `Returpolicy för Butiken AB.
Varor kan returneras inom 30 dagar från leveransdatum.
Varan måste vara oanvänd och i originalförpackning.
Returfrakt betalas av kunden, utom när varan är defekt.
Återbetalning sker inom 14 dagar efter att returen mottagits.`;

const content: ContentBlockParam[] = [
  {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: policy },
    title: "Returpolicy",
    citations: { enabled: true },
  },
  { type: "text", text: "Min vara kom trasig. Måste jag betala returfrakten, och hur snabbt får jag pengarna?" },
];

const cited = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 4096,
  messages: [{ role: "user", content }],
});

// Med citat delas svaret upp i FLERA text-block: block som bygger på dokumentet har en
// `citations`-lista, mellanliggande text har citations = null.
let citationCount = 0;
for (const block of cited.content) {
  if (block.type !== "text") continue;
  process.stdout.write(block.text);
  for (const citation of block.citations ?? []) {
    citationCount++;
    const where =
      citation.type === "char_location" ? `tecken ${citation.start_char_index}-${citation.end_char_index}` : citation.type;
    process.stdout.write(` [källa ${citationCount}: "${citation.cited_text.trim()}" (${where})]`);
  }
}
console.log();
const textBlocks = cited.content.filter((b) => b.type === "text").length;
console.log(`\ntext-block: ${textBlocks}, citat: ${citationCount}`);
if (citationCount === 0) {
  console.log(
    "Inga citat returnerades. Vanliga orsaker: anropet gick via en gateway/provider som tar bort citat " +
      "(t.ex. OpenRouter utan Anthropic som provider), eller så valde modellen att inte citera.",
  );
}
printUsage(cited);
