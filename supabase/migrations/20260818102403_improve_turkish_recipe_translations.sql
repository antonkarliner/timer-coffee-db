begin;

create temp table turkish_recipe_metadata_updates (
  recipe_id text primary key,
  name text,
  short_description text
) on commit drop;

insert into turkish_recipe_metadata_updates (recipe_id, name, short_description)
values
  ('1001', $tr$Tetsu Kasuya'nın Hario Switch için "Devil" tarifi$tr$, $tr$Bu tarif, 2016 World Brewers Cup şampiyonu Tetsu Kasuya tarafından geliştirilmiştir. Demlemenin ilk aşamalarında ekstraksiyonu en üst düzeye çıkarmaya, sonraki aşamalarında ise yavaşlatmaya odaklanır. Tetsu'nun bu tarifin arkasındaki yaklaşımı anlattığı [videoyu](https://www.youtube.com/watch?v=gC8K40kZ_6E) izleyebilirsiniz.$tr$),
  ('1002', null, $tr$The Coffee Chronicler'ın Hario Switch tarifi, Tetsu Kasuya'nın yönteminin değiştirilmiş bir versiyonudur ve o da mükemmel bir fincan kahve verir. Daha fazla bilgi için [blog yazısını](https://coffeechronicler.com/hario-switch/#switchrecipe) okuyun. Demleme miktarını (ve süresini) The Coffee Chronicler'ın önerilerine göre ayarlamak için aşağıdaki kaydırıcıyı kullanın.$tr$),
  ('1003', null, $tr$Bu, 2018 World Brewers Cup şampiyonu Emi Fukahori'nin kolayca uygulayabileceğiniz tarifidir. Ayrıntılı bilgi için [eğitim videosunu](https://www.youtube.com/watch?v=3euEkTBxtEk) izleyin.$tr$),
  ('1004', $tr$Tetsu Kasuya'nın 2025 "New Hybrid" Hario Switch tarifi$tr$, null),
  ('103', null, $tr$Yüksek ekstraksiyon, düşük acılık ve buzlu kahvede çekirdeğin tüm incelikleri. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=qwvnQcojq9Q&).$tr$),
  ('104', null, $tr$James Hoffmann'ın buzlu filtre kahve tarifi. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=PApBycDrPo0).$tr$),
  ('106', null, $tr$4:6 yöntemi adını, sıcak suyun döküşler arasında %40 ve %60 olarak bölünmesinden alır; bu sayede kahvenin lezzetini ve yoğunluğunu ayarlayabilirsiniz. Tekniğin yaratıcısı Tetsu Kasuya, bu yöntemle 2016 World Brewers Cup'ı kazandı. Yöntemin nasıl çalıştığını daha iyi anlamak için [eğitim yazısını okuyun](https://en.philocoffea.com/blogs/blog/coffee-brewing-method). Aynı çekirdeği kullanıp her demlemede yalnızca bir parametreyi değiştirerek sonuç üzerindeki etkisini gözlemlemenizi öneririm.$tr$),
  ('201', null, $tr$World Barista Championship ve World Cup Tasters Championship şampiyonu Tim Wendelboe'nin tarifi. [Eğitim videosunu izleyin](https://timwendelboe.no/brew-guides/aeropress/).$tr$),
  ('202', null, $tr$World Barista Championship şampiyonu, YouTuber, kahve danışmanı ve yazar James Hoffmann'ın tarifi. Orta kavrulmuş kahvede 90-95°C su daha iyi sonuç verir. Koyu kavrulmuş kahve için 85-90°C su deneyin. Açık kavrulmuş kahve kullanıyorsanız kahvenizi orta-inceden biraz daha ince öğütün. Kavrum koyulaştıkça dozu artırmayı ve öğütümü kalınlaştırmayı tercih edebilirsiniz. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=j6VlT_jUVPc).$tr$),
  ('203', null, $tr$AeroPress'in mucidi Alan Adler'ın tarifi. Bu tarif konsantre veya espresso tarzı bir kahve verir. Americano tarzı daha uzun bir kahve için damak zevkinize göre sıcak su ekleyebilirsiniz. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=9c14DxfVOY4).$tr$),
  ('204', null, $tr$Hollandalı barista ve 2019 World AeroPress Championship şampiyonu Wendelien van Bunnik'in tarifi. Bunun ters yöntem olduğunu unutmayın. Nasıl çalıştığından emin değilseniz [önce eğitim videosunu izleyin](https://www.youtube.com/watch?v=jLNIGf-lf3s).$tr$),
  ('205', $tr$Alexander Mills'in Buzlu AeroPress tarifi$tr$, null),
  ('206', null, $tr$Kanada, ABD ve World Barista Championship yarışmalarında jüri üyeliği yapan CoffeeGeek kurucusu Mark Prince'ın tarifi. [Ayrıntılı eğitim yazısını okuyun](https://www.coffeegeek.com/guides/aeropress-inverted-brew-method-how-to/). Bunun ters yöntem olduğunu ve Mark'ın kâğıt filtre yerine metal filtre kullanılmasını özellikle önerdiğini unutmayın.$tr$),
  ('207', null, $tr$James Hoffmann'ın buzlu AeroPress tarifi, nihai tekniğinin bypass suyu olarak buz kullanan, ölçeklendirilmiş bir versiyonudur. [Eğitim videosunu izleyin](https://youtu.be/DlaEwef6MTg).$tr$),
  ('208', null, $tr$Bu tarif düşük acılığa, belirgin asiditeye ve canlı, meyvemsi bir karaktere sahip hafif bir kahve verir. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=PUsHI7jdX1k).$tr$),
  ('301', null, $tr$World Barista Championship şampiyonu, YouTuber, kahve danışmanı ve yazar James Hoffmann'ın Chemex tarifi. James, Chemex için V60 tekniğine çok benzeyen bir yöntem öneriyor. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=ikt-X5x7yoc).$tr$),
  ('304', null, $tr$Kafe işletmeciliği, barista eğitimi, kahve kavurma ve demleme alanlarında uzmanlaşmış kahve uzmanı ve yazar Scott Rao'nun Chemex tarifi.$tr$),
  ('401', null, $tr$World Barista Championship şampiyonu, YouTuber, kahve danışmanı ve yazar James Hoffmann'ın French Press tarifi. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=st571DYYTR8).$tr$),
  ('402', null, $tr$World Barista Championship şampiyonu ve SCA yetkili eğitmeni Gwilym Davies'in French Press tarifi. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=AkrqY8LkWM4).$tr$),
  ('403', null, $tr$Kafe işletmeciliği, barista eğitimi, kahve kavurma ve demleme alanlarında uzmanlaşmış kahve uzmanı ve yazar Scott Rao'nun French Press tarifi.$tr$),
  ('404', null, $tr$The Coffee Chronicler olarak da bilinen Asser Christensen'ın French Press tarifi. Bu tarif temiz ve lezzetli bir demleme hedefler. Not: Bu tarifte kâğıt filtre kullanmanız gerekir. Asser sepet biçimli filtreler kullanılmasını önerir; filtre pistonu tamamen kapatmalı ve kenarlardan 2-3 cm veya biraz daha fazla taşmalıdır. [Ayrıntılı eğitim yazısını okuyun](https://coffeechronicler.com/how-to-make-french-press-recipe/).$tr$),
  ('501', null, $tr$World Barista Championship şampiyonu, YouTuber, kahve danışmanı ve yazar James Hoffmann'ın Clever Dripper tarifi. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=RpOdennxP24).$tr$),
  ('504', null, $tr$Bu tarif, James Hoffmann'ın geliştirilmiş daldırma usulü buzlu kahve tekniğini kullanır. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=8uGGeV8A-BM). İsteğe bağlı: Acılığı azaltmak için sonunda birkaç damla salin çözelti (%20 tuz ve %80 su) ekleyebilirsiniz. Not: Kahveyi pour-over için normalden daha ince, ancak espresso inceliğine ulaşmayacak şekilde öğütün.$tr$),
  ('602', null, $tr$James McCarthy'nin 2013 World Brewers Cup'ı kazandığı Kalita Wave tarifi. Ayrıntılı bilgi için [orijinal yazıyı okuyun](https://sprudge.com/meet-the-worlds-best-brewer-james-mccarthy-brewers-cup-champ-38672.html).$tr$),
  ('701', null, $tr$Tim Wendelboe'nin Wilfa Svart Pour Over için daldırma yöntemi tarifi. Tim Wendelboe, World Barista Championship ve World Cup Tasters Championship şampiyonudur. Bu demleyiciyi geliştirmek için Wilfa ile birlikte çalışmıştır.$tr$),
  ('703', null, $tr$Bu tarif, James Hoffmann'ın geliştirilmiş daldırma usulü buzlu kahve tekniğini kullanır. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=8uGGeV8A-BM). İsteğe bağlı: Acılığı azaltmak için sonunda birkaç damla salin çözelti (%20 tuz ve %80 su) ekleyebilirsiniz. Not: Kahveyi pour-over için normalden daha ince, ancak espresso inceliğine ulaşmayacak şekilde öğütün.$tr$),
  ('801', null, $tr$Kahve sektörü danışmanı ve deneyimli bir ev demleyicisi olan [Alexander Mills'in](https://alexandermills.ca/) Origami Dripper tarifi. Bu tarifte Kalita filtreleri kullanılır.$tr$),
  ('802', null, $tr$Origami Dripper tarifi, World Brewers Cup'ı (WBrC) kazanan ilk Çinli barista Jia Ning Du'ya aittir. Bu, onun yarışmayı kazandığı tariftir. [Eğitim videosunu izleyin](https://www.youtube.com/watch?v=HNDnngFhZMU).$tr$),
  ('803', null, $tr$Bu tarif, 2023 World Brewers Cup'ı kazanan Şilili Carlos Medina'ya aittir. Kazanan performansının kaydını [izleyin](https://www.youtube.com/watch?v=Ed8w-RKhR5U). Carlos'un bu tarifte konik filtre kullandığını unutmayın.$tr$),
  ('804', $tr$Kurasu Buzlu Origami Dripper tarifi$tr$, null);

do $$
begin
  if exists (
    select 1
    from turkish_recipe_metadata_updates u
    left join public.recipe_localization r
      on r.recipe_id = u.recipe_id and r.locale = 'tr'
    where r.id is null
  ) then
    raise exception 'Missing Turkish recipe metadata target';
  end if;
end
$$;

update public.recipe_localization r
set
  name = replace(replace(r.name, 'Aeropress', 'AeroPress'), 'James Hoffman', 'James Hoffmann'),
  short_description = replace(replace(r.short_description, 'Aeropress', 'AeroPress'), 'James Hoffman', 'James Hoffmann')
where r.locale = 'tr';

update public.recipe_localization tr
set grind_size = case en.grind_size
  when 'Fine' then 'İnce'
  when 'Fine/Medium' then 'İnce–orta'
  when 'Medium/Fine' then 'İnce–orta'
  when 'Medium fine' then 'Orta-ince'
  when 'Medium-fine' then 'Orta-ince'
  when 'Medium' then 'Orta'
  when 'Medium-Coarse' then 'Orta-kalın'
  when 'Medium-coarse' then 'Orta-kalın'
  when 'Coarse' then 'Kalın'
  when 'Medium-coarse (sea salt)' then 'Orta-kalın (deniz tuzu kıvamında)'
  when 'Medium (like kosher salt)' then 'Orta (koşer tuzu kıvamında)'
  when 'Medium, finer than usual' then 'Orta, normalden daha ince'
  else tr.grind_size
end
from public.recipe_localization en
where tr.locale = 'tr'
  and en.locale = 'en'
  and en.recipe_id = tr.recipe_id;

update public.recipe_localization r
set
  name = coalesce(u.name, r.name),
  short_description = coalesce(u.short_description, r.short_description)
from turkish_recipe_metadata_updates u
where r.locale = 'tr'
  and r.recipe_id = u.recipe_id;

create temp table turkish_step_updates (
  recipe_id text not null,
  step_order integer not null,
  description text not null,
  primary key (recipe_id, step_order)
) on commit drop;

insert into turkish_step_updates (recipe_id, step_order, description)
values
  ('1001', 1, $tr$Filtreyi yerleştirin, sıcak suyla durulayın ve suyu boşaltın. Kahvenizi öğütüp demleyiciye ekleyin. Switch kolunu açın. Bir şişe soğuk su hazırlayın.$tr$),
  ('1001', 2, $tr$Sıcak sudan (3 x <final_coffee_amount>)g ekleyin.$tr$),
  ('1001', 3, $tr$Bekleyin.$tr$),
  ('1001', 5, $tr$Su sıcaklığını yaklaşık 70°C / 158°F'ye düşürmek için su ısıtıcısına soğuk su ekleyin.$tr$),
  ('1001', 6, $tr$Switch kolunu kapatın ve toplam <final_water_amount>g suya ulaşana kadar dökün.$tr$),
  ('1001', 8, $tr$Switch kolunu açın ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('1002', 1, $tr$Filtreyi yerleştirin, sıcak suyla durulayın ve suyu boşaltın. Kahvenizi öğütüp demleyiciye ekleyin. Switch kolunu açın.$tr$),
  ('1002', 4, $tr$Switch kolunu kapatın ve toplam <final_water_amount>g suya ulaşana kadar dökün.$tr$),
  ('1002', 6, $tr$Switch kolunu açın ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('1003', 1, $tr$Filtreyi yerleştirin, sıcak suyla durulayın ve suyu boşaltın. Demleyiciyi bir sürahinin üzerine yerleştirin, öğütülmüş kahveyi ekleyin ve Switch kolunu kapatın.$tr$),
  ('1003', 4, $tr$Switch kolunu açın ve kahve yatağının merkezine dökerek toplam <final_water_amount>g suya ulaşın.$tr$),
  ('1003', 5, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('1004', 1, $tr$Filtreyi yerleştirin ve sıcak suyla durulayın. Kahvenizi öğütüp filtreye koyun. Demleyiciyi terazinin üzerine yerleştirip sıfırlayın. Bir şişe soğuk içme suyu hazırlayın. Switch kolunu kapatın.$tr$),
  ('1004', 4, $tr$Switch kolunu açın.$tr$),
  ('1004', 5, $tr$Toplam (0.4 x <final_water_amount>)g suya ulaşana kadar dökün.$tr$),
  ('1004', 9, $tr$Switch kolunu kapatın.$tr$),
  ('1004', 12, $tr$Switch kolunu açın ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('101', 1, $tr$Filtreyi durulayın ve V60'ı önceden ısıtın. Öğütülmüş kahveyi ekleyip ortasında bir çukur oluşturun.$tr$),
  ('101', 2, $tr$(2 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('101', 3, $tr$Kahve-su karışımı eşitlenene kadar demleyiciyi döndürün.$tr$),
  ('101', 4, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('101', 7, $tr$Kenarlara yapışan öğütülmüş kahveyi düşürmek için saat yönünde ve ters yönde nazikçe karıştırın.$tr$),
  ('101', 8, $tr$Eşit ekstraksiyon için kahve yatağını düzleştirmek üzere demleyiciyi nazikçe döndürün.$tr$),
  ('101', 9, $tr$Süzülmenin 3 dakika 30 saniyede tamamlanmasını hedefleyin.$tr$),
  ('102', 2, $tr$(3 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('102', 3, $tr$Tüm öğütülmüş kahveyi ıslatmak için küçük bir kaşıkla nazikçe karıştırın.$tr$),
  ('102', 4, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('102', 6, $tr$Kenarlara yapışan öğütülmüş kahveyi düşürmek için nazikçe karıştırın.$tr$),
  ('102', 7, $tr$Eşit demleme için kahve yatağını düzleştirmek üzere V60'ı döndürün.$tr$),
  ('102', 8, $tr$Süzülme 3 dakika içinde tamamlanmalıdır.$tr$),
  ('103', 1, $tr$Filtreyi durulayın ve V60'ı önceden ısıtın. Öğütülmüş kahveyi ekleyip düzleştirin.$tr$),
  ('103', 2, $tr$(0.25 x <final_water_amount>)g suyla ön demleme yapın.$tr$),
  ('103', 4, $tr$Yine (0.375 x <final_water_amount>)g su dökün, ardından V60'ı nazikçe döndürün. Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('104', 1, $tr$Sürahiyi ısıtmamak için filtreyi lavabonun üzerinde durulayın. Öğütülmüş kahveyi filtreye ekleyin. Sürahiye (0.4 x <final_water_amount>)g buz koyun. Demleyiciyi ve sürahiyi terazinin üzerine yerleştirip sıfırlayın.$tr$),
  ('104', 2, $tr$(3 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('104', 3, $tr$Ön demlemeyi biraz karıştırın.$tr$),
  ('104', 4, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('104', 7, $tr$Buz eriyene kadar sürahiyi döndürün. Taze buz küplerinin üzerine dökerek servis edin.$tr$),
  ('105', 1, $tr$Filtreyi durulayın ve V60'ı önceden ısıtın. Öğütülmüş kahveyi ekleyin.$tr$),
  ('105', 2, $tr$(0.2 x <final_water_amount>)g suyla ön demleme yapın.$tr$),
  ('105', 3, $tr$V60'ı nazikçe döndürün.$tr$),
  ('105', 4, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('105', 6, $tr$Bekleyin.$tr$),
  ('105', 12, $tr$Demleyiciyi nazikçe döndürün.$tr$),
  ('105', 13, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('106', 1, $tr$Filtreyi durulayın ve V60'ı önceden ısıtın. Öğütülmüş kahveyi ekleyin. Demleyiciyi terazinin üzerine yerleştirip sıfırlayın.$tr$),
  ('201', 1, $tr$Kâğıt filtreyi birkaç saniye akan musluk suyuyla durulayın ve öğütülmüş kahveyi hazneye ekleyin.$tr$),
  ('201', 4, $tr$Suyun filtreden akmasını önlemek için pistonu AeroPress'e yerleştirin ve kahveyi demlenmeye bırakın.$tr$),
  ('201', 6, $tr$Pistonu AeroPress'e yerleştirin ve vücut ağırlığınızı kullanarak kahveyi büyük bir fincana veya sürahiye bastırın.$tr$),
  ('202', 1, $tr$AeroPress'i standart konumda bir sürahinin üzerine yerleştirin. Demleyiciyi durulamayın veya önceden ısıtmayın; bunun sonucu değiştirmediğini unutmayın. Öğütülmüş kahveyi hazneye ekleyin.$tr$),
  ('202', 3, $tr$Pistonu AeroPress'e yaklaşık 1 cm girecek şekilde yerleştirin.$tr$),
  ('202', 5, $tr$AeroPress'i ve pistonu tutarak demleyiciyi nazikçe döndürün.$tr$),
  ('202', 7, $tr$Sonuna kadar nazikçe bastırın.$tr$),
  ('203', 3, $tr$AeroPress karıştırıcısıyla karıştırın.$tr$),
  ('203', 4, $tr$Pistonu yerleştirin ve nazikçe bastırın.$tr$),
  ('204', 1, $tr$Filtre kapağına iki kâğıt filtre yerleştirin ve sıcak suyla durulayın. AeroPress karıştırıcısını kullanarak hava kabarcıklarını çıkarın. Durulama suyunu dökün. Öğütülmüş kahveyi hazneye ekleyin ve yatağı düzleştirmek için hafifçe sallayın.$tr$),
  ('205', 1, $tr$Kâğıt tadını gidermek ve demleyiciyi önceden ısıtmak için filtre kapağındaki iki kâğıt filtreyi durulayın. Suyu dökün ve kapağı kenara koyun. Sürahiye su miktarına eşit miktarda buz koyun. Öğütülmüş kahveyi AeroPress'e ekleyin.$tr$),
  ('205', 2, $tr$AeroPress ters konumdayken (0.3 x <final_water_amount>)g kaynar su dökün.$tr$),
  ('205', 4, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('205', 6, $tr$Kahve-su karışımını dipten yüzeye doğru bir kez karıştırın ve ardından AeroPress'in filtre kapağını takın.$tr$),
  ('205', 8, $tr$Buzlu kahveyi iyice soğutmak için sürahiyi döndürün, ardından soğutulmuş bir bardakta servis edin.$tr$),
  ('206', 1, $tr$Tüm ekipmanınızı ve kahvenizi hazırlayın. Suyu kaynatın. AeroPress'i ters yöntem için kurun: Pistonu gövdeye yaklaşık 1 cm girecek şekilde yerleştirin ve düzgün hizalandığından emin olun. Kahveyi ölçüp öğütün. AeroPress'i terazinin üzerine koyun, öğütülmüş kahveyi ekleyin ve teraziyi sıfırlayın.$tr$),
  ('206', 2, $tr$Ters konumdaki AeroPress'e (0.45 x <final_water_amount>)g kaynar su dökün.$tr$),
  ('206', 3, $tr$Kısa bir ön demleme yapın.$tr$),
  ('206', 4, $tr$Kahve-su karışımını birkaç kez karıştırın.$tr$),
  ('206', 6, $tr$Kahve-su karışımını iki kez daha karıştırın ve haznenin taşmamasına dikkat edin.$tr$),
  ('206', 9, $tr$Kupayı veya sürahiyi ters konumdaki AeroPress'in üzerine yerleştirin.$tr$),
  ('206', 10, $tr$AeroPress'i ve sürahiyi birlikte çevirin.$tr$),
  ('206', 11, $tr$Demlenmiş kahveyi süzmek için AeroPress pistonunu aşağı bastırın.$tr$),
  ('207', 1, $tr$Sürahiye (0.4 x <final_water_amount>)g buz koyun. AeroPress'i standart konumda sürahinin üzerine yerleştirin. Demleyiciyi durulamayın veya önceden ısıtmayın; bunun sonucu değiştirmediğini unutmayın. Öğütülmüş kahveyi hazneye ekleyin.$tr$),
  ('207', 3, $tr$Pistonu AeroPress'e yaklaşık 1 cm girecek şekilde yerleştirin.$tr$),
  ('207', 5, $tr$AeroPress'i ve pistonu tutarak demleyiciyi nazikçe döndürün.$tr$),
  ('207', 8, $tr$Tüm buz eriyene kadar sürahiyi döndürün. Taze buz küpleri üzerinde servis edin.$tr$),
  ('301', 1, $tr$Kahveyi öğütün ve suyu kaynatın. Kâğıt filtreyi Chemex'e, üç katlı kısmı ağıza bakacak şekilde yerleştirin. Filtreyi kaynar suyla durulayıp suyu dökün. Öğütülmüş kahveyi ekleyin ve ortasında bir çukur oluşturun. Chemex'i terazinin üzerine yerleştirip sıfırlayın.$tr$),
  ('301', 3, $tr$Tüm öğütülmüş kahveyi ıslatmak için karıştırın ve kahveyi ön demlemeye bırakın.$tr$),
  ('301', 8, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('302', 1, $tr$Kahveyi öğütün ve suyu ısıtın. Kâğıt filtreyi katlayıp Chemex'e yerleştirin. Filtreyi ve sürahiyi durulayın, ardından öğütülmüş kahveyi ekleyin.$tr$),
  ('302', 2, $tr$(2 x <final_coffee_amount>)g suyla ön demleme yapın. Merkezden başlayıp dışa doğru yavaşça spiral çizerek dökün.$tr$),
  ('302', 3, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('302', 4, $tr$Su seviyesi Chemex'in üst kısmına ulaşana kadar eş merkezli daireler çizerek dökün.$tr$),
  ('302', 5, $tr$Kahve yatağının seviyesi yaklaşık başlangıç düzeyine inene kadar bekleyin.$tr$),
  ('302', 6, $tr$Toplam <final_water_amount>g suya ulaşana kadar aynı doldurma ve bekleme işlemini tekrarlayın. Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('303', 1, $tr$Kahveyi öğütün ve suyu ısıtın. Kâğıt filtreyi katlayıp Chemex'e yerleştirin. Filtreyi ve sürahiyi durulayın, ardından öğütülmüş kahveyi ekleyin.$tr$),
  ('303', 2, $tr$Yaklaşık (2 x <final_coffee_amount>)g suyla ön demleme yapın. Öğütülmüş kahvenin tamamını örtecek ve ıslatacak kadar su dökün.$tr$),
  ('303', 3, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('303', 8, $tr$Toplam <final_water_amount>g suya ulaşana kadar dökün ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('304', 1, $tr$Kahveyi öğütün ve suyu ısıtın. Kâğıt filtreyi katlayıp Chemex'e yerleştirin. Filtreyi ve sürahiyi durulayın, ardından öğütülmüş kahveyi ekleyin.$tr$),
  ('304', 2, $tr$Yaklaşık (1.5 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('304', 4, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('304', 6, $tr$Kahve-su karışımının dış kenarını çok yavaş ve hafifçe karıştırın.$tr$),
  ('304', 7, $tr$Chemex'i dışından tutup birkaç kez dairesel hareketle döndürün.$tr$),
  ('304', 8, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('305', 2, $tr$Tüm öğütülmüş kahveyi ıslatacak şekilde yaklaşık (2 x <final_coffee_amount>)g su dökün ve kahveyi ön demlemeye bırakın.$tr$),
  ('401', 3, $tr$Kahveyi demlenmeye bırakın.$tr$),
  ('401', 6, $tr$Pistonu yerleştirin ancak tamamen aşağı bastırmayın; kahvenin yüzeyinde bırakın. Kahveyi nazikçe dökün.$tr$),
  ('402', 5, $tr$Pistonu yerleştirin ancak henüz aşağı bastırmayın.$tr$),
  ('402', 7, $tr$Pistonu yavaşça aşağı bastırın.$tr$),
  ('403', 3, $tr$Pistonu kahvenin yüzeyinin 1 cm altına yerleştirin.$tr$),
  ('403', 5, $tr$Pistonu nazikçe aşağı bastırın.$tr$),
  ('404', 2, $tr$<final_water_amount>g suyu güçlü bir akışla dökün.$tr$),
  ('404', 5, $tr$Yüzeydeki kabuğu parçalamak için kahveyi nazikçe karıştırın.$tr$),
  ('501', 6, $tr$Clever Dripper'ı bir sürahinin üzerine yerleştirin ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('502', 4, $tr$Üstteki kabuğu bir kaşıkla nazikçe kırın.$tr$),
  ('502', 6, $tr$Clever Dripper'ı sürahinin üzerine yerleştirin ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('503', 6, $tr$Clever Dripper'ı sürahinin üzerine yerleştirin ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('504', 5, $tr$Clever Dripper'ı bir sürahinin üzerine yerleştirin ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('504', 6, $tr$Kalan buz eriyene kadar sürahiyi döndürün veya kaşıkla karıştırın. İsteğe bağlı: Acılığı azaltmak için birkaç damla salin çözelti ekleyin.$tr$),
  ('601', 1, $tr$Kahveyi öğütün. Kâğıt filtreyi sıcak suyla durulayıp Kalita Wave'e yerleştirin. Öğütülmüş kahveyi ekleyin.$tr$),
  ('601', 3, $tr$(3 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('601', 4, $tr$Demleyiciyi hafifçe döndürün; gerekirse kaşıkla karıştırın.$tr$),
  ('601', 5, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('601', 7, $tr$Kahve-su karışımının seviyesi yaklaşık yarıya inene kadar bekleyin.$tr$),
  ('601', 9, $tr$Demleyiciyi nazikçe döndürün ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('602', 1, $tr$Kahveyi öğütün ve isterseniz eleyin. Filtreyi durulayın, öğütülmüş kahveyi Kalita'ya ekleyin ve yatağı düzleştirmek için hafifçe sallayın.$tr$),
  ('602', 2, $tr$(2 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('602', 3, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('602', 4, $tr$Kahve yatağının üzerindeki su seviyesini eşit tutarak aralıklı döküşlerle toplam (0.5 x <final_water_amount>)g suya ulaşın.$tr$),
  ('602', 5, $tr$Mümkünse akış kısıtlayıcılı bir su ısıtıcısı kullanarak aralıklı döküşlerle toplam <final_water_amount>g suya ulaşın.$tr$),
  ('602', 6, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('603', 1, $tr$Demleyici ısınana kadar filtreyi durulayın. Kahveyi tartıp öğütün. Öğütülmüş kahveyi Kalita Wave'e ekleyin ve yatağı düzleştirmek için hafifçe sallayın.$tr$),
  ('603', 13, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('604', 2, $tr$Zamanlayıcıyı başlatın. Tüm öğütülmüş kahveyi ıslatacak şekilde (2.1 x <final_coffee_amount>)g su dökün ve kahveyi ön demlemeye bırakın.$tr$),
  ('701', 1, $tr$Filtreyi ve demleyiciyi sıcak suyla durulayın. Kahvenizi öğütün. Öğütülmüş kahveyi ekleyip teraziyi sıfırlayın. Akış kısıtlayıcısını kapatın.$tr$),
  ('701', 3, $tr$Demleyiciyi biraz döndürün.$tr$),
  ('701', 5, $tr$Yüzeydeki kahve kabuğunu bir kaşıkla nazikçe kırın.$tr$),
  ('701', 7, $tr$Akış kontrolünü tamamen açın ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('702', 2, $tr$(2.2 x <final_coffee_amount>)g suyla ön demleme yapın.$tr$),
  ('702', 3, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('702', 7, $tr$Kahve tamamen süzülene kadar bekleyin ve akış kontrolünü kapatın.$tr$),
  ('703', 4, $tr$Kahveyi demlenmeye bırakın. Demleme süresi bitmek üzereyken sürahiye (0.34 x <final_water_amount>)g buz koyun.$tr$),
  ('703', 5, $tr$Demleyiciyi bir sürahinin üzerine yerleştirin ve kahve tamamen süzülene kadar bekleyin.$tr$),
  ('703', 6, $tr$Kalan buz eriyene kadar sürahiyi döndürün veya kaşıkla karıştırın. İsteğe bağlı: Acılığı azaltmak için birkaç damla salin çözelti ekleyin.$tr$),
  ('801', 2, $tr$(0.2 x <final_water_amount>)g suyla ön demleme yapın ve demleyiciyi birkaç kez nazikçe döndürün.$tr$),
  ('801', 3, $tr$Kahveyi ön demlemeye bırakın.$tr$),
  ('801', 4, $tr$Toplam (1.0 x <final_water_amount>)g suya ulaşana kadar yavaşça eş merkezli daireler çizerek dökün; son döküşü filtrenin dış kenarı çevresinde tamamlayın. Demleyiciyi bir kez daha nazikçe döndürün.$tr$),
  ('801', 5, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('802', 6, $tr$Döküşü tamamlayarak toplam <final_water_amount>g suya ulaşın.$tr$),
  ('802', 7, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('803', 1, $tr$Origami Dripper'ı ve filtreyi sıcak suyla durulayın. Kahvenizi öğütün. Öğütülmüş kahveyi ekleyip teraziyi sıfırlayın.$tr$),
  ('803', 11, $tr$Kahve tamamen süzülene kadar bekleyin.$tr$),
  ('804', 1, $tr$Filtrenizi seçin: Harmanlar için konik filtre, tek kökenli kahveler için Kalita Wave filtresi kullanın. Filtreyi sıcak suyla durulayıp suyu dökün. Kahveyi orta incelikte öğütün, öğütülmüş kahveyi ekleyin ve teraziyi sıfırlayın.$tr$),
  ('804', 6, $tr$3. döküş: Toplam (0.48 x <final_water_amount>)g suya ulaşana kadar dökün, ardından kahve tamamen süzülene kadar bekleyin.$tr$),
  ('804', 7, $tr$Sürahiye (0.52 x <final_water_amount>)g buz ekleyin, soğutmak için sürahiyi nazikçe döndürün ve servis edin.$tr$),
  ('901', 2, $tr$Toplu demleme makinesini açın ve ilk su döküşünün başlamasını bekleyin.$tr$),
  ('901', 3, $tr$Toplu demleme makinesini kapatın.$tr$),
  ('901', 4, $tr$Kahveyi ön demlemeye bırakın ve hafifçe karıştırın.$tr$);

do $$
begin
  if exists (
    select 1
    from turkish_step_updates u
    left join public.steps s
      on s.recipe_id = u.recipe_id
      and s.step_order = u.step_order
      and s.locale = 'tr'
    where s.id is null
  ) then
    raise exception 'Missing Turkish step target';
  end if;
end
$$;

update public.steps s
set description = replace(replace(s.description, 'Aeropress', 'AeroPress'), 'James Hoffman', 'James Hoffmann')
where s.locale = 'tr';

update public.steps s
set description = u.description
from turkish_step_updates u
where s.locale = 'tr'
  and s.recipe_id = u.recipe_id
  and s.step_order = u.step_order;

do $$
declare
  metadata_count integer;
  step_count integer;
begin
  select count(*) into metadata_count
  from public.recipe_localization
  where locale = 'tr';

  select count(*) into step_count
  from public.steps
  where locale = 'tr';

  if metadata_count <> 45 or step_count <> 326 then
    raise exception 'Unexpected Turkish catalog counts: metadata %, steps %', metadata_count, step_count;
  end if;

  if exists (
    select 1
    from turkish_recipe_metadata_updates u
    join public.recipe_localization r
      on r.recipe_id = u.recipe_id and r.locale = 'tr'
    where (u.name is not null and r.name is distinct from u.name)
       or (u.short_description is not null and r.short_description is distinct from u.short_description)
  ) then
    raise exception 'Turkish metadata verification failed';
  end if;

  if exists (
    select 1
    from turkish_step_updates u
    join public.steps s
      on s.recipe_id = u.recipe_id
      and s.step_order = u.step_order
      and s.locale = 'tr'
    where s.description is distinct from u.description
  ) then
    raise exception 'Turkish step verification failed';
  end if;

  if exists (
    select 1
    from public.recipe_localization
    where locale = 'tr'
      and grind_size not in (
        'İnce', 'Orta-ince', 'Orta', 'Orta-kalın', 'Kalın', 'İnce–orta',
        'Orta (koşer tuzu kıvamında)',
        'Orta-kalın (deniz tuzu kıvamında)',
        'Orta, normalden daha ince'
      )
  ) then
    raise exception 'Turkish grind-size normalization failed';
  end if;

  if exists (
    select 1
    from public.recipe_localization
    where locale = 'tr'
      and (name || ' ' || short_description) ~ '(Aeropress|James Hoffman([^n]|$)|Dünya (Demleme|Demleyiciler|Brewers)|Dünya Kupa Tatma)'
  ) then
    raise exception 'Turkish official-name normalization failed';
  end if;

  if exists (
    select 1
    from public.steps
    where locale = 'tr'
      and description ~* '(sunucu|telve|tortu|zemin|hamur|çiçek aç|çiçeklen|Bloom|tam kurum|tam iniş|ters düzleyici|sıkacak|Pouru|önyıkama|çırpın|tam çekim|Plunge|Plunger|Brewer)'
  ) then
    raise exception 'Turkish deprecated step terminology remains';
  end if;

  if exists (
    select 1
    from public.steps en
    join public.steps tr using (recipe_id, step_order)
    where en.locale = 'en'
      and tr.locale = 'tr'
      and en.description ~* '(bloom|pre-wet)'
      and tr.description !~* 'ön demle'
  ) then
    raise exception 'Turkish bloom terminology normalization failed';
  end if;

  if exists (
    select 1
    from public.steps en
    join public.steps tr using (recipe_id, step_order)
    where en.locale = 'en'
      and tr.locale = 'tr'
      and en.description ~* '(swirl|spin)'
      and tr.description !~* '(döndür|çevir)'
  ) then
    raise exception 'Turkish swirl/spin normalization failed';
  end if;

  if exists (
    select 1
    from public.steps en
    join public.steps tr using (recipe_id, step_order)
    where en.locale = 'en'
      and tr.locale = 'tr'
      and en.description ~* 'stir'
      and tr.description !~* 'karıştır'
  ) then
    raise exception 'Turkish stir normalization failed';
  end if;

  if exists (
    select 1
    from public.steps en
    join public.steps tr using (recipe_id, step_order)
    where en.locale = 'en'
      and tr.locale = 'tr'
      and en.description ~* 'shake'
      and tr.description !~* 'salla'
  ) then
    raise exception 'Turkish shake normalization failed';
  end if;

  if exists (
    with pairs as (
      select
        en.recipe_id,
        en.step_order,
        coalesce((
          select array_agg(m[1] order by m[1])
          from regexp_matches(en.description, '(<[^>]+>)', 'g') m
        ), array[]::text[]) as en_placeholders,
        coalesce((
          select array_agg(m[1] order by m[1])
          from regexp_matches(tr.description, '(<[^>]+>)', 'g') m
        ), array[]::text[]) as tr_placeholders
      from public.steps en
      join public.steps tr using (recipe_id, step_order)
      where en.locale = 'en' and tr.locale = 'tr'
    )
    select 1
    from pairs
    where en_placeholders <> tr_placeholders
  ) then
    raise exception 'Turkish placeholder verification failed';
  end if;
end
$$;

commit;
