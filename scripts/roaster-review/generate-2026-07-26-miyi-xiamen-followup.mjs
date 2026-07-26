import { mkdirSync, writeFileSync } from "node:fs";

const batchId = "2026-07-26-miyi-xiamen-followup";
const outputPath = `review-previews/roaster-candidate-review-${batchId}.html`;

const card = {
  card: 6,
  cluster_id: "5d612238-4ade-4fae-bcb3-fb7f76b77517",
  title: "Miyi Coffee Roasters",
  candidate_count: 1,
  occurrences: 1,
  recommendation: "approve create",
  confidence:
    "High identity and location confidence. The official domain and auction evidence identify MIYI / 弥翼, while Chinese industry coverage and a current roasted-coffee production licence connect the same operator and company to Xiamen.",
  logo: "https://miyiroasters.com/favicon-512x512.png",
  logo_quality: "official site 512px logo",
  payload: {
    roaster_name: "MIYI Coffee Roasters Co.",
    roaster_logo_url: "https://miyiroasters.com/favicon-512x512.png",
    roaster_website_url: "https://miyiroasters.com/",
    aliases: "Miyi Coffee,弥翼MIYI COFFEE ROASTERS",
    city: "Xiamen",
    state: "",
    country: "China",
    address_text:
      "5F, No. 65 Fangtang Community, Tiantou Village, Guankou Town, Jimei District, Xiamen, China",
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
    "The official site identifies MIYI Coffee Roasters Co. as a specialty micro-roaster and supplies the accepted 512px logo.",
    "Bean cross-search for “Miyi Coffee Roasters” + “Embu Kamavindi Estate” resolves the official MIYI domain, although the exact Kamavindi product page is no longer indexed.",
    "The single Chinese-language app review is for Embu Kamavindi Estate and contains tasting notes only; it is not being used as location proof.",
    "A 2019 Yunnan coffee-industry report names Chen Yanjie as the operator of MIYI COFFEE ROASTERS / 弥翼咖啡 and general manager of Xiamen Meiyi Trading Co., Ltd.",
    "A roasted-coffee production licence for the same company and operator was issued on 9 December 2024 and is valid through 8 December 2029 at the proposed Xiamen production address.",
    "Lamastus auction records independently use the exact bilingual identity 弥翼MIYI COFFEE ROASTERS.",
  ],
  sources: [
    ["Official roaster site", "https://miyiroasters.com/"],
    [
      "Chinese industry identity evidence",
      "https://m.yunnan.cn/system/2019/03/13/030223715.shtml",
    ],
    [
      "Current roasted-coffee production licence listing",
      "https://www.foodsc.net/sc/171382.html",
    ],
    [
      "Bilingual auction identity evidence",
      "https://lamastusfamilyestates.auction/auction-2023",
    ],
  ],
  duplicate:
    "Fresh check immediately before rendering: no current coffee_roasters exact name, alias, miyiroasters.com domain, Xiamen location, or meaningful fuzzy-identity match. Mae, Mel, and MABÓ are unrelated fuzzy-name results. No within-batch collision.",
  notes:
    "The official site’s continental-USA shipping language is not treated as operating-location evidence. The Xiamen location comes from the brand/operator link plus the current production licence. Non-US state remains blank.",
};

mkdirSync("review-previews", { recursive: true });
writeFileSync(outputPath, render(card));
console.log(outputPath);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render(item) {
  const storageKey = `roaster-review-${batchId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Miyi Coffee Roasters — Xiamen follow-up review</title>
<style>
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f4f1ea; color: #18201b; }
main { width: min(1080px, calc(100% - 32px)); margin: 32px auto 72px; }
.hero, .card, .handoff { background: #fffdf8; border: 1px solid #d9d4c8; border-radius: 18px; box-shadow: 0 12px 32px rgba(37, 45, 39, .08); }
.hero { padding: 28px; margin-bottom: 22px; }
.hero h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 46px); line-height: 1; }
.hero p { margin: 8px 0 0; color: #5b665f; line-height: 1.55; }
.summary { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.badge { display: inline-flex; padding: 7px 11px; border-radius: 999px; background: #e2f4e7; color: #14602e; font-size: 13px; font-weight: 750; }
.card { padding: 24px; }
.card-head { display: grid; grid-template-columns: 104px 1fr; gap: 20px; align-items: center; }
.logo { width: 104px; height: 104px; border-radius: 18px; border: 1px solid #d8ddd9; object-fit: contain; background: #fff; }
h2 { margin: 0 0 8px; font-size: 30px; }
h3 { margin: 24px 0 10px; font-size: 17px; }
.meta, .muted { color: #637069; }
.recommendation { color: #12632e; font-weight: 800; }
.confidence { margin-top: 9px; line-height: 1.55; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.panel { padding: 16px; background: #f7f5ef; border: 1px solid #e3ded2; border-radius: 14px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
ul { margin: 0; padding-left: 20px; }
li { margin: 8px 0; line-height: 1.5; }
a { color: #155b3c; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
button { border: 1px solid #aeb8b1; border-radius: 10px; padding: 9px 12px; background: #fff; color: #233028; cursor: pointer; font-weight: 700; }
button:hover { border-color: #386b4a; background: #edf7ef; }
label { display: block; margin: 12px 0 6px; font-weight: 750; }
textarea, input { width: 100%; border: 1px solid #bfc7c1; border-radius: 10px; padding: 11px; background: #fff; color: #172019; font: inherit; }
textarea { min-height: 92px; resize: vertical; }
.handoff { margin-top: 22px; padding: 24px; position: static; }
.handoff pre { min-height: 220px; max-height: 480px; overflow: auto; padding: 14px; border-radius: 12px; background: #17231b; color: #e6f6e9; }
.handoff-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
#status { min-height: 22px; margin-top: 10px; color: #476052; }
@media (max-width: 760px) {
  .grid { grid-template-columns: 1fr; }
  .card-head { grid-template-columns: 76px 1fr; }
  .logo { width: 76px; height: 76px; }
}
</style>
</head>
<body>
<main>
  <section class="hero">
    <h1>Miyi Xiamen follow-up</h1>
    <p>Revised single-card review after the Chinese-language evidence prompted a deeper location check. No Miyi database write has been made.</p>
    <div class="summary">
      <span class="badge">1 card</span>
      <span class="badge">approve create</span>
      <span class="badge">Xiamen · China</span>
    </div>
  </section>

  <section class="card" data-card="${item.card}" data-cluster-id="${item.cluster_id}" data-title="${esc(item.title)}" data-recommendation="${item.recommendation}">
    <div class="card-head">
      <img class="logo" src="${esc(item.logo)}" alt="${esc(item.title)} logo">
      <div>
        <div class="meta">Card ${item.card} · cluster ${item.cluster_id}</div>
        <h2>${esc(item.title)}</h2>
        <div class="recommendation">${esc(item.recommendation)}</div>
        <div class="confidence">${esc(item.confidence)}</div>
      </div>
    </div>

    <div class="grid">
      <section>
        <h3>Proposed executable payload</h3>
        <div class="panel"><pre>${esc(JSON.stringify(item.payload, null, 2))}</pre></div>
      </section>
      <section>
        <h3>Candidate row</h3>
        <div class="panel"><pre>${esc(JSON.stringify(item.rows, null, 2))}</pre></div>
      </section>
    </div>

    <h3>Evidence</h3>
    <ul>${item.evidence.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul>

    <h3>Sources</h3>
    <ul>${item.sources.map(([label, url]) => `<li><a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label)}</a></li>`).join("")}</ul>

    <h3>Duplicate check</h3>
    <div class="panel">${esc(item.duplicate)}</div>

    <h3>Agent notes</h3>
    <div class="panel">${esc(item.notes)}</div>

    <h3>Reviewer action</h3>
    <div class="actions">
      ${["approve create", "approve alias", "complete existing", "re-enrich", "reject"]
        .map((action) => `<button type="button" data-action="${action}" data-card="${item.card}">${action}</button>`)
        .join("")}
    </div>
    <label for="comment-${item.card}">Reviewer comment</label>
    <textarea id="comment-${item.card}" data-comment="${item.card}" placeholder="Add an action or exact field notes for card ${item.card}"></textarea>
    <label for="logo-${item.card}">Logo override</label>
    <input id="logo-${item.card}" type="url" data-logo-override="${item.card}" placeholder="https://example.com/logo.png">
  </section>

  <section class="handoff">
    <h2>Review JSON</h2>
    <p class="muted">This updates immediately and is the approval handoff.</p>
    <pre id="review-json"></pre>
    <div class="handoff-actions">
      <button type="button" id="copy-json">Copy comments JSON</button>
      <button type="button" id="download-json">Download comments JSON</button>
      <button type="button" id="clear-json">Clear saved review inputs</button>
    </div>
    <div id="status" aria-live="polite"></div>
  </section>
</main>
<script>
const storageKey=${JSON.stringify(storageKey)};
const cards=[${JSON.stringify({
    card: item.card,
    cluster_id: item.cluster_id,
    title: item.title,
    recommendation: item.recommendation,
  })}];

function readSaved() {
  try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); }
  catch { return {}; }
}

function collect() {
  return Object.fromEntries(cards.map((card) => [String(card.card), {
    card: card.card,
    cluster_id: card.cluster_id,
    title: card.title,
    recommendation: card.recommendation,
    comment: document.querySelector('[data-comment="'+card.card+'"]').value,
    logo_override: document.querySelector('[data-logo-override="'+card.card+'"]').value,
  }]));
}

function renderJson() {
  const value=collect();
  document.querySelector("#review-json").textContent=JSON.stringify(value,null,2);
  localStorage.setItem(storageKey,JSON.stringify(value));
}

const saved=readSaved();
for (const card of cards) {
  const row=saved[String(card.card)] || {};
  document.querySelector('[data-comment="'+card.card+'"]').value=row.comment || "";
  document.querySelector('[data-logo-override="'+card.card+'"]').value=row.logo_override || "";
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector('[data-comment="'+button.dataset.card+'"]').value=button.dataset.action;
    renderJson();
  });
});
document.querySelectorAll("[data-comment],[data-logo-override]").forEach((input) => input.addEventListener("input",renderJson));

document.querySelector("#copy-json").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#review-json").textContent);
    document.querySelector("#status").textContent="Copied review JSON.";
  } catch {
    document.querySelector("#status").textContent="Clipboard unavailable; select the visible JSON manually.";
  }
});

document.querySelector("#download-json").addEventListener("click", () => {
  const blob=new Blob([document.querySelector("#review-json").textContent],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download="miyi-xiamen-review.json";
  link.click();
  URL.revokeObjectURL(link.href);
  document.querySelector("#status").textContent="Downloaded review JSON.";
});

document.querySelector("#clear-json").addEventListener("click", () => {
  if (!confirm("Clear saved Miyi review inputs?")) return;
  localStorage.removeItem(storageKey);
  document.querySelectorAll("[data-comment],[data-logo-override]").forEach((input) => { input.value=""; });
  renderJson();
  document.querySelector("#status").textContent="Cleared saved review inputs.";
});

renderJson();
</script>
</body>
</html>`;
}
