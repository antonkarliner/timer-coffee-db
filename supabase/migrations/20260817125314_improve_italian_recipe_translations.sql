begin;

-- Derive every Italian grind label from the English source so gender, case,
-- hyphenation, and slash variants cannot drift independently.
update public.recipe_localization as it
set grind_size = case en.grind_size
  when 'Fine' then 'Fine'
  when 'Fine/Medium' then 'Da fine a media'
  when 'Medium/Fine' then 'Da fine a media'
  when 'Medium fine' then 'Medio-fine'
  when 'Medium-fine' then 'Medio-fine'
  when 'Medium' then 'Media'
  when 'Medium (like kosher salt)' then 'Media (come il sale kosher)'
  when 'Medium, finer than usual' then 'Media, più fine del solito'
  when 'Medium-Coarse' then 'Medio-grossa'
  when 'Medium-coarse' then 'Medio-grossa'
  when 'Medium-coarse (sea salt)' then 'Medio-grossa (come il sale marino)'
  when 'Coarse' then 'Grossa'
  else btrim(it.grind_size)
end
from public.recipe_localization as en
where it.recipe_id = en.recipe_id
  and it.locale = 'it'
  and en.locale = 'en';

-- Preserve the manufacturer's official product spelling everywhere.
update public.recipe_localization
set
  name = replace(name, 'Aeropress', 'AeroPress'),
  short_description = replace(short_description, 'Aeropress', 'AeroPress')
where locale = 'it';

update public.steps
set description = replace(description, 'Aeropress', 'AeroPress')
where locale = 'it';

-- Correct meaning-changing recipe metadata and official competition names.
update public.recipe_localization as target
set
  name = coalesce(replacement.name, target.name),
  short_description = coalesce(replacement.short_description, target.short_description)
from (
  values
    ('106', null, 'Il metodo 4:6 prende il nome da come l’acqua calda viene suddivisa durante i versamenti: 40% e 60%. Questo permette di regolare il sapore e la concentrazione del caffè. Tetsu Kasuya, ideatore della tecnica, ha vinto la World Brewers Cup 2016 con questo metodo. [Leggi la guida](https://en.philocoffea.com/blogs/blog/coffee-brewing-method) per capire meglio come funziona. Prova a preparare gli stessi chicchi modificando un solo parametro alla volta per valutarne l’effetto.'),
    ('107', null, 'Una semplice ricetta base per V60 che mira a un rendimento di estrazione di circa il 20–23%. [Guarda il video](https://www.youtube.com/watch?v=Ji4lZTtRAoo) per una spiegazione dettagliata. Lance consiglia di usare 15–25 g di caffè.'),
    ('402', 'Ricetta per French Press di Gwilym Davies', null),
    ('602', null, 'Ricetta di James McCarthy, vincitore della World Brewers Cup 2013 con la Kalita Wave. [Leggi maggiori dettagli](https://sprudge.com/meet-the-worlds-best-brewer-james-mccarthy-brewers-cup-champ-38672.html).'),
    ('702', 'Ricetta pour-over per Wilfa Svart Pour Over di Best Coffee', 'Un altro modo di preparare il caffè con Wilfa Svart Pour Over è il pour-over. Questa ricetta è di [Best Coffee](https://www.bestcoffee.guide/blogs/product-reviews/wilfa-pour-over-smart-dripper-review).'),
    ('802', 'Ricetta per Origami Dripper di Jia Ning Du', 'Ricetta per Origami Dripper di Jia Ning Du, la prima barista cinese a vincere la World Brewers Cup (WBrC). Questa è la ricetta con cui ha vinto. [Guarda il tutorial](https://www.youtube.com/watch?v=HNDnngFhZMU).'),
    ('1001', null, 'Questa ricetta, sviluppata da Tetsu Kasuya, campione della World Brewers Cup 2016, mira a massimizzare l’estrazione all’inizio della preparazione e a rallentarla nelle fasi successive. [Guarda il video](https://www.youtube.com/watch?v=gC8K40kZ_6E) in cui Tetsu spiega i principi della ricetta.'),
    ('1003', null, 'Questa ricetta facile da seguire è di Emi Fukahori, campionessa della World Brewers Cup 2018. [Guarda il tutorial](https://www.youtube.com/watch?v=3euEkTBxtEk) per una spiegazione dettagliata.')
) as replacement(recipe_id, name, short_description)
where target.recipe_id = replacement.recipe_id
  and target.locale = 'it';

-- Convert remaining direct instructions from infinitives to the informal
-- singular imperative used by the Italian app. Exact rewrites below take
-- precedence for technical terminology and multi-clause steps.
with recursive substitutions(ord, source, replacement) as (
  values
    (1, 'Aggiungere', 'Aggiungi'),
    (2, 'Attendere', 'Attendi'),
    (3, 'Aspettare', 'Aspetta'),
    (4, 'Gettare', 'Getta'),
    (5, 'Inserire', 'Inserisci'),
    (6, 'Macinare', 'Macina'),
    (7, 'Mettere', 'Metti'),
    (8, 'Pesare', 'Pesa'),
    (9, 'Porre', 'Posiziona'),
    (10, 'Premere', 'Premi'),
    (11, 'Rimuovere', 'Rimuovi'),
    (12, 'Riempire', 'Riempi'),
    (13, 'Rimettere', 'Rimetti'),
    (14, 'Sciacquare', 'Sciacqua'),
    (15, 'Servire', 'Servi'),
    (16, 'Versare', 'Versa')
), rewritten(id, ord, description) as (
  select id, 0, description
  from public.steps
  where locale = 'it'

  union all

  select rewritten.id,
         substitutions.ord,
         replace(rewritten.description, substitutions.source, substitutions.replacement)
  from rewritten
  join substitutions on substitutions.ord = rewritten.ord + 1
)
update public.steps as target
set description = rewritten.description
from rewritten
where target.id = rewritten.id
  and rewritten.ord = (select max(ord) from substitutions)
  and target.description is distinct from rewritten.description;

-- Approved placeholder, register, preinfusion, drawdown, vessel, grounds,
-- and physical-action corrections.
update public.steps as target
set description = replacement.description
from (
  values
    ('101', 1, 'Sciacqua il filtro e preriscalda il V60. Versa il caffè macinato e crea un incavo al centro.'),
    ('101', 2, 'Avvia la preinfusione con (2 x <final_coffee_amount>)g d’acqua.'),
    ('101', 3, 'Fai ruotare il V60 finché la miscela di caffè e acqua è uniforme.'),
    ('101', 4, 'Lascia il caffè in preinfusione.'),
    ('101', 7, 'Mescola delicatamente in senso orario e antiorario per staccare il caffè macinato dalle pareti.'),
    ('101', 8, 'Fai ruotare delicatamente il V60 per livellare il letto di caffè e ottenere un’estrazione uniforme.'),
    ('101', 9, 'Cerca di completare il filtraggio entro 3 min e 30 s.'),
    ('102', 1, 'Sciacqua il filtro e preriscalda il V60. Versa il caffè macinato e livellalo.'),
    ('102', 2, 'Avvia la preinfusione con (3 x <final_coffee_amount>)g d’acqua.'),
    ('102', 3, 'Scava delicatamente nel letto di caffè per bagnare tutto il caffè macinato.'),
    ('102', 4, 'Lascia il caffè in preinfusione.'),
    ('102', 6, 'Mescola delicatamente per evitare che il caffè macinato aderisca alle pareti.'),
    ('102', 7, 'Fai ruotare il V60 per livellare il letto di caffè e ottenere un’estrazione uniforme.'),
    ('102', 8, 'Il filtraggio dovrebbe completarsi entro 3 minuti.'),
    ('103', 1, 'Sciacqua il filtro e preriscalda il V60. Versa il caffè macinato e livellalo.'),
    ('103', 2, 'Avvia la preinfusione con (0.25 x <final_water_amount>)g d’acqua.'),
    ('103', 3, 'Versa (0.375 x <final_water_amount>)g d’acqua.'),
    ('103', 4, 'Versa di nuovo (0.375 x <final_water_amount>)g e fai ruotare delicatamente il V60. Attendi che tutta l’acqua sia filtrata.'),
    ('103', 6, 'Servi su cubetti di ghiaccio fresco.'),
    ('104', 1, 'Sciacqua il filtro sopra il lavandino per evitare di scaldare la caraffa. Versa il caffè macinato. Metti (0.4 x <final_water_amount>)g di ghiaccio nella caraffa. Posiziona la caraffa sulla bilancia e azzerala.'),
    ('104', 2, 'Avvia la preinfusione con (3 x <final_coffee_amount>)g d’acqua.'),
    ('104', 3, 'Mescola leggermente durante la preinfusione.'),
    ('104', 4, 'Lascia il caffè in preinfusione.'),
    ('104', 7, 'Fai ruotare la caraffa per sciogliere il ghiaccio. Versa il caffè su cubetti di ghiaccio fresco.'),
    ('105', 2, 'Avvia la preinfusione con (0.2 x <final_water_amount>)g d’acqua.'),
    ('105', 3, 'Fai ruotare delicatamente il V60.'),
    ('105', 4, 'Lascia il caffè in preinfusione.'),
    ('105', 5, 'Versa fino a (0.4 x <final_water_amount>)g totali.'),
    ('105', 7, 'Versa fino a (0.6 x <final_water_amount>)g totali.'),
    ('105', 12, 'Fai ruotare delicatamente il V60.'),
    ('105', 13, 'Attendi che tutta l’acqua sia filtrata.'),
    ('106', 1, 'Sciacqua il filtro e preriscalda il V60. Versa il caffè macinato. Posiziona il V60 sulla bilancia e azzerala.'),
    ('107', 3, 'Fai ruotare il V60 con una certa energia.'),
    ('107', 5, 'Fai ruotare delicatamente il V60.'),
    ('107', 7, 'Fai ruotare il V60 molto delicatamente.'),
    ('107', 9, 'Fai ruotare di nuovo delicatamente il V60.'),
    ('107', 10, 'Attendi che tutta l’acqua sia filtrata.'),
    ('201', 4, 'Posiziona lo stantuffo sull’AeroPress per impedire all’acqua di filtrare e lascia il caffè in infusione.'),
    ('201', 6, 'Posiziona lo stantuffo sull’AeroPress e premi il contenuto in una tazza grande o in una caraffa usando il peso del corpo.'),
    ('202', 1, 'Posiziona l’AeroPress in posizione standard su una caraffa. Non sciacquare né preriscaldare l’AeroPress: non fa differenza. Versa il caffè macinato.'),
    ('202', 3, 'Inserisci lo stantuffo nella parte superiore dell’AeroPress per circa 1 cm.'),
    ('202', 5, 'Tenendo l’AeroPress e lo stantuffo, fai ruotare delicatamente l’AeroPress.'),
    ('203', 1, 'Aggiungi il caffè macinato alla camera dell’AeroPress. Scuoti leggermente la camera per livellare il letto di caffè.'),
    ('204', 1, 'Posiziona due filtri di carta nel tappo e sciacquali con acqua calda. Elimina le bolle d’aria con la paletta e getta l’acqua di risciacquo. Aggiungi il caffè macinato alla camera dell’AeroPress e scuotila per livellarlo.'),
    ('204', 2, 'Versa <final_water_amount>g d’acqua sul caffè macinato.'),
    ('205', 1, 'Sciacqua due filtri di carta nel tappo per eliminare il sapore di carta e preriscaldare l’AeroPress. Getta l’acqua e metti da parte il tappo. Riempi la caraffa con una quantità di ghiaccio pari a quella dell’acqua. Versa il caffè macinato nell’AeroPress.'),
    ('205', 4, 'Lascia il caffè in preinfusione.'),
    ('205', 5, 'Versa rapidamente la restante quantità d’acqua, (0.7 x <final_water_amount>)g, con movimenti circolari concentrici.'),
    ('205', 6, 'Mescola a fondo la miscela di caffè e acqua, poi avvita il tappo sull’AeroPress.'),
    ('205', 7, 'Capovolgi l’AeroPress sulla caraffa e premi con decisione per 30 secondi sul ghiaccio. Fermati quando l’AeroPress emette un sibilo.'),
    ('205', 8, 'Fai ruotare energicamente il caffè freddo nella caraffa per raffreddarlo, poi servilo in un bicchiere freddo.'),
    ('206', 1, 'Prepara tutta l’attrezzatura e porta l’acqua a ebollizione. Assembla l’AeroPress. Inserisci lo stantuffo nel cilindro per poco meno di 1 cm, assicurandoti che sia allineato. Pesa e macina il caffè. Posiziona l’AeroPress sulla bilancia, versa il caffè macinato e azzerala.'),
    ('206', 3, 'Lascia che si formi una leggera preinfusione.'),
    ('206', 4, 'Mescola alcune volte la miscela di caffè e acqua.'),
    ('206', 6, 'Mescola la miscela altre due volte, facendo attenzione a non farla traboccare.'),
    ('206', 9, 'Posiziona una tazza o una caraffa sopra l’AeroPress capovolta.'),
    ('206', 10, 'Capovolgi insieme l’AeroPress e la caraffa.'),
    ('207', 1, 'Metti (0.4 x <final_water_amount>)g di ghiaccio nella caraffa. Posiziona l’AeroPress in posizione standard sulla caraffa. Non sciacquare né preriscaldare l’AeroPress: non fa differenza. Versa il caffè macinato.'),
    ('207', 3, 'Inserisci lo stantuffo nella parte superiore dell’AeroPress per circa 1 cm.'),
    ('207', 5, 'Tenendo l’AeroPress e lo stantuffo, fai ruotare delicatamente l’AeroPress.'),
    ('207', 8, 'Fai ruotare la caraffa fino a sciogliere tutto il ghiaccio. Servi su cubetti di ghiaccio fresco.'),
    ('208', 1, 'Inserisci il filtro di carta, sciacqualo e posiziona l’AeroPress in posizione standard sulla caraffa. Versa il caffè macinato.'),
    ('208', 4, 'Rimuovi lo stantuffo, versa i restanti (0.75 x <final_water_amount>)g d’acqua e reinserisci lo stantuffo.'),
    ('301', 1, 'Macina i chicchi e porta l’acqua a ebollizione. Inserisci il filtro di carta nella Chemex con le tre pieghe verso il beccuccio. Sciacqua il filtro con acqua bollente e getta l’acqua. Aggiungi il caffè macinato e crea un avvallamento al centro. Posiziona la Chemex sulla bilancia e azzerala.'),
    ('301', 3, 'Mescola per bagnare tutto il caffè macinato, poi lascialo in preinfusione.'),
    ('301', 4, 'Aggiungi acqua con un movimento circolare, rompendo eventuali grumi fino a raggiungere (0.6 x <final_water_amount>)g.'),
    ('301', 7, 'Scuoti leggermente la Chemex.'),
    ('301', 8, 'Attendi che tutta l’acqua sia filtrata.'),
    ('302', 2, 'Avvia la preinfusione con (2 x <final_coffee_amount>)g d’acqua. Versa lentamente a spirale, dal centro verso l’esterno.'),
    ('302', 3, 'Lascia il caffè in preinfusione.'),
    ('302', 6, 'Ripeti lo stesso processo con altri versamenti a immersione completa fino a raggiungere <final_water_amount>g d’acqua. Attendi che tutta l’acqua sia filtrata.'),
    ('303', 1, 'Macina il caffè, scalda l’acqua, piega il filtro di carta e inseriscilo nella Chemex. Sciacqua il filtro e la caraffa, poi aggiungi il caffè macinato.'),
    ('303', 2, 'Avvia la preinfusione con circa (2 x <final_coffee_amount>)g d’acqua. Versa solo l’acqua necessaria a coprire e saturare tutto il caffè macinato.'),
    ('303', 3, 'Lascia il caffè in preinfusione.'),
    ('303', 4, 'Aggiungi acqua fino a (0.33 x <final_water_amount>)g, versando lentamente con un movimento circolare.'),
    ('303', 6, 'Aggiungi altra acqua finché la bilancia indica (0.64 x <final_water_amount>)g.'),
    ('303', 8, 'Aggiungi acqua fino a raggiungere <final_water_amount>g e attendi che tutta l’acqua sia filtrata.'),
    ('304', 1, 'Macina il caffè, scalda l’acqua, piega il filtro di carta e inseriscilo nella Chemex. Sciacqua il filtro e la caraffa, poi aggiungi il caffè macinato.'),
    ('304', 2, 'Avvia la preinfusione con circa (1.5 x <final_coffee_amount>)g d’acqua.'),
    ('304', 4, 'Attendi durante la preinfusione del caffè.'),
    ('304', 5, 'Versa con movimenti circolari fino a raggiungere <final_water_amount>g d’acqua.'),
    ('304', 6, 'Mescola molto lentamente e delicatamente il bordo esterno della miscela di caffè e acqua.'),
    ('304', 8, 'Attendi che tutta l’acqua sia filtrata.'),
    ('305', 2, 'Versa circa (2 x <final_coffee_amount>)g d’acqua, bagnando uniformemente tutto il caffè macinato. Lascia il caffè in preinfusione.'),
    ('403', 2, 'Versa rapidamente <final_water_amount>g d’acqua in una sola volta, assicurandoti di bagnare tutto il caffè macinato.'),
    ('404', 1, 'Piega il filtro di carta, posizionalo nella French Press e sciacqualo con acqua calda. Rimuovi il filtro e mettilo nella tazza. Getta l’acqua. Macina il caffè e versalo nella French Press. Posiziona la French Press sulla bilancia e azzerala.'),
    ('404', 7, 'Inserisci con cautela lo stantuffo con il filtro di carta fissato e premilo lentamente.'),
    ('501', 5, 'Mescola con un cucchiaio o scuoti leggermente il Clever Dripper per rompere la crosta.'),
    ('501', 6, 'Posiziona il Clever Dripper sulla caraffa e attendi che tutta l’acqua sia filtrata.'),
    ('502', 1, 'Inserisci il filtro di carta nel Clever Dripper e sciacqualo con acqua calda. Macina il caffè e versa il caffè macinato nel Clever Dripper.'),
    ('502', 6, 'Posiziona il Clever Dripper sulla caraffa e attendi che tutta l’acqua sia filtrata.'),
    ('503', 1, 'Inserisci il filtro di carta nel Clever Dripper e sciacqualo con acqua calda. Macina il caffè e versa il caffè macinato nel Clever Dripper.'),
    ('503', 6, 'Posiziona il Clever Dripper sulla caraffa e attendi che tutta l’acqua sia filtrata.'),
    ('504', 4, 'Lascia il caffè in infusione. Poco prima della fine, metti (0.34 x <final_water_amount>)g di ghiaccio nella caraffa.'),
    ('504', 5, 'Posiziona il Clever Dripper sulla caraffa e attendi che tutta l’acqua sia filtrata.'),
    ('504', 6, 'Fai ruotare la caraffa o mescola con un cucchiaio per sciogliere il ghiaccio rimasto. Facoltativo: aggiungi alcune gocce di soluzione salina per ridurre l’amaro.'),
    ('601', 3, 'Avvia la preinfusione con (3 x <final_coffee_amount>)g d’acqua.'),
    ('601', 4, 'Fai ruotare leggermente la Kalita Wave; usa il cucchiaio per mescolare, se necessario.'),
    ('601', 5, 'Lascia il caffè in preinfusione.'),
    ('601', 6, 'Versa fino a (0.6 x <final_water_amount>)g.'),
    ('601', 7, 'Attendi che la miscela di caffè e acqua sia filtrata per circa metà.'),
    ('601', 9, 'Fai ruotare delicatamente la Kalita Wave e attendi che tutta l’acqua sia filtrata.'),
    ('602', 1, 'Macina e setaccia il caffè, se lo desideri. Sciacqua il filtro, versa il caffè macinato nella Kalita Wave e scuotila per livellare il letto di caffè.'),
    ('602', 2, 'Avvia la preinfusione con (2 x <final_coffee_amount>)g d’acqua.'),
    ('602', 3, 'Lascia il caffè in preinfusione.'),
    ('602', 6, 'Attendi che tutta l’acqua sia filtrata.'),
    ('603', 1, 'Sciacqua il filtro finché la Kalita Wave è calda. Pesa e macina il caffè. Versa il caffè macinato nella Kalita Wave e scuotila per livellare il letto di caffè.'),
    ('603', 2, 'Versa fino a (0.16 x <final_water_amount>)g d’acqua.'),
    ('603', 6, 'Versa fino a (0.5 x <final_water_amount>)g d’acqua.'),
    ('603', 10, 'Versa fino a (0.83 x <final_water_amount>)g d’acqua.'),
    ('603', 13, 'Attendi che tutta l’acqua sia filtrata.'),
    ('604', 2, 'Avvia il timer. Versa (2.1 x <final_coffee_amount>)g d’acqua, bagnando tutto il caffè macinato. Lascia il caffè in preinfusione.'),
    ('604', 5, 'Lascia gocciolare il caffè finché il flusso rallenta. Rimuovi la Kalita Wave, fai ruotare la caraffa finché il ghiaccio si scioglie e servi su ghiaccio fresco.'),
    ('701', 1, 'Sciacqua il filtro e Wilfa Svart Pour Over con acqua calda. Macina il caffè, versa il caffè macinato e azzera la bilancia. Chiudi il regolatore di flusso.'),
    ('701', 3, 'Fai ruotare leggermente Wilfa Svart Pour Over.'),
    ('701', 7, 'Apri completamente il regolatore di flusso e attendi che tutta l’acqua sia filtrata.'),
    ('702', 1, 'Sciacqua il filtro e Wilfa Svart Pour Over con acqua calda. Macina il caffè, versa il caffè macinato e azzera la bilancia. Chiudi il regolatore di flusso.'),
    ('702', 2, 'Avvia la preinfusione con (2.2 x <final_coffee_amount>)g d’acqua.'),
    ('702', 3, 'Lascia il caffè in preinfusione.'),
    ('702', 4, 'Apri a metà il regolatore di flusso.'),
    ('702', 7, 'Attendi che tutta l’acqua sia filtrata, poi chiudi il regolatore di flusso.'),
    ('703', 1, 'Inserisci il filtro di carta in Wilfa Svart Pour Over e sciacqualo con acqua. Macina il caffè, ma non versarlo ancora. Posiziona Wilfa Svart Pour Over sulla bilancia e azzerala. Prepara un cucchiaio. Ti serviranno (0.34 x <final_water_amount>)g di ghiaccio; per ora lasciali nel congelatore.'),
    ('703', 2, 'Aggiungi (0.66 x <final_water_amount>)g d’acqua a Wilfa Svart Pour Over.'),
    ('703', 4, 'Lascia il caffè in infusione. Poco prima della fine, metti (0.34 x <final_water_amount>)g di ghiaccio nella caraffa.'),
    ('703', 5, 'Posiziona Wilfa Svart Pour Over sulla caraffa e attendi che tutta l’acqua sia filtrata.'),
    ('703', 6, 'Fai ruotare la caraffa o mescola con un cucchiaio per sciogliere il ghiaccio rimasto. Facoltativo: aggiungi alcune gocce di soluzione salina per ridurre l’amaro.'),
    ('801', 2, 'Avvia la preinfusione con (0.2 x <final_water_amount>)g d’acqua e fai ruotare delicatamente l’Origami Dripper alcune volte.'),
    ('801', 3, 'Lascia il caffè in preinfusione.'),
    ('801', 4, 'Versa lentamente a cerchi concentrici fino a (1.0 x <final_water_amount>)g d’acqua, terminando lungo il bordo esterno del filtro. Fai ruotare delicatamente l’Origami Dripper ancora una volta.'),
    ('801', 5, 'Attendi che tutta l’acqua sia filtrata.'),
    ('802', 1, 'Sciacqua il filtro e l’Origami Dripper con acqua calda. Macina il caffè, versa il caffè macinato nell’Origami Dripper e azzera la bilancia.'),
    ('802', 7, 'Attendi che tutta l’acqua sia filtrata.'),
    ('803', 1, 'Sciacqua l’Origami Dripper e il filtro con acqua calda. Macina il caffè, versa il caffè macinato e azzera la bilancia.'),
    ('803', 11, 'Attendi che tutta l’acqua sia filtrata.'),
    ('804', 6, '3ª versata: versa fino a (0.48 x <final_water_amount>)g d’acqua, poi attendi che tutta l’acqua sia filtrata.'),
    ('804', 7, 'Aggiungi (0.52 x <final_water_amount>)g di ghiaccio nella caraffa, falla ruotare delicatamente per raffreddare il caffè e servi.'),
    ('901', 1, 'Macina il caffè, inserisci il filtro nel cestello e sciacqualo con acqua calda. Versa il caffè macinato nel filtro e riempi il serbatoio dell’acqua.'),
    ('901', 4, 'Lascia il caffè in preinfusione e mescola leggermente.'),
    ('1001', 1, 'Inserisci il filtro, sciacqualo con acqua calda e getta l’acqua. Macina il caffè e versalo nel Hario Switch. Porta la leva del Switch in posizione aperta. Prepara una bottiglia d’acqua fredda.'),
    ('1001', 2, 'Aggiungi (3 x <final_coffee_amount>)g d’acqua calda.'),
    ('1001', 3, 'Attendi.'),
    ('1001', 4, 'Aggiungi acqua calda fino a (6 x <final_coffee_amount>)g.'),
    ('1001', 5, 'Aggiungi acqua fredda al bollitore per abbassare la temperatura a circa 70 °C / 158 °F.'),
    ('1001', 6, 'Porta la leva del Switch in posizione chiusa e aggiungi acqua fino a <final_water_amount>g.'),
    ('1001', 7, 'Attendi.'),
    ('1001', 8, 'Porta la leva del Switch in posizione aperta e attendi che tutta l’acqua sia filtrata.'),
    ('1002', 1, 'Inserisci il filtro, sciacqualo con acqua calda e getta l’acqua. Macina il caffè e versalo nel Hario Switch. Porta la leva del Switch in posizione aperta.'),
    ('1002', 2, 'Versa (0.5 x <final_water_amount>)g d’acqua.'),
    ('1002', 3, 'Attendi.'),
    ('1002', 4, 'Porta la leva del Switch in posizione chiusa e versa acqua fino a <final_water_amount>g.'),
    ('1002', 5, 'Attendi.'),
    ('1002', 6, 'Porta la leva del Switch in posizione aperta e lascia filtrare tutta l’acqua.'),
    ('1003', 1, 'Inserisci il filtro, sciacqualo con acqua calda e getta l’acqua. Posiziona il Hario Switch sulla caraffa, versa il caffè macinato e porta la leva del Switch in posizione chiusa.'),
    ('1003', 2, 'Versa (0.25 x <final_water_amount>)g d’acqua.'),
    ('1003', 3, 'Attendi.'),
    ('1003', 4, 'Porta la leva del Switch in posizione aperta e versa acqua fino a <final_water_amount>g al centro del letto di caffè.'),
    ('1003', 5, 'Attendi che tutta l’acqua sia filtrata.'),
    ('1004', 1, 'Inserisci il filtro e sciacqualo con acqua calda. Macina il caffè e versalo nel filtro. Posiziona il Hario Switch sulla bilancia e azzerala. Prepara una bottiglia d’acqua potabile fredda. Porta la leva del Switch in posizione chiusa.'),
    ('1004', 2, 'Versa da (2 x <final_coffee_amount>) a (2.5 x <final_coffee_amount>)g d’acqua.'),
    ('1004', 3, 'Attendi.'),
    ('1004', 4, 'Porta la leva del Switch in posizione aperta.'),
    ('1004', 5, 'Versa fino a (0.4 x <final_water_amount>)g d’acqua.'),
    ('1004', 6, 'Attendi.'),
    ('1004', 7, 'Versa fino a (10 x <final_coffee_amount>)g d’acqua.'),
    ('1004', 8, 'Aggiungi acqua fredda al bollitore per abbassare la temperatura a 70–80 °C (158–176 °F).'),
    ('1004', 9, 'Porta la leva del Switch in posizione chiusa.'),
    ('1004', 10, 'Aggiungi acqua fino a <final_water_amount>g.'),
    ('1004', 11, 'Attendi.'),
    ('1004', 12, 'Porta la leva del Switch in posizione aperta e attendi che tutta l’acqua sia filtrata.')
) as replacement(recipe_id, step_order, description)
where target.recipe_id = replacement.recipe_id
  and target.step_order = replacement.step_order
  and target.locale = 'it';

-- Abort the entire transaction if any approved invariant is still violated.
do $$
declare
  issue_count integer;
begin
  select count(*) into issue_count
  from public.recipe_localization
  where locale = 'it';
  if issue_count <> 45 then
    raise exception 'expected 45 Italian recipe localizations, found %', issue_count;
  end if;

  select count(*) into issue_count
  from public.steps
  where locale = 'it';
  if issue_count <> 326 then
    raise exception 'expected 326 Italian steps, found %', issue_count;
  end if;

  with pairs as (
    select en.recipe_id, en.step_order, en.description en_desc, it.description it_desc
    from public.steps en
    join public.steps it using (recipe_id, step_order)
    where en.locale = 'en' and it.locale = 'it'
  ), placeholder_sets as (
    select
      array(select m[1] from regexp_matches(en_desc, '(<[^>]+>)', 'g') m order by m[1]) en_ph,
      array(select m[1] from regexp_matches(it_desc, '(<[^>]+>)', 'g') m order by m[1]) it_ph
    from pairs
  )
  select count(*) into issue_count
  from placeholder_sets
  where en_ph is distinct from it_ph;
  if issue_count <> 0 then
    raise exception 'Italian placeholder mismatches remain: %', issue_count;
  end if;

  select count(*) into issue_count
  from public.steps
  where locale = 'it'
    and description ~ '\([0-9]+,[0-9]+ x <';
  if issue_count <> 0 then
    raise exception 'Italian comma-decimal scalable expressions remain: %', issue_count;
  end if;

  select count(*) into issue_count
  from public.steps
  where locale = 'it'
    and lower(description) ~ '^[[:space:]]*(aggiungere|attendere|aspettare|gettare|inserire|macinare|mettere|pesare|porre|premere|rimuovere|riempire|rimettere|sciacquare|servire|versare|pre-bagnare)';
  if issue_count <> 0 then
    raise exception 'Italian infinitive step openings remain: %', issue_count;
  end if;

  select count(*) into issue_count
  from public.steps
  where locale = 'it'
    and lower(description) ~ 'fiorisc|fioritur|lascia fiorire|pre-bagn|prebagna|preumid|mescola leggermente il fiore';
  if issue_count <> 0 then
    raise exception 'noncanonical Italian preinfusion terms remain: %', issue_count;
  end if;

  select count(*) into issue_count
  from public.steps
  where locale = 'it'
    and recipe_id in ('1001', '1002', '1003', '1004')
    and lower(description) ~ 'interruttore|rubinetto|chiudi il switch|apri il switch';
  if issue_count <> 0 then
    raise exception 'noncanonical Hario Switch controls remain: %', issue_count;
  end if;

  select count(*) into issue_count
  from public.recipe_localization
  where locale = 'it'
    and (name like '%Aeropress%' or short_description like '%Aeropress%');
  if issue_count <> 0 then
    raise exception 'noncanonical AeroPress spelling remains in metadata: %', issue_count;
  end if;

  select count(*) into issue_count
  from public.steps
  where locale = 'it' and description like '%Aeropress%';
  if issue_count <> 0 then
    raise exception 'noncanonical AeroPress spelling remains in steps: %', issue_count;
  end if;
end
$$;

commit;
