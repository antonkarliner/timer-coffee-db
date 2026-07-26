import { mkdirSync, writeFileSync } from "node:fs";

const batchId = "2026-07-26-six-named";
const outputPath = `review-previews/roaster-candidate-review-${batchId}.html`;
const coffeeBaseLogo =
  "https://scontent-cdg6-1.xx.fbcdn.net/v/t39.30808-1/304874900_743427910080765_5816070470524581162_n.png?stp=dst-png&cstp=mx303x303&ctp=s200x200&_nc_cat=103&ccb=1-7&_nc_sid=f907e8&_nc_ohc=KgUKCzwAx58Q7kNvwERMnPr&_nc_oc=Ado-HM29nQr5JW7Q3mGgtWjvBBhMciz7s0pXdHxiV94YuFZIttE4EcF8hzV-AQL_4u59xsjhN_-eSn25SHN3Tw2o&_nc_zt=24&_nc_ht=scontent-cdg6-1.xx&_nc_gid=mD_nxPHKlDyHgN5lKYIIUw&_nc_ss=7b289&oh=00_AQB5blcx_gYn4_1tek2FBHd6J3bShwYlj3P6Y2eu-4NZCA&oe=6A6B2B60";

const cards = [
  {
    card: 1,
    cluster_id: "eed9a571-f854-48a4-b482-01fff2ba68b5",
    title: "Coffee Base",
    candidate_count: 1,
    occurrences: 1,
    recommendation: "approve create",
    confidence:
      "High identity confidence. The raw Meguro location resolves to Coffee Base MEGURO, while the official Coffee Base KANONDO site confirms the Kyoto-based company self-roasts and wholesales specialty coffee.",
    logo: coffeeBaseLogo,
    logo_quality: "official Facebook profile image",
    payload: {
      roaster_name: "Coffee Base",
      roaster_logo_url: coffeeBaseLogo,
      roaster_website_url: "https://www.kanondo.coffee/",
      aliases: "Coffee Base KANONDO,COFFEE BASE MEGURO",
      city: "Kyoto",
      state: "",
      country: "Japan",
      address_text: "466 Kanondocho, Nakagyo Ward, Kyoto 604-8222, Japan",
    },
    rows: [
      {
        id: 4472,
        roaster: "Coffee Base",
        coffee_bean_name: ".et Yirgacheffe G1 Amederaroo",
        location:
          "COFFEE BASE, Meguro-dori, Meguro 2-chome, Meguro City, Tokyo 153-0063, Japan",
        processed: false,
      },
    ],
    evidence: [
      "Latest enrichment job 3131 is done; no active re-enrichment job.",
      "Bean cross-search: the exact Amederaroo string did not resolve, but the official roaster site lists an Ethiopia Yirgacheffe G1 offering and states that Coffee Base roasts its own beans.",
      "The raw address matches COFFEE BASE MEGURO. Independent Japanese sources describe it as a Kyoto-origin, self-roasting specialty coffee shop.",
      "Official company information identifies 株式会社COFFEE BASE in Kyoto and links kanondo.coffee.",
    ],
    sources: [
      ["Official roaster site", "https://www.kanondo.coffee/"],
      ["Official company record", "https://coffeebase.i16.bcart.jp/corporate.php"],
      ["Raw-location corroboration", "https://tabelog.com/en/tokyo/A1316/A131601/13283680/"],
      ["Official Facebook profile", "https://www.facebook.com/coffeebasekanondo"],
    ],
    duplicate:
      "Fresh check: no current coffee_roasters name, alias, or kanondo.coffee domain match. Basecamp Coffee Co (id 77) was considered and rejected as an unrelated Maryland roaster. No within-batch collision.",
    notes:
      "Use the official social profile image as the executable logo; the official-site OGP is a page screenshot and was rejected as a logo. Non-US state remains blank.",
  },
  {
    card: 2,
    cluster_id: "244c1c48-e23e-4d3a-9ced-36429afca9cf",
    title: "Cafe Boa Vista",
    candidate_count: 1,
    occurrences: 1,
    recommendation: "approve create",
    confidence:
      "High identity confidence after correcting contaminated enrichment. Emília Ferraz is tied to Fazenda Boa Vista do Anil / Café Anil in Dom Viçoso, Brazil—not boavistacaffe.com or the mapped Portuguese café.",
    logo:
      "https://www.boavistadoanil.com.br/wp-content/uploads/2023/10/anil-header-logo-light@2x.png",
    logo_quality: "official site logo",
    payload: {
      roaster_name: "Café Anil",
      roaster_logo_url:
        "https://www.boavistadoanil.com.br/wp-content/uploads/2023/10/anil-header-logo-light@2x.png",
      roaster_website_url: "https://www.boavistadoanil.com.br/",
      aliases: "Fazenda Boa Vista do Anil,Boa Vista do Anil,Cafe Boa Vista",
      city: "Dom Viçoso",
      state: "",
      country: "Brazil",
      address_text: "Fazenda Boa Vista, Zona Rural, Dom Viçoso, MG 37474-000, Brazil",
    },
    rows: [
      {
        id: 3010,
        roaster: "Cafe Boa Vista",
        coffee_bean_name: "Emilia Ferraz",
        location:
          "Café Boa Vista, São Mamede de Ribatua, Alijó, Vila Real 5070-477, Portugal",
        processed: false,
      },
    ],
    evidence: [
      "Latest enrichment job 1657 is done; no active re-enrichment job.",
      "Bean cross-search: Emília Ferraz is the producer/CEO associated with Fazenda Boa Vista do Anil in Dom Viçoso, Minas Gerais.",
      "The official site sells roasted coffee under Café Anil Ltda and gives the Dom Viçoso farm address.",
      "The prior boavistacaffe.com proposition and Portugal location are unrelated entities and were discarded.",
    ],
    sources: [
      ["Official site", "https://www.boavistadoanil.com.br/"],
      ["Official shop contact", "https://loja.boavistadoanil.com.br/contato/"],
      ["Bean/producer corroboration", "https://agendavivasp.com.br/cultural-events/event/69a82beff81d30e16be2107a"],
      ["Producer catalog", "https://click.apexbrasil.com.br/mkt/exportamais/2025/specialty-coffee-prod.pdf"],
    ],
    duplicate:
      "Fresh check: no current coffee_roasters name, alias, or boavistadoanil.com.br domain match. Similar Cafe Pista records are unrelated. No within-batch collision.",
    notes:
      "Canonical brand uses Café Anil; the candidate spelling is retained as an alias. The official header logo was visually checked. Non-US state remains blank.",
  },
  {
    card: 3,
    cluster_id: "23dc8fac-27d3-4c97-ab33-625fac2ec3f5",
    title: "Play Coffee",
    candidate_count: 3,
    occurrences: 3,
    recommendation: "hold / re-enrich",
    confidence:
      "Material identity conflict. The cluster combines candidate locations in Seoul and Fullerton with a genuine but separate Play Coffee Roasters business in Sydney.",
    logo: "",
    logo_quality: "no single executable logo accepted because the cluster identity is unresolved",
    payload: {
      roaster_name: "Play Coffee",
      roaster_logo_url: "",
      roaster_website_url: "",
      aliases: "",
      city: "",
      state: "",
      country: "",
      address_text: "",
    },
    rows: [
      {
        id: 1739,
        roaster: "Play Coffee",
        coffee_bean_name: "Wilton Benitez Yellow Bourbon Washed",
        location: "Play Coffee, Seongbuk-gu, Seoul 02837, South Korea",
        processed: true,
      },
      {
        id: 1929,
        roaster: "Play Coffee",
        coffee_bean_name: "Odako",
        location: "128 W Commonwealth Ave, Fullerton, California 92832, USA",
        processed: true,
      },
      {
        id: 4528,
        roaster: "Play Coffee",
        coffee_bean_name: "Hamasho",
        location: "Play Coffee, Seongbuk-gu, Seoul 02837, South Korea",
        processed: false,
      },
    ],
    evidence: [
      "Cluster is already marked rejected; latest job 3203 failed at triage and is not active.",
      "Bean cross-search: playcoffee.online has a Wilton Benitez product and identifies itself as Play Coffee Roasters in Sydney.",
      "The Fullerton/Orange Play Coffee is independently described as a multi-roaster café that showcases other roasters rather than roasting itself.",
      "Hamasho and Odako searches did not connect the Korean and Californian candidate rows to the Sydney roaster.",
    ],
    sources: [
      ["Possible Sydney roaster", "https://www.playcoffee.online/"],
      ["Wilton Benitez product", "https://www.playcoffee.online/product/wilton-benitez-colombia-dual-anaerobic-thermal-shock-sidra-100g/SMZ4Z7NGSP5GDMLB3TMRTZW2"],
      ["Fullerton multi-roaster evidence", "https://orangereview.com/public/article/807/play-coffee"],
      ["Sydney business corroboration", "https://www.myhoju.com.au/cmboards/?ac=sd&kz=17f8d1cc4519&tCBsBA="],
    ],
    duplicate:
      "Fresh check: no exact current coffee_roasters name, alias, playcoffee.online domain match, or within-batch collision. Playground Coffee Roasters (id 752) is only a fuzzy-name near match and is unrelated.",
    notes:
      "Do not create from this merged cluster. Split or disambiguate rows by location/entity before deciding whether the Sydney roaster deserves its own cluster.",
    re_enrich_reason: "ambiguous_identity",
    re_enrich_notes:
      "Separate the Seoul, Fullerton, and Sydney entities. playcoffee.online is a Sydney roaster and carries Wilton Benitez; Fullerton Play Coffee is a multi-roaster cafe. Hamasho/Odako searches did not resolve the Korean rows.",
  },
  {
    card: 4,
    cluster_id: "88e6197a-7ef6-444f-ab2c-2875d4b74b77",
    title: "Pique Coffee",
    candidate_count: 1,
    occurrences: 1,
    recommendation: "approve create",
    confidence:
      "High identity confidence. The exact Alaka bean is on Pique Coffee’s official site, and the official contact page confirms the Wembley address.",
    logo:
      "https://pique.coffee/cdn/shop/files/PIQUE_logo_white_53ac9465-aa4c-40d2-bebf-3a9763a08fed_600x.png?v=1621227082",
    logo_quality: "official site wordmark",
    logo_dark: true,
    payload: {
      roaster_name: "Pique Coffee",
      roaster_logo_url:
        "https://pique.coffee/cdn/shop/files/PIQUE_logo_white_53ac9465-aa4c-40d2-bebf-3a9763a08fed_600x.png?v=1621227082",
      roaster_website_url: "https://pique.coffee/",
      aliases: "",
      city: "Wembley",
      state: "",
      country: "Australia",
      address_text: "48 Grantham Street, Wembley WA 6014, Australia",
    },
    rows: [
      {
        id: 3467,
        roaster: "Pique Coffee",
        coffee_bean_name: "Alaka",
        location: "Pique Coffee, Grantham Street, Wembley, Western Australia 6014, Australia",
        processed: false,
      },
    ],
    evidence: [
      "Latest enrichment job 2048 is done; no active re-enrichment job.",
      "Bean cross-search: the official site has ETHIOPIA | Alaka and a Perth retailer independently attributes the same coffee to Pique Coffee.",
      "Official contact page gives 48 Grantham Street, Wembley WA 6014 and ABN 71 647 464 702.",
      "piquelife.com is an unrelated brand and was discarded.",
    ],
    sources: [
      ["Official site", "https://pique.coffee/"],
      ["Exact bean page", "https://pique.coffee/products/so_ethiopia_9"],
      ["Official contact", "https://pique.coffee/pages/contact"],
      ["Independent bean corroboration", "https://perthcoffeeexchange.com.au/products/pique-coffee-ethiopia-alaka-single-origin"],
    ],
    duplicate:
      "Fresh check: no current coffee_roasters name, alias, or pique.coffee domain match. Pilot and Picacho were fuzzy-name near matches only. No within-batch collision.",
    notes:
      "The official wordmark is white/transparent and is rendered on a dark tile in this preview. Non-US state remains blank.",
  },
  {
    card: 5,
    cluster_id: "a18bbd4f-4ad6-4e96-a5e8-1cacc9fb9f7d",
    title: "Swel",
    candidate_count: 1,
    occurrences: 1,
    recommendation: "approve alias",
    confidence:
      "High confidence typo match to existing Swerl (roaster id 318). The exact Casa Almeida Barreto coffee is attributed to Swerl, and the official roaster is based in Falkenberg.",
    logo:
      "https://mprokbemdullwezwwscn.supabase.co/storage/v1/object/public/roaster_logo_mirrors/318_swerl.webp",
    logo_quality: "existing mirrored roaster logo",
    payload: {
      target_roaster_id: 318,
      target_roaster_name: "Swerl",
      action: "add_alias_then_processed_as_alias",
      alias_to_add: "Swel",
      resulting_aliases: "Swerl Coffee Roasters,Swel",
      row_changes: "aliases only",
    },
    rows: [
      {
        id: 4595,
        roaster: "Swel",
        coffee_bean_name: "Casa Almeida Barreto Filter",
        location: "17382 Coastal Highway, Lewes, Delaware 19958, USA",
        processed: false,
      },
    ],
    evidence: [
      "Latest job 3269 failed at summary and is not active.",
      "Bean cross-search: Swerl’s Casa Almeida Barreto product is independently indexed with matching producer/roast details.",
      "Existing roaster 318 is Swerl, Falkenberg, Sweden, with alias “Swerl Coffee Roasters.”",
      "The Delaware geocoded location and Seattle restaurant enrichment are unrelated and were discarded.",
    ],
    sources: [
      ["Official Swerl site", "https://swerl.se/"],
      ["Exact bean corroboration", "https://every.coffee/roaster/swerl/odd-b-casa-almeida-barreto-espresso-brazil"],
      ["Producer corroboration", "https://www.frukt.coffee/products/casa-almeida-barreto-brazil"],
    ],
    duplicate:
      "Fresh check: exact existing match is Swerl, id 318. “Swel” is not already present in its aliases and is useful. Final verdict: add alias; do not create. No within-batch collision.",
    notes:
      "Execution should update only the existing aliases string, then mark this candidate cluster processed_as_alias against roaster 318.",
  },
  {
    card: 6,
    cluster_id: "5d612238-4ade-4fae-bcb3-fb7f76b77517",
    title: "Miyi Coffee Roasters",
    candidate_count: 1,
    occurrences: 1,
    recommendation: "hold / re-enrich",
    confidence:
      "Identity, website, and logo are verified, but no reliable city-level operating location was found. The create payload is therefore not location-complete.",
    logo: "https://miyiroasters.com/favicon-512x512.png",
    logo_quality: "official site logo",
    payload: {
      roaster_name: "MIYI Coffee Roasters Co.",
      roaster_logo_url: "https://miyiroasters.com/favicon-512x512.png",
      roaster_website_url: "https://miyiroasters.com/",
      aliases: "Miyi Coffee,弥翼MIYI COFFEE ROASTERS",
      city: "",
      state: "",
      country: "",
      address_text: "",
    },
    rows: [
      {
        id: 4539,
        roaster: "Miyi Coffee Roasters",
        coffee_bean_name: "Embu Kamavindi Estate",
        location: "",
        processed: false,
      },
    ],
    evidence: [
      "Latest enrichment job 3212 is done; no active re-enrichment job.",
      "Bean cross-search did not surface the exact Embu Kamavindi listing, but the official domain clearly identifies MIYI as a specialty micro-roaster.",
      "Official site sells in the continental USA and provides info@miyiroasters.com, but no city/address was found on current contact or policy surfaces.",
      "The official 512px logo was fetched and visually verified.",
    ],
    sources: [
      ["Official site", "https://miyiroasters.com/"],
      ["Auction identity corroboration", "https://lamastusfamilyestates.auction/auction-2023"],
    ],
    duplicate:
      "Fresh check: no current coffee_roasters name, alias, or miyiroasters.com domain match. Mae and Mel Coffee Roasters were fuzzy-name near matches only. No within-batch collision.",
    notes:
      "A reviewer may explicitly approve a no-location create, but the default workflow requires verified city and country.",
    re_enrich_reason: "other",
    re_enrich_notes:
      "Identity is verified at miyiroasters.com and the official 512px logo is usable. Find the operating city/country from an official business registration, contact page, or verified social profile; do not infer it only from continental-USA shipping.",
  },
];

mkdirSync("review-previews", { recursive: true });
writeFileSync(outputPath, render(cards));
console.log(outputPath);

function render(items) {
  const counts = items.reduce((result, card) => {
    result[card.recommendation] = (result[card.recommendation] || 0) + 1;
    return result;
  }, {});

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roaster Candidate Review — ${batchId}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f4f0e8;color:#25221d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.48}
header{background:#25221d;color:#fff;padding:30px max(24px,calc((100vw - 1180px)/2))}
header h1{margin:0 0 7px;font-size:30px}.subtitle{max-width:900px;color:#ded7ca}
.summary{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.pill,.count{display:inline-block;border-radius:999px;padding:5px 9px;font-size:12px}
.pill{background:#fff;color:#27231e}.count{border:1px solid #d9d0bf;margin-left:6px;color:#5a5041}
main{max-width:1180px;margin:auto;padding:22px}
.card,.handoff{background:#fff;border:1px solid #d8cfbf;border-radius:12px;box-shadow:0 2px 10px #392e1f0d}
.card{padding:20px;margin:18px 0}.handoff{padding:18px;margin:24px 0}
.top{display:grid;grid-template-columns:106px 1fr;gap:18px;align-items:start}.logo-box{width:100px;height:100px;border:1px solid #ddd3c2;border-radius:9px;background:#f8f6f1;display:grid;place-items:center;overflow:hidden}.logo-box.dark{background:#24211d}.logo{width:92px;height:92px;object-fit:contain}
h2{margin:0 0 9px;font-size:23px}h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6c5940;margin:19px 0 8px}
.badge{display:inline-block;border-radius:7px;padding:5px 9px;font-size:12px;font-weight:750}.approve{background:#d9efdf;color:#1d5830}.hold{background:#f7dfb9;color:#734715}.alias{background:#d8e8f3;color:#234d68}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.muted{color:#6d655a;font-size:13px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#29251f;color:#f5f0e7;border-radius:8px;padding:13px;font-size:12px}
ul{margin:8px 0 0;padding-left:19px}li{margin:6px 0}
.sources{display:flex;gap:7px;flex-wrap:wrap}.sources a{color:#5d4527;background:#f7f1e7;border:1px solid #ded2bf;border-radius:999px;padding:6px 9px;text-decoration:none;font-size:12px}
.actions{display:flex;gap:7px;flex-wrap:wrap;margin:16px 0 9px}button{border:1px solid #a8967c;background:#fff;border-radius:7px;padding:8px 10px;cursor:pointer}button:hover{background:#eee5d7}
label{display:block;font-size:13px;font-weight:700;margin-top:11px}textarea,input[type=url]{width:100%;border:1px solid #cfc3b1;border-radius:7px;padding:10px;font:inherit;margin-top:5px}textarea{min-height:74px}
#jsonBox{min-height:370px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.status{font-size:13px;color:#5f513e;align-self:center}
@media(max-width:760px){main{padding:12px}.grid,.top{grid-template-columns:1fr}.logo-box{width:112px;height:112px}}
</style>
</head>
<body>
<header>
  <h1>Roaster Candidate Review</h1>
  <div class="subtitle">Generated 26 July 2026 for the six named clusters. Live database evidence, manual bean-name research, logo checks, and a fresh duplicate pass are included. No Supabase writes have been made.</div>
  <div class="summary">${Object.entries(counts)
    .map(([name, count]) => `<span class="pill">${escapeHtml(name)}: ${count}</span>`)
    .join("")}</div>
</header>
<main>
${items.map(renderCard).join("\n")}
<section class="handoff">
  <h2>Review handoff</h2>
  <p class="muted">Quick actions and logo overrides update this JSON immediately and persist in localStorage for this preview.</p>
  <div class="actions">
    <button id="copy" type="button">Copy comments JSON</button>
    <button id="download" type="button">Download comments JSON</button>
    <button id="clear" type="button">Clear saved review inputs</button>
    <span id="status" class="status"></span>
  </div>
  <textarea id="jsonBox" readonly></textarea>
</section>
</main>
<script>
const storageKey=${JSON.stringify(`roaster-review-${batchId}`)};
const cards=Array.from(document.querySelectorAll(".card")).map((node)=>({
  card:Number(node.dataset.card),
  cluster_id:node.dataset.clusterId,
  title:node.dataset.title,
  recommendation:node.dataset.recommendation
}));
let saved={};
try{saved=JSON.parse(localStorage.getItem(storageKey)||"{}")}catch(_){}
for(const card of cards){
  const row=saved[String(card.card)]||{};
  document.querySelector('[data-comment="'+card.card+'"]').value=row.comment||"";
  document.querySelector('[data-logo-override="'+card.card+'"]').value=row.logo_override||"";
}
function collect(){
  const out={};
  for(const card of cards){
    out[String(card.card)]={
      card:card.card,
      cluster_id:card.cluster_id,
      title:card.title,
      recommendation:card.recommendation,
      comment:document.querySelector('[data-comment="'+card.card+'"]').value,
      logo_override:document.querySelector('[data-logo-override="'+card.card+'"]').value
    };
  }
  return out;
}
function update(){
  const out=collect();
  try{localStorage.setItem(storageKey,JSON.stringify(out))}catch(_){}
  document.getElementById("jsonBox").value=JSON.stringify(out,null,2);
}
document.addEventListener("input",(event)=>{
  if(event.target.matches("textarea[data-comment],input[data-logo-override]"))update();
});
document.addEventListener("click",(event)=>{
  const button=event.target.closest("button[data-action]");
  if(!button)return;
  document.querySelector('[data-comment="'+button.dataset.card+'"]').value=button.dataset.action;
  update();
});
document.getElementById("copy").addEventListener("click",async()=>{
  const box=document.getElementById("jsonBox");
  try{await navigator.clipboard.writeText(box.value);status.textContent="Copied."}
  catch(_){box.focus();box.select();status.textContent="Clipboard blocked; JSON selected for manual copy."}
});
document.getElementById("download").addEventListener("click",()=>{
  const blob=new Blob([jsonBox.value],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download=${JSON.stringify(`roaster-candidate-review-${batchId}-comments.json`)};
  link.click();
  URL.revokeObjectURL(link.href);
  status.textContent="Downloaded.";
});
document.getElementById("clear").addEventListener("click",()=>{
  if(!confirm("Clear saved review inputs for this preview?"))return;
  localStorage.removeItem(storageKey);
  for(const input of document.querySelectorAll("textarea[data-comment],input[data-logo-override]"))input.value="";
  update();
});
update();
</script>
</body>
</html>`;
}

function renderCard(card) {
  const badgeClass = card.recommendation === "approve alias"
    ? "alias"
    : card.recommendation.startsWith("approve")
      ? "approve"
      : "hold";
  const logo = card.logo
    ? `<div class="logo-box${card.logo_dark ? " dark" : ""}"><img class="logo" src="${escapeHtml(card.logo)}" alt="${escapeHtml(card.title)} logo"></div>`
    : `<div class="logo-box"><span class="muted">No accepted logo</span></div>`;
  const payload = card.recommendation === "hold / re-enrich"
    ? { ...card.payload, re_enrich_reason: card.re_enrich_reason, re_enrich_notes: card.re_enrich_notes }
    : card.payload;
  return `<section class="card" data-card="${card.card}" data-cluster-id="${card.cluster_id}" data-title="${escapeHtml(card.title)}" data-recommendation="${escapeHtml(card.recommendation)}">
  <div class="top">
    ${logo}
    <div>
      <h2>${card.card}. ${escapeHtml(card.title)}</h2>
      <span class="badge ${badgeClass}">${escapeHtml(card.recommendation)}</span>
      <span class="count">candidate_count ${card.candidate_count}</span>
      <span class="count">occurrences ${card.occurrences}</span>
      <p>${escapeHtml(card.confidence)}</p>
      <p class="muted">Logo source quality: ${escapeHtml(card.logo_quality)}.</p>
    </div>
  </div>
  <div class="grid">
    <div>
      <h3>Proposed executable payload</h3>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
      <h3>Representative candidate rows</h3>
      <pre>${escapeHtml(JSON.stringify(card.rows, null, 2))}</pre>
    </div>
    <div>
      <h3>Evidence and bean-name cross-search</h3>
      <ul>${card.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      <h3>Collected sources</h3>
      <div class="sources">${card.sources
        .map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
        .join("")}</div>
      <h3>Final duplicate check</h3>
      <p>${escapeHtml(card.duplicate)}</p>
      <h3>Agent notes</h3>
      <p>${escapeHtml(card.notes)}</p>
    </div>
  </div>
  <div class="actions">
    ${["approve create", "approve alias", "complete existing", "re-enrich", "reject"]
      .map((action) => `<button type="button" data-action="${action}" data-card="${card.card}">${action}</button>`)
      .join("")}
  </div>
  <label>Reviewer comments
    <textarea data-comment="${card.card}" placeholder="Add an action or exact field notes for card ${card.card}"></textarea>
  </label>
  <label>Logo override
    <input type="url" data-logo-override="${card.card}" placeholder="https://example.com/logo.png">
  </label>
</section>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
