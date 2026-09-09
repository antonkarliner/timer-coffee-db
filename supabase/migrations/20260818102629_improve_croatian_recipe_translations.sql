begin;

-- Timer.Coffee uses an informal singular voice in Croatian. Normalize the
-- existing catalog before applying exact semantic and terminology fixes.
do $$
declare
  word_map record;
  source_pattern text;
  source_cap text;
  target_cap text;
begin
  for word_map in
    select *
    from (values
      ('ulijte', 'ulij'),
      ('pričekajte', 'pričekaj'),
      ('stavite', 'stavi'),
      ('dodajte', 'dodaj'),
      ('isperite', 'isperi'),
      ('promiješajte', 'promiješaj'),
      ('biste', 'bi'),
      ('sameljite', 'samelji'),
      ('pogledajte', 'pogledaj'),
      ('zavrtite', 'zavrti'),
      ('postavite', 'postavi'),
      ('pustite', 'pusti'),
      ('dosegnete', 'dosegneš'),
      ('umetnite', 'umetni'),
      ('ostavite', 'ostavi'),
      ('otvorite', 'otvori'),
      ('poslužite', 'posluži'),
      ('pritisnite', 'pritisni'),
      ('zagrijte', 'zagrij'),
      ('zatvorite', 'zatvori'),
      ('nemojte', 'nemoj'),
      ('izlijte', 'izlij'),
      ('protresite', 'protresi'),
      ('nastavite', 'nastavi'),
      ('predmočite', 'predmoči'),
      ('pripremite', 'pripremi'),
      ('pročitajte', 'pročitaj'),
      ('tarirajte', 'tariraj'),
      ('uklonite', 'ukloni'),
      ('ulijevajte', 'ulijevaj'),
      ('bacite', 'baci'),
      ('dovršite', 'dovrši'),
      ('imajte', 'imaj'),
      ('možete', 'možeš'),
      ('napravite', 'napravi'),
      ('napunite', 'napuni'),
      ('okrenite', 'okreni'),
      ('poravnajte', 'poravnaj'),
      ('razbijte', 'razbij'),
      ('uključite', 'uključi'),
      ('upotrijebite', 'upotrijebi'),
      ('vam', 'ti'),
      ('dolijte', 'dolij'),
      ('držite', 'drži'),
      ('miješajte', 'miješaj'),
      ('poništite', 'poništi'),
      ('predvlažite', 'predvlaži'),
      ('prelijte', 'prelij'),
      ('presavijte', 'presavij'),
      ('pritiskajte', 'pritišći'),
      ('pričvrstite', 'pričvrsti'),
      ('promiješate', 'promiješaš'),
      ('ubacite', 'ubaci'),
      ('uspite', 'uspi'),
      ('uzmite', 'uzmi'),
      ('vratite', 'vrati'),
      ('zaustavite', 'zaustavi'),
      ('završite', 'završi'),
      ('čujete', 'čuješ'),
      ('ciljajte', 'ciljaj'),
      ('dopustite', 'dopusti'),
      ('dostignete', 'dostigneš'),
      ('iscijedite', 'iscijedi'),
      ('isključite', 'isključi'),
      ('izbacite', 'izbaci'),
      ('izmjerite', 'izmjeri'),
      ('iznultirajte', 'iznultiraj'),
      ('izravnajte', 'izravnaj'),
      ('izvažite', 'izvaži'),
      ('koristite', 'koristi'),
      ('kuhate', 'kuhaš'),
      ('maknite', 'makni'),
      ('mijenjate', 'mijenjaš'),
      ('namočite', 'namoči'),
      ('natopite', 'natopi'),
      ('navlažite', 'navlaži'),
      ('niste', 'nisi'),
      ('odaberite', 'odaberi'),
      ('omotajte', 'omotaj'),
      ('poklopite', 'poklopi'),
      ('pokrenite', 'pokreni'),
      ('pokušajte', 'pokušaj'),
      ('ponovite', 'ponovi'),
      ('prednamočite', 'prednamoči'),
      ('prekrijete', 'prekriješ'),
      ('presavinite', 'presavij'),
      ('pritišćite', 'pritišći'),
      ('prokuhajte', 'prokuhaj'),
      ('prosijte', 'prosij'),
      ('radite', 'radiš'),
      ('sastavite', 'sastavi'),
      ('stanite', 'stani'),
      ('ste', 'si'),
      ('trebate', 'trebaš'),
      ('vidite', 'vidiš'),
      ('zakrećite', 'zakreći'),
      ('zamiješajte', 'zamiješaj'),
      ('započnite', 'započni'),
      ('ćete', 'ćeš'),
      ('želite', 'želiš')
    ) as replacements(source_word, target_word)
  loop
    source_pattern := '\m' || word_map.source_word || '\M';
    source_cap := upper(left(word_map.source_word, 1)) || substr(word_map.source_word, 2);
    target_cap := upper(left(word_map.target_word, 1)) || substr(word_map.target_word, 2);

    update public.steps
    set description = regexp_replace(
      regexp_replace(description, source_pattern, word_map.target_word, 'g'),
      '\m' || source_cap || '\M', target_cap, 'g'
    )
    where locale = 'hr'
      and (description ~ source_pattern or description ~ ('\m' || source_cap || '\M'));

    update public.recipe_localization
    set name = regexp_replace(
          regexp_replace(name, source_pattern, word_map.target_word, 'g'),
          '\m' || source_cap || '\M', target_cap, 'g'
        ),
        short_description = regexp_replace(
          regexp_replace(short_description, source_pattern, word_map.target_word, 'g'),
          '\m' || source_cap || '\M', target_cap, 'g'
        )
    where locale = 'hr'
      and (
        name ~ source_pattern
        or name ~ ('\m' || source_cap || '\M')
        or short_description ~ source_pattern
        or short_description ~ ('\m' || source_cap || '\M')
      );
  end loop;
end
$$;

-- Complete subordinate informal-singular constructions after `biste` -> `bi`.
-- These forms use the same generic masculine voice already present in the app.
do $$
declare
  phrase_map record;
begin
  for phrase_map in
    select *
    from (values
      ('kako bi dobili', 'kako bi dobio'),
      ('kako bi izbjegli', 'kako bi izbjegao'),
      ('kako bi izravnali', 'kako bi izravnao'),
      ('kako bi namočili', 'kako bi namočio'),
      ('kako bi otopili', 'kako bi otopio'),
      ('kako bi poravnali', 'kako bi poravnao'),
      ('kako bi razbili', 'kako bi razbio'),
      ('kako bi razumjeli', 'kako bi razumio'),
      ('kako bi smanjili', 'kako bi smanjio'),
      ('kako bi spriječili', 'kako bi spriječio'),
      ('kako bi uklonili', 'kako bi uklonio'),
      ('kako bi zamijenili', 'kako bi zamijenio'),
      ('da bi dobili', 'da bi dobio'),
      ('da bi izbjegli', 'da bi izbjegao'),
      ('da bi izravnali', 'da bi izravnao'),
      ('da bi namočili', 'da bi namočio'),
      ('da bi otopili', 'da bi otopio'),
      ('da bi poravnali', 'da bi poravnao'),
      ('da bi razbili', 'da bi razbio'),
      ('da bi razumjeli', 'da bi razumio'),
      ('da bi smanjili', 'da bi smanjio'),
      ('da bi spriječili', 'da bi spriječio'),
      ('da bi uklonili', 'da bi uklonio'),
      ('da bi zamijenili', 'da bi zamijenio')
    ) as replacements(source_phrase, target_phrase)
  loop
    update public.steps
    set description = replace(description, phrase_map.source_phrase, phrase_map.target_phrase)
    where locale = 'hr' and description like '%' || phrase_map.source_phrase || '%';

    update public.recipe_localization
    set short_description = replace(
      short_description, phrase_map.source_phrase, phrase_map.target_phrase
    )
    where locale = 'hr'
      and short_description like '%' || phrase_map.source_phrase || '%';
  end loop;
end
$$;

-- Exact metadata fixes: meaning, official product spelling, links, and
-- Croatian terminology for non-product English.
with fixes(recipe_id, name, grind_size, short_description) as (
  values
    ('1003', null::text, null::text,
      'Ovo je jednostavan recept Emi Fukahori, pobjednice natjecanja World Brewers Cup 2018. Pogledaj [video vodič](https://www.youtube.com/watch?v=3euEkTBxtEk) za detaljan prikaz postupka.'),
    ('103', 'Lance Hedrickov ultimativni recept za brzo hlađenu kavu', null,
      'Visoka ekstrakcija, niska gorčina i sve fine arome zrna u ledenoj kavi. [Pogledaj video vodič](https://www.youtube.com/watch?v=qwvnQcojq9Q&)'),
    ('104', 'James Hoffmannov recept za ledeni V60', null,
      'James Hoffmannov pristup ledenoj filter kavi. [Pogledaj video vodič](https://www.youtube.com/watch?v=PApBycDrPo0).'),
    ('107', null, null,
      'Osnovni recept za V60 koji cilja na prinos ekstrakcije od oko 20–23 %. Pogledaj [video](https://www.youtube.com/watch?v=Ji4lZTtRAoo) za detaljno objašnjenje. Lance preporučuje 15–25 g kave.'),
    ('201', 'Recept Tima Wendelboea za AeroPress', null,
      'Recept Tima Wendelboea, svjetskog barista prvaka i svjetskog prvaka u kušanju kave. [Pogledaj vodič](https://timwendelboe.no/brew-guides/aeropress/).'),
    ('202', 'Recept Jamesa Hoffmanna za AeroPress', null, null),
    ('203', 'Recept Alana Adlera za AeroPress', null, null),
    ('204', 'Recept Wendelien van Bunnik za AeroPress', null,
      'Recept Wendelien van Bunnik, nizozemske baristice i svjetske AeroPress prvakinje iz 2019. Napomena: ovo je obrnuta metoda. Ako ne znaš kako funkcionira, [najprije pogledaj vodič](https://www.youtube.com/watch?v=jLNIGf-lf3s).'),
    ('205', 'Recept Alexandera Millsa za ledeni AeroPress', null,
      'Recept Alexandera Millsa, kanadskog konzultanta u industriji kave. Imaj na umu da je ovo obrnuta metoda. Evo [uputa](https://alexandermills.ca/blog/iced-aeropress).'),
    ('206', 'Recept Marka Princea za AeroPress', null,
      'Recept Marka Princea, Kanađanina, suca američkog i svjetskog prvenstva barista te osnivača CoffeeGeeka. Ovdje je [detaljan vodič](https://www.coffeegeek.com/guides/aeropress-inverted-brew-method-how-to/). Imaj na umu da je ovo obrnuta metoda i da Mark snažno preporučuje metalni filter umjesto papirnatog.'),
    ('207', 'Recept Jamesa Hoffmanna za ledeni AeroPress', null,
      'Recept Jamesa Hoffmanna za ledenu kavu u AeroPressu u osnovi je povećana verzija njegove ultimativne tehnike, pri čemu se led koristi kao voda za razrjeđivanje. [Pogledaj video vodič](https://youtu.be/DlaEwef6MTg).'),
    ('208', null, null,
      'Recept daje laganu i sočnu kavu s malo gorčine i ugodnom kiselošću. [Pogledaj video vodič](https://www.youtube.com/watch?v=PUsHI7jdX1k).'),
    ('301', null, null,
      'Chemex recept Jamesa Hoffmanna, pobjednika Svjetskog prvenstva barista, autora, YouTube kreatora i konzultanta za kavu. James za Chemex preporučuje gotovo istu tehniku kao za V60. [Pogledaj video vodič](https://www.youtube.com/watch?v=ikt-X5x7yoc).'),
    ('502', null, null,
      'Recept za Clever Dripper s YouTube kanala European Coffee Trip. Ovdje je [video vodič](https://www.youtube.com/watch?v=H4-XTUpX9Mo).'),
    ('503', null, null,
      'Recept za Clever Dripper s YouTube kanala Coffee and Water. Ovdje je [video vodič](https://www.youtube.com/watch?v=gyZ7Zvvl3uk).'),
    ('504', 'Recept Jamesa Hoffmanna za ledenu kavu u Clever Dripperu', null,
      'Ovaj recept koristi poboljšanu tehniku pripreme ledene kave potpunim uranjanjem prema Jamesu Hoffmannu. Pogledaj [video vodič](https://www.youtube.com/watch?v=8uGGeV8A-BM). Po želji na kraju dodaj nekoliko kapi otopine soli (20 % soli i 80 % vode) kako bi smanjio gorčinu. Kavu samelji finije nego inače za ručno prelijevanje, ali ne tako fino kao za espresso.'),
    ('701', 'Recept Tima Wendelboea za pripremu uranjanjem u Wilfa Svart Pour Overu', null,
      'Recept Tima Wendelboea za pripremu potpunim uranjanjem u Wilfa Svart Pour Overu. Tim je svjetski barista prvak i svjetski prvak u kušanju kave te je surađivao s Wilfom na razvoju ovog uređaja.'),
    ('702', 'Recept za ručno prelijevanje u Wilfa Svart Pour Overu prema Best Coffee', null,
      'Drugi način pripreme s Wilfa Svart Pour Overom je, kao što možeš pretpostaviti, ručno prelijevanje. Ovo je recept portala [Best Coffee](https://www.bestcoffee.guide/blogs/product-reviews/wilfa-pour-over-smart-dripper-review).'),
    ('703', 'Recept za ledenu kavu u Wilfa Svart Pour Overu (James Hoffmann)', null,
      'Ovaj recept koristi poboljšanu tehniku pripreme ledene kave potpunim uranjanjem prema Jamesu Hoffmannu. Pogledaj [video vodič](https://www.youtube.com/watch?v=8uGGeV8A-BM). Po želji na kraju dodaj nekoliko kapi otopine soli (20 % soli i 80 % vode) kako bi smanjio gorčinu. Kavu samelji finije nego inače za ručno prelijevanje, ali ne tako fino kao za espresso.'),
    ('802', null, null,
      'Recept za Origami Dripper Jia Ning Du, prve kineske baristice koja je osvojila World Brewers Cup (WBrC). Ovo je njezin pobjednički recept. [Pogledaj video vodič](https://www.youtube.com/watch?v=HNDnngFhZMU).'),
    ('804', null, 'Srednje', null),
    ('901', 'Osnovni recept za pripremu većih količina kave', null,
      'Ovo je osnovni recept za pripremu većih količina kave koji koristim s Moccamasterom. Trebao bi odgovarati i drugim aparatima.')
)
update public.recipe_localization as target
set name = coalesce(fixes.name, target.name),
    grind_size = coalesce(fixes.grind_size, target.grind_size),
    short_description = coalesce(fixes.short_description, target.short_description)
from fixes
where target.locale = 'hr'
  and target.recipe_id = fixes.recipe_id;

-- Exact step fixes for predinfusion, drawdown, slurry, vessel names, device
-- actions, and the concrete semantic errors approved in review.
with fixes(recipe_id, step_order, description) as (
  values
    ('101', 2, 'Provedi predinfuziju s (2 x <final_coffee_amount>)g vode.'),
    ('101', 4, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('102', 2, 'Provedi predinfuziju s (3 x <final_coffee_amount>)g vode.'),
    ('102', 4, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('103', 2, 'Provedi predinfuziju s (0.25 x <final_water_amount>)g vode.'),
    ('104', 2, 'Provedi predinfuziju s (3 x <final_coffee_amount>)g vode.'),
    ('104', 3, 'Lagano promiješaj kavu tijekom predinfuzije.'),
    ('104', 4, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('105', 2, 'Provedi predinfuziju s (0.2 x <final_water_amount>)g vode.'),
    ('105', 4, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('205', 4, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('206', 3, 'Dopusti kratku predinfuziju.'),
    ('301', 3, 'Promiješaj kako bi sva mljevena kava bila mokra pa je pusti da odstoji tijekom predinfuzije.'),
    ('302', 2, 'Provedi predinfuziju s (2 x <final_coffee_amount>)g vode. Polako ulijevaj spiralno, od sredine prema van.'),
    ('302', 3, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('303', 2, 'Provedi predinfuziju s otprilike (2 x <final_coffee_amount>)g vode. Ulij dovoljno vode preko mljevene kave da je prekriješ i potpuno namočiš.'),
    ('303', 3, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('304', 2, 'Provedi predinfuziju s otprilike (1.5 x <final_coffee_amount>)g vode.'),
    ('304', 4, 'Pričekaj da kava odstoji tijekom predinfuzije.'),
    ('305', 2, 'Ulij oko (2 x <final_coffee_amount>)g vode tako da sva mljevena kava bude mokra. Pusti kavu da odstoji tijekom predinfuzije.'),
    ('601', 3, 'Provedi predinfuziju s (3 x <final_coffee_amount>)g vode.'),
    ('601', 5, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('602', 2, 'Provedi predinfuziju s (2 x <final_coffee_amount>)g vode.'),
    ('602', 3, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('604', 2, 'Pokreni mjerač vremena. Ulij (2.1 x <final_coffee_amount>)g vode tako da sva mljevena kava bude mokra. Pusti kavu da odstoji tijekom predinfuzije.'),
    ('702', 2, 'Provedi predinfuziju s (2.2 x <final_coffee_amount>)g vode.'),
    ('702', 3, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('801', 2, 'Provedi predinfuziju s (0.2 x <final_water_amount>)g vode i nekoliko puta lagano zavrti Origami Dripper.'),
    ('801', 3, 'Pusti kavu da odstoji tijekom predinfuzije.'),
    ('901', 4, 'Pusti kavu da odstoji tijekom predinfuzije i lagano promiješaj.'),

    ('1001', 8, 'Otvori ventil i pričekaj da sva voda prođe kroz filter.'),
    ('1003', 5, 'Pričekaj da sva voda prođe kroz filter.'),
    ('1004', 12, 'Otvori ventil i pričekaj da sva voda prođe kroz filter.'),
    ('101', 9, 'Nastoj završiti cijeđenje do 3 min 30 s.'),
    ('102', 8, 'Cijeđenje bi trebalo završiti unutar 3 minute.'),
    ('105', 13, 'Pričekaj da sva voda prođe kroz filter.'),
    ('107', 10, 'Pričekaj da sva voda prođe kroz filter.'),
    ('301', 8, 'Pričekaj da sva voda prođe kroz filter.'),
    ('302', 6, 'Ponavljaj isti postupak potpunog uranjanja dok ne dosegneš <final_water_amount>g vode. Pričekaj da sva voda prođe kroz filter.'),
    ('303', 8, 'Dodaj vodu dok ne dosegneš <final_water_amount>g i pričekaj da sva voda prođe kroz filter.'),
    ('304', 8, 'Pričekaj da sva voda prođe kroz filter.'),
    ('501', 6, 'Postavi Clever Dripper na vrč i pričekaj da sva voda prođe kroz filter.'),
    ('504', 5, 'Postavi Clever Dripper na vrč i pričekaj da sva voda prođe kroz filter.'),
    ('601', 9, 'Lagano zavrti Kalita Wave i pričekaj da sva voda prođe kroz filter.'),
    ('602', 6, 'Pričekaj da sva voda prođe kroz filter.'),
    ('603', 13, 'Pričekaj da sva voda prođe kroz filter.'),
    ('701', 7, 'Potpuno otvori regulator protoka i pričekaj da sva voda prođe kroz filter.'),
    ('702', 7, 'Pričekaj da sva voda prođe kroz filter pa zatvori regulator protoka.'),
    ('703', 5, 'Postavi Wilfa Svart Pour Over na vrč i pričekaj da sva voda prođe kroz filter.'),
    ('801', 5, 'Pričekaj da sva voda prođe kroz filter.'),
    ('802', 7, 'Pričekaj da sva voda prođe kroz filter.'),
    ('803', 11, 'Pričekaj da sva voda prođe kroz filter.'),

    ('101', 3, 'Zavrti V60 dok mješavina kave i vode ne postane ravnomjerna.'),
    ('205', 6, 'Jednim dubokim pokretom promiješaj mješavinu kave i vode, a zatim zatvori AeroPress poklopcem.'),
    ('206', 4, 'Nekoliko puta promiješaj mješavinu kave i vode.'),
    ('206', 6, 'Još dvaput promiješaj mješavinu kave i vode, pazeći da se ne prelije preko ruba.'),
    ('304', 6, 'Vrlo polako i lagano promiješaj vanjski rub mješavine kave i vode.'),
    ('601', 7, 'Pričekaj da se razina mješavine kave i vode spusti otprilike do pola.'),

    ('1002', 4, 'Zatvori ventil i dolij vode do <final_water_amount>g.'),
    ('1003', 1, 'Umetni filter, isperi ga vrućom vodom i izlij vodu. Postavi Hario Switch na vrč, dodaj mljevenu kavu i zatvori ventil.'),
    ('1004', 8, 'Dodaj hladnu vodu u kuhalo kako bi snizio temperaturu na 70-80°C (158-176°F).'),
    ('101', 7, 'Lagano miješaj u smjeru kazaljke na satu i suprotno kako bi skinuo mljevenu kavu sa stranica.'),
    ('102', 3, 'Nježno promiješaj kako bi smočio svu mljevenu kavu.'),
    ('104', 1, 'Isperi filter iznad sudopera kako ne bi zagrijao vrč. Dodaj mljevenu kavu. Stavi (0.4 x <final_water_amount>)g leda u vrč. Stavi ga na vagu i tariraj.'),
    ('104', 7, 'Zavrti vrč kako bi otopio led. Prelij kavu preko svježih kockica leda u čaši.'),
    ('107', 6, 'Brzo ulijevaj do (11 x <final_coffee_amount>)g vode, usmjeravajući mlaz neposredno iza središta.'),
    ('107', 8, 'Brzo ulijevaj do <final_water_amount>g vode, usmjeravajući mlaz neposredno iza središta.'),
    ('205', 1, 'Isperi dva papirnata filtera u poklopcu kako bi uklonio papirnati okus i prethodno zagrijao AeroPress. Izlij vodu i ostavi poklopac sa strane. Napuni vrč ledom u količini jednakoj količini vode. Dodaj mljevenu kavu u AeroPress.'),
    ('205', 8, 'Dobro zavrti ledenu kavu u vrču kako bi se ohladila, a zatim je posluži u rashlađenoj čaši.'),
    ('206', 11, 'Pritisni klip AeroPressa kako bi istisnuo pripremljenu kavu.'),
    ('207', 1, 'Stavi (0.4 x <final_water_amount>)g leda u vrč. Postavi AeroPress u standardnom položaju na vrč. Nemoj ga ispirati ni prethodno zagrijavati jer to ne utječe na rezultat. Dodaj mljevenu kavu.'),
    ('207', 8, 'Zavrti vrč dok se sav led ne otopi. Posluži preko svježih kockica leda.'),
    ('208', 1, 'Stavi papirnati filter, isperi ga i postavi AeroPress u standardnom položaju na vrč. Dodaj mljevenu kavu.'),
    ('304', 1, 'Samelji kavu, zagrij vodu, presavij papirnati filter i umetni ga u Chemex, isperi filter i karafu te dodaj mljevenu kavu.'),
    ('403', 1, 'Samelji kavu i stavi je u French Press. Postavi ga na vagu i tariraj.'),
    ('501', 4, 'Pusti kavu da se namače 2 minute.'),
    ('502', 1, 'Stavi papirnati filter u Clever Dripper i isperi ga vrućom vodom. Samelji kavu i stavi mljevenu kavu u Clever Dripper.'),
    ('503', 5, 'Pusti kavu da se namače.'),
    ('603', 1, 'Ispiraj filter dok se Kalita Wave ne zagrije. Izvaži i samelji kavu. Dodaj je u Kalita Wave i protresi kako bi je poravnao.'),
    ('701', 4, 'Pusti kavu da se namače.'),
    ('703', 4, 'Pusti kavu da se namače. Pred kraj namakanja stavi (0.34 x <final_water_amount>)g leda u vrč.'),
    ('703', 6, 'Zavrti vrč ili promiješaj žlicom kako bi se preostali led otopio. Po želji dodaj nekoliko kapi otopine soli kako bi smanjio gorčinu.'),
    ('803', 1, 'Isperi Origami Dripper i filter vrućom vodom. Samelji kavu, dodaj je i tariraj vagu.'),
    ('804', 1, 'Odaberi filter — konusni za mješavine ili Kalita Wave filter za kave jednog podrijetla. Isperi filter vrućom vodom i izlij vodu. Samelji kavu srednje finoće, dodaj mljevenu kavu i tariraj vagu.'),
    ('804', 7, 'Dodaj (0.52 x <final_water_amount>)g leda u vrč, lagano ga zavrti kako bi ohladio kavu i posluži.'),
    ('901', 5, 'Ponovno uključi aparat za pripremu većih količina kave i pričekaj da se postupak završi.')
)
update public.steps as target
set description = fixes.description
from fixes
where target.locale = 'hr'
  and target.recipe_id = fixes.recipe_id
  and target.step_order = fixes.step_order;

do $$
declare
  formal_pattern text := '\m(ulijte|pričekajte|stavite|dodajte|isperite|promiješajte|biste|sameljite|pogledajte|zavrtite|postavite|pustite|dosegnete|umetnite|ostavite|otvorite|poslužite|pritisnite|zagrijte|zatvorite|nemojte|izlijte|protresite|nastavite|pripremite|pročitajte|tarirajte|uklonite|ulijevajte|imajte|možete|napunite|okrenite|uključite|vam|niste|trebate)\M';
begin
  if (select count(*) from public.steps where locale = 'hr') = 0 then
    raise notice 'No Croatian catalog rows present (fresh database); skipping.';
    return;
  end if;

  if (select count(*) from public.recipe_localization where locale = 'hr') <> 45 then
    raise exception 'Croatian recipe metadata count changed';
  end if;

  if (select count(*) from public.steps where locale = 'hr') <> 326 then
    raise exception 'Croatian recipe step count changed';
  end if;

  if exists (
    select 1
    from public.steps e
    join public.steps h using (recipe_id, step_order)
    where e.locale = 'en'
      and h.locale = 'hr'
      and coalesce(
        (select array_agg(m[1] order by m[1]) from regexp_matches(e.description, '(<[^>]+>)', 'g') m),
        array[]::text[]
      ) is distinct from coalesce(
        (select array_agg(m[1] order by m[1]) from regexp_matches(h.description, '(<[^>]+>)', 'g') m),
        array[]::text[]
      )
  ) then
    raise exception 'Croatian placeholder parity check failed';
  end if;

  if exists (
    select 1 from public.steps where locale = 'hr' and description ~* formal_pattern
    union all
    select 1 from public.recipe_localization
    where locale = 'hr' and (name ~* formal_pattern or short_description ~* formal_pattern)
  ) then
    raise exception 'Croatian formal-plural wording remains';
  end if;

  if exists (
    select 1
    from (
      select description as text from public.steps where locale = 'hr'
      union all
      select name from public.recipe_localization where locale = 'hr'
      union all
      select short_description from public.recipe_localization where locale = 'hr'
    ) as localized_text
    where text ~* '(mkako bi [[:alpha:]čćžšđ]+liM|mda bi [[:alpha:]čćžšđ]+liM|mAko nisi sigurniM)'
  ) then
    raise exception 'Croatian plural subordinate wording remains';
  end if;

  if exists (
    select 1
    from public.steps
    where locale = 'hr'
      and description ~* '(\mbloom\M|procvjet|\mcvat\M|\mkaša\M|\mserver\M|poslužitelj|fiziološk|povlačenje|izdvajanje|single origin|batch brewer|iced coffee)'
  ) then
    raise exception 'Croatian deprecated step terminology remains';
  end if;

  if exists (
    select 1
    from public.recipe_localization
    where locale = 'hr'
      and (
        name like '%Aeropress%'
        or regexp_replace(
          name || ' ' || short_description,
          'https?://[^)[:space:]]+', '', 'g'
        ) ~* '(^|[^[:alpha:]])(Iced|flash brew|immersion|bypass|tutorial|batch brew|single origin)([^[:alpha:]]|$)'
        or regexp_replace(
          regexp_replace(
            name || ' ' || short_description,
            'https?://[^)[:space:]]+', '', 'g'
          ),
          'Wilfa Svart Pour Over', '', 'g'
        ) ~* 'pour over'
      )
  ) then
    raise exception 'Croatian deprecated metadata terminology remains';
  end if;
end
$$;

commit;
