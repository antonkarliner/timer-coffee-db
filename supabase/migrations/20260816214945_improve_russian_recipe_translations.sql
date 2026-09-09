begin;

-- Recipe 206 inherited "Mike" from the English source in multiple locales.
-- Correct the person's name without rewriting translations that already say Mark
-- or omit the final attribution.
update public.recipe_localization
set short_description = replace(
  replace(short_description, 'Mike', 'Mark'),
  'Майк',
  'Марк'
)
where recipe_id = '206'
  and (short_description like '%Mike%' or short_description like '%Майк%');

-- Canonical Russian grind-size vocabulary. "Очень крупный" is reserved for
-- a future English "Extra coarse" value; none of the current recipes use it.
update public.recipe_localization as ru
set grind_size = case en.grind_size
  when 'Fine' then 'Мелкий'
  when 'Fine/Medium' then 'От мелкого до среднего'
  when 'Medium/Fine' then 'От мелкого до среднего'
  when 'Medium fine' then 'Средне-мелкий'
  when 'Medium-fine' then 'Средне-мелкий'
  when 'Medium' then 'Средний'
  when 'Medium (like kosher salt)' then 'Средний (как крупная соль)'
  when 'Medium, finer than usual' then 'Средний, мельче обычного'
  when 'Medium-Coarse' then 'Средне-крупный'
  when 'Medium-coarse' then 'Средне-крупный'
  when 'Medium-coarse (sea salt)' then 'Средне-крупный (как морская соль)'
  when 'Coarse' then 'Крупный'
  else btrim(ru.grind_size)
end
from public.recipe_localization as en
where ru.recipe_id = en.recipe_id
  and ru.locale = 'ru'
  and en.locale = 'en';

-- Use one Russian spelling for James Hoffmann in names and descriptions.
update public.recipe_localization
set
  name = replace(name, 'Хоффмана', 'Хоффманна'),
  short_description = replace(
    replace(short_description, 'Хоффмана', 'Хоффманна'),
    'Хоффманом',
    'Хоффманном'
  )
where locale = 'ru'
  and (name ilike '%Хоффман%' or short_description ilike '%Хоффман%');

-- Normalize Tetsu Kasuya to the canonical Russian base form "Тэцу Касуя",
-- inflecting the surname where required by the sentence.
update public.recipe_localization
set
  name = '«Дьявольский» рецепт Тэцу Касуи для Hario Switch',
  short_description = 'Этот рецепт, разработанный Тэцу Касуей, чемпионом World Brewers Cup 2016 года, помогает усилить экстракцию в начале заваривания и замедлить её на поздних этапах. [Посмотрите видео](https://www.youtube.com/watch?v=gC8K40kZ_6E), в котором Тэцу объясняет принципы этого рецепта.'
where recipe_id = '1001' and locale = 'ru';

update public.recipe_localization
set short_description = 'Рецепт Hario Switch от The Coffee Chronicler — это модифицированная версия метода Тэцу Касуи, которая также даёт отличный результат. [Прочитайте статью](https://coffeechronicler.com/hario-switch/#switchrecipe), чтобы узнать больше. Используйте ползунок ниже, чтобы настроить объём и время заваривания по рекомендациям The Coffee Chronicler.'
where recipe_id = '1002' and locale = 'ru';

update public.recipe_localization
set
  name = 'Hario Switch: рецепт «Новый гибрид» 2025 года от Тэцу Касуи',
  short_description = 'Это обновлённая версия «Дьявольского» рецепта Касуи, которая обычно даёт очень сладкую чашку. [Посмотрите видео](https://www.youtube.com/watch?v=4FeUp_zNiiY), в котором Тэцу объясняет новую технику.'
where recipe_id = '1004' and locale = 'ru';

update public.recipe_localization
set
  name = 'Метод 4:6 Тэцу Касуи',
  short_description = 'Метод 4:6 получил своё название от двух стадий заваривания: на первую приходится 40 % общего объёма воды, на вторую — 60 %. Меняя распределение воды, можно контролировать вкус и насыщенность кофе. Создатель метода, Тэцу Касуя, выиграл с ним World Brewers Cup 2016 года. [Прочитайте руководство](https://en.philocoffea.com/blogs/blog/coffee-brewing-method), чтобы лучше понять принцип метода. Попробуйте заварить одни и те же зёрна, меняя только один параметр, чтобы оценить его влияние на вкус.'
where recipe_id = '106' and locale = 'ru';

-- Approved Russian metadata accuracy fixes.
update public.recipe_localization
set short_description = 'Это простой в исполнении рецепт Эми Фукахори, чемпионки World Brewers Cup 2018 года. [Посмотрите видео](https://www.youtube.com/watch?v=3euEkTBxtEk) с подробным разбором.'
where recipe_id = '1003' and locale = 'ru';

update public.recipe_localization
set short_description = 'Рецепт изобретателя AeroPress Алана Адлера. В результате получается кофейный концентрат, похожий на эспрессо. Чтобы получить напиток в стиле американо, добавьте горячую воду по вкусу. [Посмотрите видео](https://www.youtube.com/watch?v=9c14DxfVOY4).'
where recipe_id = '203' and locale = 'ru';

update public.recipe_localization
set short_description = 'Рецепт Марка Принса, судьи чемпионатов Канады, США и мира среди бариста и основателя CoffeeGeek. [Прочитайте подробное руководство](https://www.coffeegeek.com/guides/aeropress-inverted-brew-method-how-to/). Обратите внимание: это перевёрнутый метод. Марк настоятельно рекомендует использовать металлический фильтр вместо бумажного.'
where recipe_id = '206' and locale = 'ru';

update public.recipe_localization
set name = 'Френч-пресс для супердегустаторов от The Coffee Chronicler'
where recipe_id = '404' and locale = 'ru';

update public.recipe_localization
set short_description = 'Иммерсионный рецепт для Wilfa Svart Pour Over от Тима Вендельбё, чемпиона мира среди бариста и чемпиона World Cup Tasters. Тим участвовал в разработке этой воронки совместно с Wilfa.'
where recipe_id = '701' and locale = 'ru';

-- Remove duplicated copy and known spelling errors.
update public.recipe_localization
set short_description = 'Рецепт френч-пресса от Джеймса Хоффманна, победителя чемпионата мира среди бариста, кофейного консультанта и писателя. [Посмотрите видео](https://www.youtube.com/watch?v=st571DYYTR8).'
where recipe_id = '401' and locale = 'ru';

update public.recipe_localization
set short_description = replace(short_description, 'кофейного конультанта', 'кофейного консультанта')
where recipe_id = '601' and locale = 'ru';

-- Standardize Russian link labels by medium: video versus written guide.
update public.recipe_localization
set short_description =
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(short_description,
    '[Смотрите тьюториал]', '[Посмотрите видео]'),
    '[Смотрите обучающее видео]', '[Посмотрите видео]'),
    '[Смотрите инструкцию здесь]', '[Посмотрите видео]'),
    '[Смотрите руководство здесь]', '[Посмотрите видео]'),
    '[Смотрите руководство]', '[Посмотрите видео]'),
    '[Смотрите учебное пособие]', '[Посмотрите видео]'),
    '[Смотрите учебное пособие здесь]', '[Прочитайте руководство]'),
    '[сначала посмотрите учебное пособие]', '[сначала посмотрите видео]'),
    '[учебное пособие ]', '[руководство]'),
    '[тьюториал]', '[видео]'),
    '[тьюториал тут]', '[руководство]'),
    '[инструкция]', '[видео]'),
    '[Вот руководство]', '[Посмотрите видео]'),
    '[Смотрите оригинальное руководство]', '[Прочитайте оригинальное руководство]'),
    '[Посмотрите подробную инструкцию]', '[Прочитайте подробное руководство]'),
    '[подробный гайд]', '[подробное руководство]'),
    '[видеоурок]', '[видео]'),
    '[Почитайте туториал]', '[Прочитайте руководство]')
where locale = 'ru';

update public.recipe_localization
set short_description = replace(
  replace(
    replace(short_description, 'Вот [видео]', '[Посмотрите видео]'),
    'Вот [руководство]',
    '[Прочитайте руководство]'
  ),
  'Смотрите [руководство]',
  '[Прочитайте руководство]'
)
where locale = 'ru';

-- Approved step-level accuracy and omission fixes.
update public.steps
set description = 'Промойте бумажный фильтр под проточной водой в течение нескольких секунд, затем засыпьте молотый кофе.'
where recipe_id = '201' and locale = 'ru' and step_order = 1;

update public.steps
set description = 'Снова влейте (0.375 x <final_water_amount>) г воды, затем аккуратно покрутите V60. Дождитесь полного стекания.'
where recipe_id = '103' and locale = 'ru' and step_order = 4;

update public.steps
set description = 'Добавьте (0.25 x <final_water_amount>) г льда и перемешивайте, пока кофе не охладится до 5–10 °C.'
where recipe_id = '103' and locale = 'ru' and step_order = 5;

update public.steps
set description = 'Порционными проливами доведите общий вес воды до (0.5 x <final_water_amount>) г, поддерживая над кофе равномерный столб воды.'
where recipe_id = '602' and locale = 'ru' and step_order = 4;

update public.steps
set description = 'Медленно, концентрическими кругами, долейте воду до (1.0 x <final_water_amount>) г; последний пролив сделайте по внешнему краю фильтра. Ещё раз слегка покрутите воронку.'
where recipe_id = '801' and locale = 'ru' and step_order = 4;

update public.steps
set description = 'Установите бумажный фильтр, промойте его и поставьте AeroPress на сервер в стандартном положении. Засыпьте молотый кофе.'
where recipe_id = '208' and locale = 'ru' and step_order = 1;

update public.steps
set description = 'Выберите фильтр: конический — для бленда, Kalita Wave — для кофе одного происхождения. Промойте фильтр горячей водой и слейте её. Смелите кофе до среднего помола, засыпьте его в фильтр и обнулите весы.'
where recipe_id = '804' and locale = 'ru' and step_order = 1;

update public.steps set description = 'За следующие 30 секунд долейте воду до (0.6 x <final_water_amount>) г.'
where recipe_id = '101' and locale = 'ru' and step_order = 5;

update public.steps set description = 'За следующие 30 секунд плавно долейте воду до <final_water_amount> г.'
where recipe_id = '101' and locale = 'ru' and step_order = 6;

update public.steps set description = 'Постарайтесь завершить стекание к отметке 3:30.'
where recipe_id = '101' and locale = 'ru' and step_order = 9;

update public.steps set description = 'Стекание должно завершиться к отметке 3:00.'
where recipe_id = '102' and locale = 'ru' and step_order = 8;

update public.steps set description = 'Покрутите сервер, чтобы растопить лёд. Перелейте кофе в бокалы со свежими кубиками льда.'
where recipe_id = '104' and locale = 'ru' and step_order = 7;

update public.steps set description = 'Добавьте (2 x <final_coffee_amount>) г воды. Лейте медленно по спирали, двигаясь от центра к краям.'
where recipe_id = '302' and locale = 'ru' and step_order = 2;

update public.steps set description = 'Порционными проливами доведите общий вес воды до <final_water_amount> г. По возможности используйте чайник с ограниченным потоком.'
where recipe_id = '602' and locale = 'ru' and step_order = 5;

-- Replace look-alike Latin characters and a remaining typo in Russian steps.
update public.steps
set description = replace(description, 'Поcтавьте', 'Поставьте')
where locale = 'ru' and recipe_id in ('401', '402', '403') and step_order = 1;

update public.steps
set description = replace(description, 'веcь', 'весь')
where locale = 'ru' and recipe_id = '703' and step_order = 3;

update public.steps
set description = replace(description, 'Налиейте', 'Налейте')
where locale = 'ru' and recipe_id = '603' and step_order = 12;

commit;
