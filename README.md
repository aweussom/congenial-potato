# dekk-tester

En søkbar indeks over nordiske dekktester. Første kilde: [Motor.no](https://www.motor.no/tag/dekktester/) (NAF), som siden 2019 lager testene sammen med svenske Vi Bilägare. Motor har testet dekk hvert år siden 2017, men artiklene ligger spredt over tags, seksjoner og år uten noen oversikt. Denne siden samler dem, og lar deg filtrere på det som faktisk betyr noe for deg.

## Hva er poenget?

Målet er å finne **rimelige dekk som er gode nok**, ikke å kåre en vinner.

- For **vinterdekk** (pigg og piggfritt) er bremselengde på is det som teller. Kjørefølelse, sidegrep og støy vektes ikke.
- For **sommerdekk** er bremselengde på våt asfalt det som teller.
- Testene har blitt strengere år for år. Et dekk som får 60 poeng i 2026 kan være like godt som testvinneren fra 2017, og det dekket *var* godt nok. Derfor viser siden målte meter og sekunder der de finnes, slik at år kan sammenlignes, og poeng bare som sekundær informasjon.

## Arkitektur

Samme grunnidé som [tabtabtab](https://github.com/aweussom/tabtabtab): all data ligger i én JSON-fil, nettsiden er statisk og fungerer offline. Men her er det lov å bruke CDN-biblioteker og Node.js der det gjør jobben lettere.

```
crawler/
  discover-tags.mjs   seeds: tag-sider -> crawler/seeds/motor-tags.json (ingen innlogging)
  crawl.mjs           henter artikkel-HTML via innlogget Chrome (chrome-devtools CLI) -> crawler/raw/
  parse.mjs           HTML -> strukturert JSON per artikkel -> crawler/parsed/
  build-catalog.mjs   parsed -> docs/data/catalog.json (tester, dekk, poeng, målinger)
docs/
  index.html, app.js, style.css, views/   statisk nettside, leser catalog.json
```

### Hvorfor en nettleser i crawleren?

Artiklene er bak NAFs betalingsmur. Den eneste sesjonen vi har er den brukeren har logget inn med i Chrome-vinduet som `chrome-devtools`-CLI-en styrer. Crawleren kjører `fetch()` *inne i* en motor.no-tab, så cookien følger med av seg selv. Ingen passord eller tokens berører repoet. Paywall-cookien er en sesjons-cookie, så innloggingen må gjøres på nytt hver gang Chrome startes.

### Hvordan finner vi artiklene?

Motor.no kjører Labrador CMS. Enhver tag-side gir hele artikkellisten som JSON om man legger på `?lab_viewport=json`, uten paginering og uten innlogging. Enkeltdekk-artiklene (én per dekk, med poeng per disiplin) er derimot ikke tagget, så crawleren følger lenker fra hovedartiklene i to runder. Lenker som går igjen på nesten alle sider (sidemeny, «siste nytt») filtreres bort på frekvens.

### Hvordan er resultatene kodet?

Tre typer artikler per test:

1. **Hovedartikkel** med metode, dimensjon, kort om hvert dekk og (fra 2019) en poengtabell for alle dekk og disipliner.
2. **Enkeltdekk-artikkel** med en «motortest»-widget: totalpoeng, poeng per disiplin (is/snø/våt/tørr, hver delt i akselerasjon, bremselengde og kjøreegenskaper), piggantall, gummihardhet, produksjonsdato.
3. **Detaljartikkel** («alle tall og delresultater») med målte verdier per disiplin: meter, sekunder, desibel.

## Kjøre selv

```sh
npm install                       # cheerio
npm i -g chrome-devtools-mcp      # nettleseren crawleren bruker
node crawler/discover-tags.mjs    # seeds
chrome-devtools new_page https://www.motor.no/   # logg inn i vinduet som åpnes
node crawler/crawl.mjs            # ca. 400 sider, noen minutter
node crawler/parse.mjs
node crawler/build-catalog.mjs
npx serve docs                    # eller åpne docs/index.html
```

Motor publiserer to tester i året (sommerdekk i mars, vinterdekk i september), så dette kjøres sjelden. Mens crawleren kjører bør ingen andre bruke `chrome-devtools`-CLI-en: den jobber alltid mot den *valgte* tab-en, og crawleren velger motor.no-tab-en før hver batch.

## Sjekk butikk: hvilke av dekkene i nettbutikken er testet?

Tre måter, samme matcher (`docs/match.js`):

1. **Lim inn.** Fanen «Sjekk butikk» på siden: marker alt på butikkens søkeresultat (Ctrl+A, Ctrl+C), lim inn. Produktnavn og pris plukkes ut linje for linje, og hvert produkt slås opp mot katalogen. Ingenting sendes noe sted.
2. **Bokmerke.** Et bokmerke-skript (finnes under «Sjekk butikk → hjelp») som åpner fanen med butikksidens tekst ferdig innlimt.
3. **Tampermonkey / Chrome-utvidelse.** `docs/dekktester-butikk.user.js` legger et merke ved hvert produkt hos dekkonline.com, thansen.no og dekk365.no: «Motor 2026 · is 10,8 m (+0 %) · 92 p», farget etter avstand til beste dekk i samme test, med lenke til raden på siden. Samme kode ligger som upakket utvidelse i `extension/` (chrome://extensions → Last inn upakket). Begge bygges fra `tools/annotator.js` + `docs/match.js` med `node tools/build-userscript.mjs`.

Matchingen normaliserer merke og modell til en kompakt nøkkel (bokstaver og tall, uten dimensjon, last-/hastighetsindeks, SUV/XL/EV og lignende), og godtar at butikken skriver «Ultra Grip» der Motor skriver «UltraGrip», eller «Goodride Z-506» der Motor skriver «IceMaster Spike Z-506». Varianter (SUV-utgaven er testet, butikken selger standardutgaven) merkes som variant.

Navnene i katalogen er kanonisert med en håndlaget tabell, `crawler/seeds/name-fixes.json`, fordi Motor staver samme dekk ulikt fra år til år. Ingen gjetting i kjøretid, ingen LLM: tabellen utvides for hånd når en ny testsesong gir nye skrivemåter.

## Hosting

Nettsiden ligger i `docs/` slik at GitHub Pages kan serve den rett fra `main`: Settings → Pages → «Deploy from a branch» → `main` / `/docs`. `docs/.nojekyll` skrur av Jekyll. Katalogen (`docs/data/catalog.json`, ca. 1 MB) er sjekket inn, så siden trenger ingen byggesteg.

Rå-HTML (`crawler/raw/`) og de parsede artiklene (`crawler/parsed/`) er ikke i repoet: kilden er bak betalingsmur. Katalogen inneholder bare tall (poeng, meter, sekunder), Motors énlinjes dom per dekk og pluss/minus-frasene, med lenke til artikkelen for resten.
