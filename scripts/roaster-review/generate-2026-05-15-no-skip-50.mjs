import { existsSync, readFileSync, writeFileSync } from "node:fs";

const generatedAt = "2026-05-15";
const outFile = "review-previews/roaster-candidate-review-2026-05-15-no-skip-confidence-selected50.html";
const sourceMapFile = "review-previews/roaster-candidate-review-2026-05-15-no-skip-sources.json";

const cards = [
  c(1, "a5a24d68-52d5-4b07-8323-d56911a78367", "イネマメ", 4, 4, "approve create", "Raw rows repeat the same Setagaya address and official/store/social evidence. Non-US state should be blanked in the executable payload.", p("イネマメ", "https://inemamecoffee.stores.style/common/design/user/img/template/tem-7/home-gray.png", "https://inemamecoffee.stores.style/", "Setagaya City", "", "Japan", "南烏山3-3-3, 世田谷区, 東京都, 1570062, JP"), ["Beans: エチオピア・モカ・イルガチェフ ブナブナ, ブラジルサントス, コロンビア ビジャファティマティピカ", "Domains checked: inemamecoffee.stores.style, tabelog.com, facebook.com, instagram.com"], "No exact name/domain/alias match found in coffee_roasters.", "Official storefront logo-like PNG; reviewer should sanity-check because stores.style can use template assets."),
  c(2, "c822a5e6-9dca-4de8-b388-dd0025d55403", "Blacksmith Coffee", 2, 2, "approve create", "Two raw rows and bean searches support Blacksmith Coffee in Lindsborg; blacksmithcoffee.com and bwblacksmith.com appear to be related official/commerce domains.", p("Blacksmith Coffee", "https://www.blacksmithcoffee.com/uploads/b/32a4d780-67a9-11ea-9fcb-25845ec4d487/Favicon2.jpg", "https://www.blacksmithcoffee.com/", "Lindsborg", "Kansas", "United States", "Blacksmith Coffee, North Main Street, Lindsborg, McPherson County, Kansas, 67456, United States", "Blacksmith Coffee Shop & Roastery,BW Blacksmith,BW Blacksmith Coffee Co."), ["Beans: Ethiopia Guji Hambela, Caribbean Carnival", "Bean search domains include blacksmithcoffee.com and bwblacksmith.com"], "No exact name/domain/alias match found.", "Logo is a direct official-site favicon JPG; acceptable but low-resolution."),
  c(3, "c8356eee-1994-48be-9f38-8f7980744ef1", "Kaffa Roastery", 1, 1, "approve create", "Bean-name research resolves the candidate to Helsinki Kaffa Roastery despite a bad raw geocode in Florida.", p("Kaffa Roastery", "https://images.squarespace-cdn.com/content/v1/5fa03b1277b4d16023730dc6/c2ed9466-3bce-4943-aa73-ee63c1c254df/Kaffa_logo_blk.png", "https://www.kaffaroasterystudio.com/", "Helsinki", "", "Finland", "Pursimiehenkatu 29, 00150 Helsinki, Finland", "Kaffa Roastery & Studio,Kaffa Roastery Oy,Kaffa Roastery & Studio Helsinki"), ["Bean: Aristobulo Rayo", "Checked kaffaroasterystudio.com, thecoffeevine.com, vbmespresso.com"], "No exact name/domain/alias match found.", "Official Squarespace logo PNG; location mismatch from raw geocode is explained."),
  c(4, "9e67f06f-29f9-4a0f-946b-3b505d1dbd76", "Starbucka", 1, 1, "hold / re-enrich", "Likely Starbucks misspelling, but no existing Starbucks row was found in the exact duplicate pass and the payload has no city/country.", p("Starbucks", "https://cdn.prod.website-files.com/6580c76ebe70d1634558a7c2/65b941cb7095de9d462dbf72_Favicon.png", "https://www.starbucks.com", "", "", "", "", "Starbucka,Starbucks Reserve"), ["Bean: Pike palace", "Bean search checked athome.starbucks.com and starbucks.com"], "No exact match found; do not create without policy decision on global chains.", "re_enrich_reason: other. re_enrich_notes: Confirm whether misspelled global-chain candidates should be rejected, completed against an existing chain row, or created; current payload lacks location."),
  c(5, "bcc9bb1f-6a09-41e9-b4ae-d1b0856fffa9", "meny", 1, 1, "reject", "Raw roaster value is not a roaster identity; enrichment jumped to Summer Moon while bean search points elsewhere.", p("Summer Moon Coffee", "", "https://summermooncoffee.com/", "", "", "", ""), ["Bean: poços de caldas", "Bean search domains include brasilcoffeeweek.com, hellodemello.com, westmoon.co.uk"], "Exact existing Summer Moon Coffee id 470 exists, but raw candidate does not support it.", "Reject as contaminated/noise instead of completing Summer Moon."),
  c(6, "0d8ed828-fbf3-47c7-87fc-629effbe2ea9", "schot", 1, 1, "approve alias", "The candidate clearly resolves to existing Schot Coffee Roasters and the short alias is useful.", p("Schot Coffee Roasters", "https://schotcoffeeroasters.nl/wp-content/uploads/2014/02/1492153_614947345263038_3358407662211587465_o.jpg", "https://schotcoffeeroasters.nl/", "Rotterdam", "", "Netherlands", "", "Schot"), ["Bean: decaf", "Domains checked: schotcoffeeroasters.nl, instagram.com, thecoffeevine.com"], "Existing match: id 1234 Schot Coffee Roasters, Rotterdam, Netherlands.", "Executable action should add alias Schot and mark cluster processed_as_alias."),
  c(7, "6c9457fe-6a7a-4e61-b262-c36e989c729a", "none", 1, 1, "reject", "Raw roaster value is literally none; enrichment to Barnone is weak and bean-name search does not confirm the identity.", p("Barnone Coffee Roasters", "", "https://www.barnonecoffeeroasters.com/", "", "", "", ""), ["Bean: jt", "Bean search domains are unrelated forums/directories"], "Fuzzy false-positive Kuranone Cafe ignored.", "Reject placeholder/noise."),
  c(8, "e16eca48-9a5a-4eff-a556-ef5087958d80", "Sirius, Coffee", 1, 1, "hold / re-enrich", "Official domains suggest Sirius, but raw location points to Alaska while enrichment uses Mexican domains and lacks verified city/country.", p("Sirius Coffee", "http://siriuscoffee.mx/cdn/shop/files/Sirius_Logo_Flaticon_0dd59ad1-7059-4b8d-925a-c8952992fb3f.png", "https://store.siriusroasters.com/", "", "", "", ""), ["Bean: Oaxaca, Red Honey", "Checked siriuscoffee.mx and store.siriusroasters.com"], "No exact match found.", "re_enrich_reason: location_mismatch. re_enrich_notes: Resolve Sirius Coffee identity and location; raw geocode says Sitka, Alaska while evidence domains point to Sirius Mexico/store.siriusroasters.com."),
  c(9, "86e59bcc-937c-4857-8057-d08e1ddba81e", "slippe", 1, 1, "reject", "Raw roaster is non-brand/noise and bean-name search does not support Grounds & Hounds.", p("Grounds & Hounds Coffee Co.", "https://www.groundsandhoundscoffee.com/cdn/shop/files/grounds-hounds-logo-white_200x.png?v=1613746949", "https://groundsandhoundscoffee.com", "", "", "", ""), ["Bean: Riripa", "Bean search domains are unrelated lifestyle/travel pages"], "No exact match found.", "Reject contaminated enrichment."),
  c(10, "b7a71901-9e58-4555-b7f9-3d15921fea5b", "Polite Coffee Roasters", 1, 1, "approve create", "Raw row, location, official site, and bean search all align.", p("Polite Coffee Roasters", "http://politecoffee.com/cdn/shop/files/polite_modern_logo.jpg", "https://politecoffee.com/", "Bryan", "Texas", "United States", "Bryan, Texas"), ["Bean: Bombe Abore", "Bean search checked politecoffee.com"], "No exact match found.", "Official Shopify logo JPG. Consider using full street address from raw location before execution."),
  c(11, "328421dc-ab52-49c7-b888-a1dfbf1097c6", "Mustafa", 1, 1, "hold / re-enrich", "Enrichment has Hoffman Estates cafe data but no logo and bean search points to Frukt/Nordic coffee sources, not Mustafa.", p("Mustafa Coffee House", "", "https://mustafacoffeehouse.com/", "Hoffman Estates", "Illinois", "United States", "2509 W Golf Rd, Hoffman Estates, IL, 60169, US"), ["Bean: Frukt", "Bean search checked frukt.coffee and Nordic Brew Lab"], "No exact match found.", "re_enrich_reason: ambiguous_identity. re_enrich_notes: Verify whether raw candidate Mustafa is actually Mustafa Coffee House; bean name Frukt points to other roasters and no acceptable logo was found."),
  c(12, "bf87f9d7-597d-4a96-8d40-9923e3a2903f", "Mulvadi", 1, 1, "hold / re-enrich", "Identity as a coffee seller is plausible, but city/country are missing.", p("Mulvadi", "http://mulvadi.com/cdn/shop/t/3/assets/logo.png?v=26579580971915122361483044397", "https://mulvadi.com/", "", "", "", ""), ["Bean: Kona", "Bean search checked mulvadi.com and Amazon"], "No exact match found.", "re_enrich_reason: other. re_enrich_notes: Confirm Mulvadi is a roaster and recover verified city/country; current evidence is commerce-heavy and location is missing."),
  c(13, "9c8d12e9-56b3-416f-b219-ed0145fa6dbd", "mountaineer roaster", 1, 1, "complete existing", "Clear existing roaster match; no useful new row change beyond noisy candidate text.", p("Mountaineer Roasting", "", "https://www.mountaineerroasting.com/", "Morgantown", "West Virginia", "United States", "Morgantown, WV"), ["Bean: mountaineer coffee", "Domains checked: mountaineerroasting.com, mountaineercoffee.com"], "Existing match: id 1569 Mountaineer Roasting Co.", "Close cluster as existing; no roaster row changes."),
  c(14, "c5423672-9ea9-4602-9bbe-3256b113cfed", "Portrait, coffee", 1, 1, "complete existing", "Exact existing Portrait Coffee match found; display text adds no useful alias.", p("Portrait Coffee", "", "https://portrait.coffee/", "", "", "", ""), ["Bean: El Puente natural", "Domains checked: portrait.coffee, freshcup.com"], "Existing match: id 541 Portrait Coffee.", "Close cluster as existing without row changes."),
  c(15, "99373261-8794-495d-b349-2ea85e994c69", "Rise Up", 1, 1, "approve create", "Raw location and domains support Rise Up Coffee Roasters; city/state should be filled from Easton raw location before writing.", p("Rise Up Coffee Roasters", "http://riseupcoffee.com/cdn/shop/files/CORE_LOGO_PNG-01.png?v=1761666962", "https://riseupcoffee.com/", "Easton", "Maryland", "United States", "627 Dover Road, Easton, Talbot County, Maryland, 21601, United States", "Rise Up"), ["Bean: Maryland Organic", "Domains checked: riseupcoffee.com, orderriseup.com"], "No exact match found.", "Official logo PNG; create-ready after address normalization."),
  c(16, "be858474-f4a8-4957-bef5-a27d25567111", "Riverbed Coffee Brewer&Roastery", 1, 1, "approve create", "Raw location and official domain align for the Japanese roastery.", p("Riverbed Coffee Brewer&Roastery", "https://riverbedcoffee-brewer-roastery.com/cdn/shop/files/new.png?v=1614307950", "https://riverbedcoffee-brewer-roastery.com/", "Nakatsugawa", "", "Japan", "淀川町2-25, 中津川市, 岐阜県, 5080034, JP"), ["Bean: Happiness Bloom", "Domains checked: riverbedcoffee-brewer-roastery.com, tabelog.com, instagram.com"], "No exact match found.", "Converted protocol-relative logo to https; non-US state blanked."),
  c(17, "673fffbe-5239-41c6-9b3a-0409f13d328a", "spada", 1, 1, "hold / re-enrich", "Likely Spada Coffee Istanbul, but logo appears to be a broad image JPG and address is not strong enough.", p("Spada Coffee", "https://cdn.myikas.com/images/theme-images/d05f9a69-da4e-4228-8fee-1e1f2eb62655/image_1080.jpg", "https://spadacoffee.com/", "Istanbul", "", "Turkey", ""), ["Bean: monte blanco", "Bean search checked spadacoffee.com and Instagram"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Identity likely Spada Coffee in Istanbul; recover an acceptable logo asset and confirm official address from spadacoffee.com or Instagram."),
  c(18, "32b92192-0f34-4535-b691-e7147510e456", "Spiritus", 1, 1, "hold / re-enrich", "Official site/logo support Spiritus, but raw candidate location says Lombard, Illinois while enrichment says Washington, DC.", p("Spiritus Coffee", "https://spirituscoffee.com/cdn/shop/files/Letterhead-_B_W_5x_52895f01-6f72-45c5-884d-391f112a79c5_1328x630.png?v=1741994716", "https://spirituscoffee.com/", "Washington", "District of Columbia", "United States", "1155 16th st, NW, Washington, DC"), ["Bean: Guera", "Bean search did not confirm Spiritus"], "No exact match found.", "re_enrich_reason: location_mismatch. re_enrich_notes: Resolve Spiritus Coffee location; raw candidate geocode is Lombard, Illinois but enrichment proposes Washington DC and bean search did not confirm."),
  c(19, "29ab3fd6-a31a-4d4d-bcbb-1de6c96abb7a", "Mindful", 1, 1, "approve create", "Raw location, domain, and bean search support Mindful Coffee in East Linton, UK.", p("Mindful Coffee", "http://mindfulcoffee.co.uk/cdn/shop/files/Mindful_Coffee_Logo_Grey_a37bf0a1-9bfb-4f52-8256-86c21b3fc2dd_1200x1200.png?v=1613517541", "https://mindfulcoffee.co.uk/", "East Linton", "", "United Kingdom", "Haddington Road, East Linton, East Lothian, EH40 3DW, United Kingdom"), ["Bean: Tranquil decaf", "Bean search checked mindfulcoffee.co.uk"], "No exact match found.", "Official Shopify logo PNG; non-US state blanked."),
  c(20, "2d93dc7c-e4bd-418d-b640-094bcac3dc52", "Surf", 1, 1, "hold / re-enrich", "Raw bean is Russian-language seasonal blend and bean search points to Surf Coffee Russia, while enrichment proposes Coffee Surf Co in Florida.", p("Coffee Surf Co", "", "https://coffeesurfco.com/", "Flagler Beach", "Florida", "United States", "701 North Oceanshore Boulevard, Flagler Beach, FL 32136"), ["Bean: Новогодний бленд 2025", "Bean search checked surfcoffee.ru, vk.com, Instagram"], "No exact match found.", "re_enrich_reason: wrong_entity. re_enrich_notes: Raw bean/search points to Surf Coffee Russia, not Coffee Surf Co Florida; use the Russian-language Surf Coffee evidence and discard coffeesurfco.com unless independently confirmed."),
  c(21, "adc9cc9e-990d-450d-b23a-e7b8e1b94f82", "devoccion", 1, 1, "hold / re-enrich", "Known roaster, but payload lacks location and logo; bean value is non-informative.", p("Devoción", "", "https://www.devocion.com/", "", "", "", ""), ["Bean: sss", "Domains checked: devocion.com, unpacking.coffee"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Confirm Devoción official location and recover acceptable logo; current bean text is not useful."),
  c(22, "25510fc3-cb90-43f0-9c4c-2b9ecaffd397", "Tales Coffee", 1, 1, "hold / re-enrich", "Official Tales Coffee domain/logo is plausible, but raw location points to a Greek cafe and bean search does not support it.", p("Tales Coffee", "https://talescoffee.com/cdn/shop/files/Tales_PNG_d989a0b8-e62a-4f84-8bc3-cfa27aae860d_2432x.png?v=1651904507", "https://talescoffee.com/", "", "", "", ""), ["Bean: Dizzy Dokuro", "Bean search checked unrelated merch/YouTube domains"], "No exact match found.", "re_enrich_reason: ambiguous_identity. re_enrich_notes: Verify whether candidate Tales Coffee is the online talescoffee.com roaster or the Greek Coffee Tales location; bean search did not resolve identity."),
  c(23, "3445687a-3190-41e0-b96b-a8a855a0cadb", "REPUBLIK", 1, 1, "hold / re-enrich", "Republik Coffee is plausible but logo and street address are missing.", p("Republik Coffee", "", "https://republikcoffee.com/", "Pasadena", "California", "United States", ""), ["Bean: Edinson Argote Advanced Natural Chiroso", "Domains checked: republikcoffee.com, instagram.com"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Identity appears to be Republik Coffee in Pasadena; recover acceptable logo and confirm address from official sources."),
  c(24, "21362fb0-54dd-4064-a777-58462bd1e386", "The studio Coffee", 1, 1, "hold / re-enrich", "Enrichment chooses Bozeman The Studio Coffee Roasters, but raw location points to Studio City, LA and search domains include several similarly named entities.", p("The Studio Coffee Roasters", "", "https://thestudiocoffee.com/", "Bozeman", "Montana", "United States", "1013 West College Street, Bozeman, MT, 59715, United States"), ["Bean: Mundo novo", "Bean search checked thestudiocoffee.com and studiocoffeeroasters.com"], "No exact match found.", "re_enrich_reason: ambiguous_identity. re_enrich_notes: Disambiguate The Studio Coffee candidates; raw location says Studio City LA while evidence includes thestudiocoffee.com and studiocoffeeroasters.com."),
  c(25, "73e0a08f-c040-4ec8-a1ad-d1e1a0d57cf1", "Thomson’s Coffee", 1, 1, "hold / re-enrich", "Raw address and official domain support Thomson's Coffee in Glasgow, but payload lacks city/country/logo.", p("Thomson's Coffee", "", "https://www.thomsonscoffee.com/", "Glasgow", "", "United Kingdom", "200 Gallowgate, Glasgow, G1 5DR, United Kingdom"), ["Bean: Renfield 35", "Bean search checked thomsonscoffee.com, Facebook, X"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Identity is likely Thomson's Coffee in Glasgow; use raw address and thomsonscoffee.com, recover acceptable logo."),
  c(26, "ae366599-81d2-4ee9-a288-258c435b1916", "Tiger Coffee", 1, 1, "approve alias", "Raw bean search resolves to existing Taiwan Tiger Coffee/虎記商行; enrichment to Blind Tiger Philadelphia is wrong.", p("虎記商行", "", "https://www.tigercoffee.tw/", "Taipei", "", "Taiwan", "", "Tiger Coffee"), ["Bean: 衣索比亞 金猴藝伎 日曬G1", "Bean search checked tigercoffee.tw and Facebook"], "Existing match: id 1206 虎記商行 with Tiger Coffee alias.", "Complete/alias existing; no Blind Tiger write."),
  c(27, "ab822fda-603b-4144-901a-47c06575edc8", "timwendelboe.n", 1, 1, "complete existing", "Raw row and bean search clearly point to existing Tim Wendelboe; candidate text is not a useful alias.", p("Tim Wendelboe", "", "https://timwendelboe.no", "Oslo", "", "Norway", "Tøyengata 29c, 0578 Oslo"), ["Bean: Gachatha", "Bean search checked timwendelboe.no, kofio.co, Reddit"], "Existing match: id 66 Tim Wendelboe.", "Close existing without row changes."),
  c(28, "786bc0d9-7305-4321-adf3-d16a26bbafde", "Les Cafés de Mick", 1, 1, "approve update", "Existing row lacks website; candidate supplies official site and raw address.", p("Les Cafés De Mick", "https://cdn.myportfolio.com/4558ea21-c456-4fb2-9dc3-ae9a20a48d6a/90070dd0-59d8-4e50-b1b4-a9f58f89dd74_rwc_0x0x1181x833x4096.jpg", "https://www.lescafesdemick.fr/", "Paris", "", "France", "13 rue de Santeuil, 75005 Paris"), ["Bean: Le Café du Goûter", "Bean search checked lescafesdemick.fr and Instagram"], "Existing match: id 1048 Les Cafés De Mick, website null.", "Proposed update: add website/address if approved. Logo looks like a portfolio image and should be reviewed before use."),
  c(29, "4e330be5-2705-4617-a943-6b3ad6d6f109", "Urbania", 1, 1, "hold / re-enrich", "Candidate may be Urbania in Medellín, but payload lacks logo/location and evidence includes square.site and other Colombian coffee domains.", p("Urbania Café", "", "https://www.urbaniacafe.com/", "Medellín", "", "Colombia", "Cl. 8 # 43B - 132, El Poblado, Medellín, Antioquia, Colombia"), ["Bean: Typica", "Checked urbaniacafe.com, urbaniausa.square.site, Instagram"], "No exact match found.", "re_enrich_reason: ambiguous_identity. re_enrich_notes: Confirm whether Urbania is the Medellin cafe/roaster from urbaniacafe.com or another Urbania listing; recover logo and location."),
  c(30, "cc985ea7-51b6-4dd0-ba4c-ca964874a606", "Larry's Coffee", 1, 1, "hold / re-enrich", "Raw location and domain support Larry's Coffee, but logo and city/country are missing from enrichment.", p("Larry's Coffee", "", "https://larryscoffee.com/", "Raleigh", "North Carolina", "United States", "1507 Gavin Street, Raleigh, North Carolina, 27608, United States"), ["Bean: Larry's House", "Bean search checked larryscoffee.com and retail listings"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Identity is Larry's Coffee in Raleigh; use larryscoffee.com/raw address and recover acceptable logo."),
  c(31, "44763acd-7c66-4208-b84d-7da93a00b6a6", "Kwagala Coffee", 1, 1, "hold / re-enrich", "Kwagala Coffee/Farm evidence exists, but logo and city-level location are missing.", p("Kwagala Coffee", "", "https://kwagalafarm.org/", "", "", "Uganda", ""), ["Bean: Nabingoma Organic - Bududa", "Domains checked: kwagalafarm.org, LinkedIn, Facebook, Instagram"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Confirm Kwagala Coffee/Farm is a roaster, recover city/location and acceptable logo from official/social sources."),
  c(32, "8b47161c-3359-43d9-ae1e-b7cbcea66750", "Kurukahveci", 1, 1, "approve alias", "Existing Kurukahveci Mehmet Efendi row found; short brand alias is useful.", p("Kurukahveci Mehmet Efendi", "https://www.mehmetefendi.com/images/content/jpg/mehmetefendi.jpg", "https://www.mehmetefendi.com/eng", "Istanbul", "", "Turkey", "Tahmis Sokağı, Eminönü, Istanbul, Turkey", "Kurukahveci"), ["Bean: Mehmet efendi", "Bean search checked mehmetefendi.com, Amazon, Instagram"], "Existing match: id 1498 Kurukahveci Mehmet Efendi.", "Executable action should add alias Kurukahveci if not already present."),
  c(33, "e1ce42f6-976d-48c1-93dc-202320495446", "White roastery", 1, 1, "hold / re-enrich", "Enrichment says White Box Roastery, but raw bean is generic Ethiopia and search also returns Black & White and DAK; identity is not clean.", p("White Box Roastery", "https://whiteboxroastery.com/wp-content/uploads/2023/03/WHITE-BOX-6-1.png", "https://whiteboxroastery.com/", "", "", "", ""), ["Bean: Ethiopia", "Bean search checked blackwhiteroasters.com, dakcoffeeroasters.com, Reddit"], "No exact match found.", "re_enrich_reason: ambiguous_identity. re_enrich_notes: Disambiguate White roastery; raw/search results include multiple white/black-white roasters and not enough support for White Box."),
  c(34, "14594f2d-fb53-4828-bbf0-1b31746575c4", "Wolff Coffee Roasters", 1, 1, "approve create", "Candidate name, raw location, and bean search support Australian Wolff Coffee Roasters; similar Wolf businesses are distinct.", p("Wolff Coffee Roasters", "https://wolffcoffeeroasters.com.au/cdn/shop/files/WCR-Shopify-Logo-628.png?v=1596694473&width=2048", "https://wolffcoffeeroasters.com.au/", "Brisbane", "", "Australia", "140 Gerler Road, Hendra, Queensland, 4011, Australia"), ["Bean: Hummingbird", "Bean search checked wolffcoffeeroasters.com.au and Beanz"], "No exact match found.", "Official Shopify logo PNG; non-US state blanked."),
  c(35, "d4703465-25e6-406b-b0f7-2555f83f96ac", "Kima", 1, 1, "hold / re-enrich", "Search has kima-coffee.com and kimacoffee.com mismatch; raw location is unrelated Russian Coffee Like.", p("Kima Coffee", "http://kimacoffee.com/cdn/shop/files/kima_nombreprincipal_1200x1200.png?v=1613736773", "https://kima-coffee.com/", "", "", "", ""), ["Bean: Etiopía Pineapple", "Bean search checked kimacoffee.com and Instagram"], "No exact match found.", "re_enrich_reason: ambiguous_identity. re_enrich_notes: Resolve Kima identity/domain mismatch kima-coffee.com vs kimacoffee.com and ignore unrelated Russian Coffee Like geocode unless confirmed."),
  c(36, "9eca889d-3cd9-4b6c-939a-a56c4e6e97e7", "keobscoffee", 1, 1, "hold / re-enrich", "Identity/domain/logo plausible but city is missing.", p("KEOBS Coffee Roastery", "https://keobs.com.tr/image/cache/catalog/keobs_logo/keobs_coffee_roastery_logo_2-300x300.png", "https://keobs.com.tr/", "", "", "Turkey", ""), ["Bean: La Pastoral Tarrazu", "Domains checked: keobs.com.tr, Instagram, Trendyol"], "No exact match found.", "re_enrich_reason: other. re_enrich_notes: Confirm KEOBS city/address from official sources before create; logo and country are plausible."),
  c(37, "21cf641a-b59d-4850-a171-5807a4f0039d", "Kawa Kivu", 1, 1, "hold / re-enrich", "Kawa Kivu identity is plausible but no logo and raw location conflicts between Goma and Butembo/Nord-Kivu details.", p("Kawa Kivu", "", "https://kawakivu.com/", "Goma", "", "Democratic Republic of the Congo", ""), ["Bean: Nyira-Gongo", "Bean search checked montagnedellaluna.coffee and Instagram"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Confirm Kawa Kivu city/location in DRC and recover acceptable logo; raw address mentions Butembo/Nord-Kivu while enrichment says Goma."),
  c(38, "8cca46a9-a356-447a-9f02-a6e1091cf76c", "ZeroToOne", 1, 1, "hold / re-enrich", "Identity likely ZeroToOne Coffee London, but logo is third-party menu-world and bean search did not confirm strongly.", p("ZeroToOne Coffee", "https://cdn.menu-world.com/zerotoone-coffee/logo-share.jpg", "https://zerotoonecoffee.co.uk/", "London", "", "United Kingdom", "19 Widegate St, London E1 7HP"), ["Bean: Zanya Farm, Lam Dong", "Checked zerotoonecoffee.co.uk, menu-world, company registry, Instagram"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Use zerotoonecoffee.co.uk and London raw address, recover first-party logo if possible; menu-world logo is third-party fallback only."),
  c(39, "12361494-30f2-4160-9a15-7e3e84a1b1ad", "Znośne", 1, 1, "hold / re-enrich", "Official site and bean search support Znośne, but logo is SVG, which is not executable under review policy.", p("Znośne", "", "https://znosne.pl/", "Kraków", "", "Poland", "Franciszkańska 6, 31-004 Kraków, Poland"), ["Bean: Znośny przelew", "Bean search checked znosne.pl and forum.wszystkookawie.pl"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Identity/location look solid for Znośne Kraków; recover PNG/JPG/WebP logo because current official asset is SVG."),
  c(40, "1f9a0b31-a4de-4a9f-9ae5-628c3555712d", "Bold Street Coffee", 1, 1, "approve create", "Raw location, official domain, and bean search align.", p("Bold Street Coffee", "https://boldstreetcoffee.co.uk/cdn/shop/files/BSC_Logo_Black.png?v=1726389771", "https://boldstreetcoffee.co.uk", "Liverpool", "", "United Kingdom", "89 Bold Street, Liverpool, L1 4DG, United Kingdom"), ["Bean: Bookkisa", "Bean search checked boldstreetcoffee.co.uk and Instagram"], "No exact match found.", "Official logo PNG; non-US state blanked."),
  c(41, "6988d095-d1a3-4cef-b88a-192e2ac6b408", "Кофеваркин", 1, 1, "hold / re-enrich", "Identity and site are plausible, but logo is missing.", p("Кофеваркин", "", "https://coffeevarkin.ru/", "Samara", "", "Russia", "Ново-Урицкая улица, 12 к4, Самара"), ["Bean: Колумбия Уила", "Bean search checked coffeevarkin.ru, VK, Yandex/Ozon"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Identity likely Кофеваркин in Samara; recover acceptable PNG/JPG/WebP logo from official site or VK."),
  c(42, "95d076d5-c99c-4854-9ca0-396bb5b24870", "إفادرو", 1, 1, "hold / re-enrich", "Official domain/logo plausible, but city/country are missing and Arabic/Latin naming needs confirmation.", p("إفادرو", "https://cdn.salla.sa/pZxVZ/KIMCi5VB6CuyJ0xjpRV7p8KIeMOndFI6ToszmEoH.jpg", "https://evador-roaster.com/", "", "", "", ""), ["Bean: روز", "Bean search checked evador-roaster.com"], "No exact match found.", "re_enrich_reason: other. re_enrich_notes: Confirm Evador/إفادرو official name and location from evador-roaster.com; current logo likely Salla asset but city/country are missing."),
  c(43, "f669ffb4-b5a5-4121-a136-b707d4432217", "اورو", 1, 1, "hold / re-enrich", "Official domain/logo plausible but location is missing and English name may be Oro/Ouro.", p("Ouro", "https://cdn.salla.sa/qXemN/jPWHO8rO30wgyoH5iDIIJMB1vJm37cvU06yw2S6b.png", "https://oro-sa.com/en/", "", "", "", ""), ["Bean: قيدب", "Bean search checked oro-sa.com and Saudi coffee retailers"], "No exact match found.", "re_enrich_reason: other. re_enrich_notes: Confirm Arabic/English name for oro-sa.com and recover city/country before create; avoid confusing Ouro/Oro."),
  c(44, "f4c2e6bb-b842-4bd2-bc73-0dfac3990462", "بلاك نايت", 1, 1, "approve alias", "Existing Black Knight Saudi row found; Arabic display name is a useful alias.", p("Black Knight", "https://cdn.salla.sa/mEGGZ/e6S3MtUtsNaQDRH3vzBGRlBfp2kKl8OP6M3RRqsS.png", "https://b-k.coffee/", "Khobar", "", "Saudi Arabia", "", "بلاك نايت"), ["Bean: شيليشلي", "Bean search checked b-k.coffee and Salla"], "Existing match: id 1007 Black Knight.", "Executable action should add Arabic alias and optionally website only if approved as update."),
  c(45, "1fb5ea68-1919-4b24-8a8f-d9dbb4a7961f", "Julius Menil", 1, 1, "complete existing", "Typo/misspelling resolves to existing Julius Meinl; typo is not a useful alias.", p("Julius Meinl", "", "https://juliusmeinl.com/", "Vienna", "", "Austria", ""), ["Bean: Decaff", "Domains checked: juliusmeinl.com, shop.meinl.com, Instagram"], "Existing match: id 1218 Julius Meinl.", "Close existing without row changes."),
  c(46, "6a457e82-20cd-4356-b5ef-d9f05b16cd16", "jinotega", 1, 1, "reject", "Raw roaster is a place name, not a roaster; enrichment to Thanksgiving Coffee is unsupported by bean search.", p("Thanksgiving Coffee Company", "https://thanksgivingcoffee.com/cdn/shop/t/131/assets/logo_300x240.png", "https://thanksgivingcoffee.com/", "", "", "", ""), ["Bean: la escondida", "Bean search checked Manhattan, Murs, Sucafina, Ally, La Minita"], "No exact match found.", "Reject contaminated place-name candidate."),
  c(47, "96679cea-fc73-4dc0-882d-36d022d5ef93", "ブルーボトル", 1, 1, "approve alias", "Japanese display name resolves to existing Blue Bottle Coffee and is a useful alias.", p("Blue Bottle Coffee", "", "https://bluebottlecoffee.com/", "Oakland", "California", "United States", "", "ブルーボトル"), ["Bean: HAMBELA METAD NATURAL", "Bean search checked bluebottlecoffee.com and store.bluebottlecoffee.jp"], "Existing match: id 91 Blue Bottle Coffee.", "Executable action should add Japanese alias if not already covered."),
  c(48, "97e70bc4-89ae-41b8-a97c-4b2ac4434df4", "Jag’s Head", 1, 1, "approve create", "Raw location, official site, and bean search align.", p("Jag's Head", "https://jagsheadcoffee.com/wp-content/uploads/2022/02/JagsLogo1st.png", "https://jagsheadcoffee.com/", "Charlotte", "North Carolina", "United States", "520 Clanton Rd. Suite E Charlotte, NC 28217", "Jags Head"), ["Bean: Finca el cipres", "Bean search checked jagsheadcoffee.com, Facebook, Reddit"], "No exact match found.", "Official logo PNG; normalized US state to North Carolina."),
  c(49, "249a3cdd-9ee7-4012-8037-cc87ec1742aa", "insomnia", 1, 1, "hold / re-enrich", "Insomnia Coffee Company is plausible and has Dublin address, but logo is missing and candidate search also has Insomnia Coffee Lab/store domains.", p("Insomnia Coffee Company", "", "https://insomniacoffee.co/", "Dublin", "", "Ireland", "130 Francis Street, Dublin"), ["Bean: natural", "Domains checked: insomniacoffee.co, insomniacoffeelab.store, insomnia.ie"], "No exact match found.", "re_enrich_reason: logo_missing. re_enrich_notes: Confirm Insomnia Coffee Company vs Insomnia Coffee Lab/store domains and recover acceptable logo for the Dublin entity."),
  c(50, "d18c1a6b-fb38-466b-9322-5cb1185b7ec2", "röestbar", 1, 1, "complete existing", "Clear existing Röstbar/Roestbar match; no useful row change needed.", p("röestbar", "", "https://roestbar.com/", "", "", "Germany", ""), ["Bean: Fugi Washing Station", "Bean search checked roestbar.com"], "Existing match: id 1296 Röstbar with aliases röstbar, Roestbar.", "Close existing without row changes."),
];

function p(roaster_name, roaster_logo_url, roaster_website_url, city, state, country, address, aliases = "") {
  return { roaster_name, roaster_logo_url, roaster_website_url, aliases, city, state, country, address };
}

function c(card, cluster_id, title, candidate_count, occurrences, recommendation, confidence, payload, evidence, duplicate, notes) {
  return { card, cluster_id, title, candidate_count, occurrences, recommendation, confidence, payload, evidence, duplicate, notes };
}

const counts = cards.reduce((acc, card) => {
  acc[card.recommendation] = (acc[card.recommendation] || 0) + 1;
  return acc;
}, {});

const sourceMap = existsSync(sourceMapFile)
  ? JSON.parse(readFileSync(sourceMapFile, "utf8"))
  : {};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function storageKey() {
  return `roaster-review-${generatedAt}-no-skip-confidence-selected50`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roaster Candidate Review - 2026-05-15 no skip 50</title>
<style>
body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f7f4ed;color:#202020}
header{padding:28px 32px;background:#23211d;color:#fff}
main{max-width:1180px;margin:0 auto;padding:24px}
.summary{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
.pill{border:1px solid #d8d0c0;background:#fff;border-radius:999px;padding:7px 10px;font-size:13px;color:#25231f}
.card{background:#fff;border:1px solid #ddd4c5;border-radius:8px;margin:18px 0;padding:18px;box-shadow:0 1px 1px rgba(0,0,0,.03)}
.top{display:grid;grid-template-columns:86px 1fr;gap:16px;align-items:start}
.logo{width:78px;height:78px;border:1px solid #ddd4c5;border-radius:6px;object-fit:contain;background:#fafafa}
h2{margin:0 0 8px;font-size:21px;letter-spacing:0}
h3{font-size:14px;margin:16px 0 8px;color:#5b4d39;text-transform:uppercase}
.badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:700;background:#eee4d3;color:#3b3123}
.approve{background:#d9efe0}.hold{background:#f8e1bf}.reject{background:#f0c8c2}.existing{background:#d9e6ef}
pre{white-space:pre-wrap;word-break:break-word;background:#282521;color:#f7f4ed;padding:12px;border-radius:6px;font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
ul{margin:8px 0 0 20px;padding:0}
a{color:#69502a;text-decoration-thickness:1px;text-underline-offset:2px}
.sources{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.source-link{border:1px solid #d8d0c0;background:#fbf8f2;border-radius:999px;padding:6px 9px;font-size:12px;color:#4a3920;text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.source-link:hover{background:#efe4d2}
textarea,input[type=url]{width:100%;box-sizing:border-box;border:1px solid #cfc5b4;border-radius:6px;padding:10px;font:inherit;background:#fff}
textarea{min-height:70px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 8px}
button{border:1px solid #9e8c72;border-radius:6px;background:#fff;padding:8px 10px;cursor:pointer}
button:hover{background:#f0e8da}
#jsonBox{min-height:360px;width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.handoff{background:#fff;border:1px solid #ddd4c5;border-radius:8px;padding:16px;margin-top:24px}
@media(max-width:760px){main{padding:14px}.grid,.top{grid-template-columns:1fr}.logo{width:96px;height:96px}}
</style>
</head>
<body>
<header>
<h1>Roaster Candidate Review</h1>
<div>Generated ${generatedAt}. Batch: confidence-selected 50, no skip rules applied. No writes have been made.</div>
<div class="summary">${Object.entries(counts).map(([k, v]) => `<span class="pill">${esc(k)}: ${v}</span>`).join("")}</div>
</header>
<main>
${cards.map((card) => {
  const cls = card.recommendation.includes("approve create") || card.recommendation.includes("approve update") || card.recommendation.includes("approve alias") ? "approve" : card.recommendation.includes("complete") ? "existing" : card.recommendation.includes("reject") ? "reject" : "hold";
  const logo = card.payload.roaster_logo_url || "";
  const links = sourceLinks(card);
  return `<section class="card" data-card="${card.card}" data-cluster-id="${esc(card.cluster_id)}" data-title="${esc(card.title)}" data-recommendation="${esc(card.recommendation)}">
  <div class="top">
    ${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : `<div class="logo"></div>`}
    <div>
      <h2>${card.card}. ${esc(card.title)}</h2>
      <span class="badge ${cls}">${esc(card.recommendation)}</span>
      <span class="pill">candidate_count ${card.candidate_count}</span>
      <span class="pill">occurrences ${card.occurrences}</span>
      <p>${esc(card.confidence)}</p>
    </div>
  </div>
  <div class="grid">
    <div>
      <h3>Proposed Payload</h3>
      <pre>${esc(JSON.stringify(card.payload, null, 2))}</pre>
    </div>
    <div>
      <h3>Evidence</h3>
      <ul>${card.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      <h3>Sources</h3>
      <div class="sources">${links.map((link) => `<a class="source-link" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`).join("")}</div>
      <h3>Duplicate Check</h3>
      <p>${esc(card.duplicate)}</p>
      <h3>Agent Notes</h3>
      <p>${esc(card.notes)}</p>
    </div>
  </div>
  <div class="actions">
    ${["approve create", "approve alias", "complete existing", "re-enrich", "reject"].map((action) => `<button type="button" data-action="${action}" data-card="${card.card}">${action}</button>`).join("")}
  </div>
  <label>Reviewer comments
    <textarea data-comment="${card.card}" placeholder="Add action or notes for card ${card.card}"></textarea>
  </label>
  <label>Logo override
    <input type="url" data-logo-override="${card.card}" placeholder="https://example.com/logo.png">
  </label>
</section>`;
}).join("\n")}
<div class="handoff">
  <div class="actions">
    <button id="copyJson" type="button">Copy comments JSON</button>
    <button id="downloadJson" type="button">Download comments JSON</button>
    <button id="clearInputs" type="button">Clear saved review inputs</button>
    <span id="status"></span>
  </div>
  <textarea id="jsonBox" readonly></textarea>
</div>
</main>
<script>
const key = ${JSON.stringify(storageKey())};
const cards = Array.from(document.querySelectorAll(".card")).map((el) => ({
  card: Number(el.dataset.card),
  cluster_id: el.dataset.clusterId,
  title: el.dataset.title,
  recommendation: el.dataset.recommendation,
}));
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(key) || "{}");
} catch (_) {
  saved = {};
}
function collect(){
  const out = {};
  for (const card of cards) {
    out[String(card.card)] = {
      card: card.card,
      cluster_id: card.cluster_id,
      title: card.title,
      recommendation: card.recommendation,
      comment: document.querySelector('[data-comment="' + card.card + '"]').value,
      logo_override: document.querySelector('[data-logo-override="' + card.card + '"]').value
    };
  }
  return out;
}
function render(){
  const out = collect();
  try {
    localStorage.setItem(key, JSON.stringify(out));
  } catch (_) {}
  document.getElementById("jsonBox").value = JSON.stringify(out, null, 2);
}
for (const card of cards) {
  const row = saved[String(card.card)] || {};
  document.querySelector('[data-comment="' + card.card + '"]').value = row.comment || "";
  document.querySelector('[data-logo-override="' + card.card + '"]').value = row.logo_override || "";
}
document.addEventListener("input", (event) => {
  if (event.target.matches("textarea[data-comment],input[data-logo-override]")) render();
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) {
    document.querySelector('[data-comment="' + button.dataset.card + '"]').value = button.dataset.action;
    render();
  }
});
document.getElementById("copyJson").addEventListener("click", async () => {
  const box = document.getElementById("jsonBox");
  try {
    await navigator.clipboard.writeText(box.value);
    document.getElementById("status").textContent = "Copied.";
  } catch (_) {
    box.focus();
    box.select();
    document.getElementById("status").textContent = "Clipboard blocked. JSON selected for manual copy.";
  }
});
document.getElementById("downloadJson").addEventListener("click", () => {
  const blob = new Blob([document.getElementById("jsonBox").value], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "roaster-candidate-review-2026-05-15-no-skip-comments.json";
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById("status").textContent = "Downloaded.";
});
document.getElementById("clearInputs").addEventListener("click", () => {
  if (!confirm("Clear saved review inputs for this preview?")) return;
  try {
    localStorage.removeItem(key);
  } catch (_) {}
  for (const el of document.querySelectorAll("textarea[data-comment],input[data-logo-override]")) el.value = "";
  render();
});
render();
</script>
</body>
</html>`;

writeFileSync(outFile, html);
console.log(outFile);

function sourceLinks(card) {
  const links = [];
  const add = (href, label = "") => {
    if (!href) return;
    const normalized = normalizeUrl(href);
    if (!normalized) return;
    if (links.some((link) => link.href === normalized)) return;
    links.push({ href: normalized, label: label || linkLabel(normalized) });
  };
  const exactSources = sourceMap[card.cluster_id] || [];
  for (const source of exactSources) {
    add(source.url, `${source.kind}: ${linkLabel(normalizeUrl(source.url))}`);
  }
  if (links.length > 0) return links;
  add(card.payload.roaster_website_url, "website");
  add(card.payload.roaster_logo_url, "logo");
  for (const item of card.evidence) {
    const afterColon = item.includes(":") ? item.slice(item.indexOf(":") + 1) : item;
    for (const raw of afterColon.split(",")) {
      const token = raw.trim().replace(/[.;]$/, "");
      if (!looksLikeDomainOrUrl(token)) continue;
      add(token);
    }
  }
  return links;
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (looksLikeDomainOrUrl(trimmed)) return `https://${trimmed}`;
  return "";
}

function looksLikeDomainOrUrl(value) {
  return /^(https?:\/\/|\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/|\?|#|$)/i.test(String(value || "").trim());
}

function linkLabel(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch (_) {
    return href;
  }
}
