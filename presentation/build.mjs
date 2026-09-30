// Each deck module writes its file when imported, so importing them in turn is the whole build.
const DECKS = ["full.en", "full.no", "simple.en"];

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !DECKS.includes(name));
if (unknown.length > 0) {
  process.stderr.write(`unknown deck: ${unknown.join(", ")} — choose from ${DECKS.join(", ")}\n`);
  process.exit(2);
}

for (const name of asked.length > 0 ? asked : DECKS) {
  await import(`./${name}.mjs`);
}
