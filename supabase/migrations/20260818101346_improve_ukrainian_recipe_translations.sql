begin;

create temporary table _uk_metadata_updates (
  recipe_id text primary key,
  name text,
  short_description text
) on commit drop;

insert into _uk_metadata_updates (recipe_id, name, short_description)
values
  ('1001', 'Рецепт «Диявол» Тецу Касуї для Hario Switch', 'Цей рецепт Тецу Касуї, переможця World Brewers Cup 2016 року, зосереджений на максимальній екстракції на початку заварювання та її сповільненні на пізніших етапах. Перегляньте [відео](https://www.youtube.com/watch?v=gC8K40kZ_6E), у якому Тецу пояснює принципи цього рецепта.'),
  ('1002', 'Рецепт Hario Switch від The Coffee Chronicler', 'Рецепт Hario Switch від The Coffee Chronicler — це модифікована версія методу Тецу Касуї, яка також дає чудову чашку кави. [Прочитайте допис у блозі](https://coffeechronicler.com/hario-switch/#switchrecipe), щоб дізнатися більше. Скористайтеся повзунком нижче, щоб налаштувати об’єм і час заварювання відповідно до порад The Coffee Chronicler.'),
  ('1003', 'Рецепт Hario Switch від Емі Фукахорі', 'Це простий рецепт від Емі Фукахорі, переможниці World Brewers Cup 2018 року. Перегляньте [відеоінструкцію](https://www.youtube.com/watch?v=3euEkTBxtEk), щоб докладніше ознайомитися з рецептом.'),
  ('1004', 'Рецепт «Новий гібрид» Тецу Касуї для Hario Switch (2025)', 'Це оновлена версія рецепта Касуї «Диявол», яка зазвичай дає дуже солодку чашку кави. Перегляньте [відео](https://www.youtube.com/watch?v=4FeUp_zNiiY), у якому Тецу пояснює нову техніку.'),
  ('101', 'Рецепт V60 від Джеймса Гоффманна', 'Простий рецепт від Джеймса Гоффманна. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=AI4ynXzkSQo).'),
  ('102', 'Класичний рецепт V60 від Скотта Рао', 'Рецепт V60 від Скотта Рао зосереджений на рівномірній екстракції та стабільному результаті. Скотт Рао [рекомендує](https://www.youtube.com/watch?v=c0Qe_ASxfNM) використовувати пластикову V60: вона краще утримує тепло, а воронку можна рухати під час заварювання, не обпікаючись.'),
  ('103', 'Найкращий рецепт флеш-брю від Ленса Хедріка', 'Висока екстракція, низька гіркота та всі делікатні відтінки зерна в каві на льоду. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=qwvnQcojq9Q&)'),
  ('104', 'Рецепт V60 для кави на льоду від Джеймса Гоффманна', 'Версія фільтр-кави на льоду від Джеймса Гоффманна. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=PApBycDrPo0).'),
  ('105', 'Рецепт V60 на одну чашку від Джеймса Гоффманна', 'Рецепт V60 на одну чашку від Джеймса Гоффманна. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=1oB1oDrDkHM).'),
  ('106', 'Метод 4:6 Тецу Касуї', null),
  ('107', 'Простий та ефективний рецепт V60 від Ленса Хедріка', 'Простий базовий рецепт V60, розрахований на вихід екстракції близько 20–23%. Перегляньте [відео](https://www.youtube.com/watch?v=Ji4lZTtRAoo), щоб дізнатися подробиці. Ленс рекомендує використовувати 15–25 г кави.'),
  ('201', 'Рецепт AeroPress від Тіма Вендельбо', 'Рецепт Тіма Вендельбо, чемпіона світу серед бариста та чемпіона світу з дегустації кави. [Перегляньте відеоінструкцію](https://timwendelboe.no/brew-guides/aeropress/).'),
  ('202', 'Рецепт AeroPress від Джеймса Гоффманна', 'Рецепт Джеймса Гоффманна, переможця World Barista Championship, ютубера, консультанта з кави та автора. Для кави середнього обсмаження вода температурою 90–95°C дасть кращий результат. Для темного обсмаження спробуйте воду температурою 85–90°C. Для кави світлого обсмаження оберіть помел ближче до дрібного краю середнього діапазону. Що темніше обсмаження, то доречніше збільшити дозу й зробити помел грубішим. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=j6VlT_jUVPc).'),
  ('203', 'Рецепт AeroPress від Алана Адлера', 'Рецепт Алана Адлера, винахідника AeroPress. За цим рецептом виходить концентрат або кава в стилі еспресо. Долийте гарячої води до смаку, щоб отримати напій у стилі американо. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=9c14DxfVOY4).'),
  ('204', 'Рецепт AeroPress від Венделін ван Буннік', null),
  ('205', 'Рецепт AeroPress для кави на льоду від Александера Міллса', 'Рецепт Александера Міллса, канадського консультанта в кавовій індустрії. Зверніть увагу: це перевернутий метод. [Прочитайте інструкцію](https://alexandermills.ca/blog/iced-aeropress).'),
  ('206', 'Рецепт AeroPress від Марка Прінса', 'Рецепт Марка Прінса, судді чемпіонатів бариста Канади, США та світу, а також засновника CoffeeGeek. [Прочитайте докладну інструкцію](https://www.coffeegeek.com/guides/aeropress-inverted-brew-method-how-to/). Зверніть увагу: це перевернутий метод, і Марк наполегливо рекомендує використовувати металевий фільтр замість паперового.'),
  ('207', 'AeroPress для кави на льоду від Джеймса Гоффманна', 'Рецепт кави на льоду в AeroPress від Джеймса Гоффманна — це збільшена версія його найкращої техніки, де лід виконує роль байпасної води. [Перегляньте відеоінструкцію](https://youtu.be/DlaEwef6MTg).'),
  ('208', 'Рецепт AeroPress від Coffee with April', 'За цим рецептом виходить легка й соковита кава з низькою гіркотою та приємною кислотністю. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=PUsHI7jdX1k).'),
  ('301', 'Рецепт Chemex від Джеймса Гоффманна', 'Рецепт Chemex від Джеймса Гоффманна, переможця World Barista Championship, ютубера, консультанта з кави та автора. Для Chemex Джеймс рекомендує майже ту саму техніку, що й для V60. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=ikt-X5x7yoc).'),
  ('304', 'Рецепт Chemex від Скотта Рао', 'Рецепт Chemex від Скотта Рао, експерта з кави й автора, який спеціалізується на роботі кав’ярень, навчанні бариста, обсмажуванні та заварюванні кави.'),
  ('401', 'Рецепт френч-пресу від Джеймса Гоффманна', 'Рецепт френч-пресу від Джеймса Гоффманна, переможця World Barista Championship, ютубера, консультанта з кави та автора. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=st571DYYTR8).'),
  ('402', 'Рецепт френч-пресу від Гвіліма Девіса', 'Рецепт френч-пресу від Гвіліма Девіса, чемпіона світу серед бариста й авторизованого тренера SCA. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=AkrqY8LkWM4).'),
  ('403', 'Рецепт френч-пресу від Скотта Рао', 'Рецепт френч-пресу від Скотта Рао, експерта з кави й автора, який спеціалізується на роботі кав’ярень, навчанні бариста, обсмажуванні та заварюванні кави.'),
  ('404', 'Френч-прес для супердегустаторів від The Coffee Chronicler', 'Рецепт френч-пресу від Ассера Крістенсена, відомого як The Coffee Chronicler. Він дає чистий і смачний напій. Для рецепта потрібні паперові фільтри. Ассер рекомендує кошикоподібні фільтри: фільтр має повністю накривати поршень і виступати на 2–3 см з боків або трохи більше. [Прочитайте докладну інструкцію](https://coffeechronicler.com/how-to-make-french-press-recipe/).'),
  ('501', 'Найкращий рецепт Clever Dripper від Джеймса Гоффманна', 'Рецепт Clever Dripper від Джеймса Гоффманна, переможця World Barista Championship, ютубера, консультанта з кави та автора. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=RpOdennxP24).'),
  ('502', 'Рецепт Clever Dripper від European Coffee Trip', 'Рецепт Clever Dripper від YouTube-каналу European Coffee Trip. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=H4-XTUpX9Mo).'),
  ('503', 'Рецепт Clever Dripper від Coffee and Water', 'Рецепт Clever Dripper від YouTube-каналу Coffee and Water. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=gyZ7Zvvl3uk).'),
  ('504', 'Рецепт Clever Dripper для кави на льоду від Джеймса Гоффманна', 'У цьому рецепті використано вдосконалену імерсійну техніку приготування кави на льоду від Джеймса Гоффманна. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=8uGGeV8A-BM). За бажанням наприкінці можна додати кілька крапель сольового розчину (20% солі та 80% води), щоб зменшити гіркоту. Каву потрібно молоти дрібніше, ніж зазвичай для пуроверу, але не настільки дрібно, як для еспресо.'),
  ('601', 'Рецепт Kalita Wave від Скотта Рао', 'Рецепт Kalita Wave від Скотта Рао. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=BjsGf3R9mc0).'),
  ('602', 'Рецепт Kalita Wave від Джеймса Маккарті', 'Рецепт Джеймса Маккарті, який переміг на World Brewers Cup 2013 року з Kalita Wave. Докладніше — [тут](https://sprudge.com/meet-the-worlds-best-brewer-james-mccarthy-brewers-cup-champ-38672.html).'),
  ('603', 'Рецепт Kalita Wave від George Howell Coffee', null),
  ('701', 'Імерсійний рецепт Wilfa Svart Pour Over від Тіма Вендельбо', 'Імерсійний рецепт для Wilfa Svart Pour Over від Тіма Вендельбо, чемпіона світу серед бариста та чемпіона світу з дегустації кави. Тім співпрацював із Wilfa над створенням цієї воронки.'),
  ('702', 'Рецепт пуроверу Wilfa Svart Pour Over від Best Coffee', null),
  ('703', 'Рецепт Wilfa Svart Pour Over для кави на льоду від Джеймса Гоффманна', 'У цьому рецепті використано вдосконалену імерсійну техніку приготування кави на льоду від Джеймса Гоффманна. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=8uGGeV8A-BM). За бажанням наприкінці можна додати кілька крапель сольового розчину (20% солі та 80% води), щоб зменшити гіркоту. Каву потрібно молоти дрібніше, ніж зазвичай для пуроверу, але не настільки дрібно, як для еспресо.'),
  ('801', 'Рецепт Origami Dripper від Александера Міллса', 'Рецепт Origami Dripper від [Александера Міллса](https://alexandermills.ca/), консультанта в кавовій індустрії та захопленого домашнього бариста. Зверніть увагу: у цьому рецепті використовуються фільтри Kalita.'),
  ('802', 'Рецепт Origami Dripper від Цзя Нін Ду', 'Рецепт Origami Dripper від Цзя Нін Ду, першої китайської баристки, яка перемогла на World Brewers Cup. Це її переможний рецепт. [Перегляньте відеоінструкцію](https://www.youtube.com/watch?v=HNDnngFhZMU).'),
  ('804', 'Рецепт Origami Dripper для кави на льоду від Kurasu', 'Рецепт кави на льоду в Origami Dripper, розроблений Мішімою, бариста Kurasu. [Прочитайте оригінальний рецепт](https://kurasu.kyoto/blogs/recipe/new-origami-dripper-iced-coffee-recipe).'),
  ('901', 'Базовий рецепт для автоматичної фільтр-кавоварки', 'Це базовий рецепт, який я використовую з Moccamaster. Він також має працювати з іншими автоматичними фільтр-кавоварками.');

update public.recipe_localization target
set
  name = updates.name,
  short_description = coalesce(updates.short_description, target.short_description)
from _uk_metadata_updates updates
where target.locale = 'uk'
  and target.recipe_id = updates.recipe_id;

update public.recipe_localization target
set grind_size = case source.grind_size
  when 'Fine' then 'Дрібний'
  when 'Fine/Medium' then 'Від дрібного до середнього'
  when 'Medium/Fine' then 'Від дрібного до середнього'
  when 'Medium fine' then 'Середньо-дрібний'
  when 'Medium-fine' then 'Середньо-дрібний'
  when 'Medium' then 'Середній'
  when 'Medium (like kosher salt)' then 'Середній (як кошерна сіль)'
  when 'Medium, finer than usual' then 'Середній, дрібніший за звичайний'
  when 'Medium-Coarse' then 'Середньо-грубий'
  when 'Medium-coarse' then 'Середньо-грубий'
  when 'Medium-coarse (sea salt)' then 'Середньо-грубий (як морська сіль)'
  when 'Coarse' then 'Грубий'
  else target.grind_size
end
from public.recipe_localization source
where target.locale = 'uk'
  and source.locale = 'en'
  and source.recipe_id = target.recipe_id;

create temporary table _uk_step_updates (
  recipe_id text,
  step_order bigint,
  description text not null,
  primary key (recipe_id, step_order)
) on commit drop;

insert into _uk_step_updates (recipe_id, step_order, description)
values
  ('1001', 1, 'Вставте фільтр, промийте його гарячою водою та злийте воду. Змеліть каву й засипте її в Hario Switch. Переведіть важіль Switch у відкрите положення. Підготуйте пляшку холодної води.'),
  ('1001', 6, 'Переведіть важіль Switch у закрите положення й додайте воду до <final_water_amount> г.'),
  ('1001', 8, 'Переведіть важіль Switch у відкрите положення й зачекайте, доки кава повністю стече.'),
  ('1002', 1, 'Вставте фільтр, промийте його гарячою водою та злийте воду. Змеліть каву й засипте її в Hario Switch. Переведіть важіль Switch у відкрите положення.'),
  ('1002', 4, 'Переведіть важіль Switch у закрите положення й долийте воду до <final_water_amount> г.'),
  ('1002', 6, 'Переведіть важіль Switch у відкрите положення й зачекайте, доки кава повністю стече.'),
  ('1003', 1, 'Вставте фільтр, промийте його гарячою водою та злийте воду. Поставте Hario Switch на сервер, засипте мелену каву й переведіть важіль Switch у закрите положення.'),
  ('1003', 4, 'Переведіть важіль Switch у відкрите положення й долийте воду до <final_water_amount> г, спрямовуючи струмінь у центр шару кави.'),
  ('1003', 5, 'Зачекайте, доки кава повністю стече.'),
  ('1004', 1, 'Вставте фільтр і промийте його гарячою водою. Змеліть каву й засипте її у фільтр. Поставте Hario Switch на ваги та обнуліть їх. Підготуйте пляшку холодної питної води. Переведіть важіль Switch у закрите положення.'),
  ('1004', 4, 'Переведіть важіль Switch у відкрите положення.'),
  ('1004', 9, 'Переведіть важіль Switch у закрите положення.'),
  ('1004', 12, 'Переведіть важіль Switch у відкрите положення й зачекайте, доки кава повністю стече.'),
  ('101', 2, 'Виконайте передзмочування, наливши (2 x <final_coffee_amount>) г води.'),
  ('101', 4, 'Залиште каву для передзмочування.'),
  ('101', 8, 'Обережно покрутіть заварник, щоб вирівняти шар кави для рівномірної екстракції.'),
  ('101', 9, 'Намагайтеся завершити стікання до 3 хв 30 с.'),
  ('102', 2, 'Виконайте передзмочування, наливши (3 x <final_coffee_amount>) г води.'),
  ('102', 3, 'Обережно перемішайте шар кави, щоб змочити всю мелену каву.'),
  ('102', 4, 'Залиште каву для передзмочування.'),
  ('102', 8, 'Кава має повністю стекти протягом 3 хвилин.'),
  ('103', 1, 'Промийте фільтр і прогрійте V60. Засипте мелену каву та розрівняйте її.'),
  ('103', 2, 'Виконайте передзмочування, наливши (0.25 x <final_water_amount>) г води.'),
  ('103', 4, 'Ще раз налийте (0.375 x <final_water_amount>) г води й обережно покрутіть заварник. Зачекайте, доки кава повністю стече.'),
  ('104', 1, 'Промийте фільтр над раковиною, щоб не нагрівати сервер. Засипте мелену каву. Покладіть у сервер (0.4 x <final_water_amount>) г льоду. Поставте все на ваги та обнуліть їх.'),
  ('104', 2, 'Виконайте передзмочування, наливши (3 x <final_coffee_amount>) г води.'),
  ('104', 3, 'Трохи перемішайте каву під час передзмочування.'),
  ('104', 4, 'Залиште каву для передзмочування.'),
  ('104', 7, 'Покрутіть сервер, щоб розтопити лід. Налийте каву в склянку зі свіжими кубиками льоду.'),
  ('105', 2, 'Виконайте передзмочування, наливши (0.2 x <final_water_amount>) г води.'),
  ('105', 3, 'Обережно покрутіть V60.'),
  ('105', 4, 'Залиште каву для передзмочування.'),
  ('105', 8, 'Зачекайте.'),
  ('105', 12, 'Обережно покрутіть заварник.'),
  ('105', 13, 'Зачекайте, доки кава повністю стече.'),
  ('106', 3, 'Зачекайте.'),
  ('107', 10, 'Зачекайте, доки кава повністю стече.'),
  ('201', 4, 'Вставте поршень в AeroPress, щоб вода не стікала крізь фільтр, і залиште каву настоюватися.'),
  ('201', 6, 'Вставте поршень в AeroPress і, використовуючи вагу тіла, вичавіть напій у велику чашку або глечик.'),
  ('202', 1, 'Поставте AeroPress у стандартному положенні на сервер. Не промивайте й не прогрівайте його — це не впливає на результат. Засипте мелену каву.'),
  ('202', 5, 'Притримуючи AeroPress і поршень, обережно покрутіть AeroPress.'),
  ('203', 3, 'Перемішайте лопаткою.'),
  ('204', 2, 'Налийте <final_water_amount> г води на мелену каву.'),
  ('205', 1, 'Попередньо промийте два паперові фільтри в кришці, щоб прибрати паперовий присмак і прогріти AeroPress. Злийте воду та відкладіть кришку. Наповніть сервер льодом у кількості, що дорівнює кількості води. Засипте мелену каву в AeroPress.'),
  ('205', 2, 'Тримаючи AeroPress у перевернутому положенні, налийте (0.3 x <final_water_amount>) г окропу.'),
  ('205', 4, 'Залиште каву для передзмочування.'),
  ('205', 6, 'Глибоко перемішайте суміш кави й води один раз, а потім закрутіть кришку AeroPress.'),
  ('205', 7, 'Переверніть AeroPress на сервер і рівномірно натискайте протягом 30 с над льодом. Зупиніться, коли AeroPress зашипить.'),
  ('205', 8, 'Добре покрутіть сервер із кавою на льоду, щоб охолодити напій, а потім подавайте в охолодженій склянці.'),
  ('206', 1, 'Підготуйте все обладнання й каву. Закип’ятіть воду. Зберіть AeroPress. Вставте поршень у камеру AeroPress приблизно на 1 см, переконавшись, що він установлений рівно. Відміряйте й змеліть каву. Поставте AeroPress на ваги, засипте мелену каву та обнуліть ваги.'),
  ('206', 2, 'Налийте (0.45 x <final_water_amount>) г окропу в перевернуту камеру AeroPress.'),
  ('206', 3, 'Дайте каві пройти коротке передзмочування.'),
  ('206', 4, 'Кілька разів перемішайте суміш кави й води.'),
  ('206', 6, 'Ще двічі перемішайте суміш кави й води, стежачи, щоб вона не перелилася через край.'),
  ('206', 8, 'Прикріпіть фільтр і тримач фільтра до AeroPress.'),
  ('206', 9, 'Поставте чашку або сервер на перевернутий AeroPress.'),
  ('206', 10, 'Переверніть AeroPress разом із сервером.'),
  ('206', 11, 'Натисніть на поршень AeroPress, щоб вичавити заварену каву.'),
  ('207', 1, 'Покладіть у сервер (0.4 x <final_water_amount>) г льоду. Поставте AeroPress у стандартному положенні на сервер. Не промивайте й не прогрівайте його — це не впливає на результат. Засипте мелену каву.'),
  ('207', 5, 'Притримуючи AeroPress і поршень, обережно покрутіть AeroPress.'),
  ('207', 8, 'Покрутіть сервер, доки весь лід не розтане. Подавайте зі свіжими кубиками льоду.'),
  ('208', 1, 'Вставте паперовий фільтр, промийте його та поставте AeroPress на сервер у стандартному положенні. Засипте мелену каву.'),
  ('301', 3, 'Перемішайте, щоб змочити всю мелену каву, і залиште її для передзмочування.'),
  ('301', 8, 'Зачекайте, доки кава повністю стече.'),
  ('302', 2, 'Виконайте передзмочування, наливши (2 x <final_coffee_amount>) г води. Лийте повільно по спіралі від центру до країв.'),
  ('302', 3, 'Залиште каву для передзмочування.'),
  ('302', 6, 'Повторюйте такі самі повні вливання, доки загальна кількість води не досягне <final_water_amount> г. Зачекайте, доки кава повністю стече.'),
  ('303', 2, 'Виконайте передзмочування, наливши приблизно (2 x <final_coffee_amount>) г води. Налийте стільки води, щоб уся мелена кава була вкрита й насичена водою.'),
  ('303', 3, 'Залиште каву для передзмочування.'),
  ('303', 8, 'Долийте воду до <final_water_amount> г і зачекайте, доки кава повністю стече.'),
  ('304', 2, 'Виконайте передзмочування, наливши приблизно (1.5 x <final_coffee_amount>) г води.'),
  ('304', 3, 'Обережно перемішайте шар кави маленькою ложкою.'),
  ('304', 4, 'Зачекайте, поки триває передзмочування.'),
  ('304', 6, 'Дуже повільно й обережно перемішайте зовнішній край суміші кави й води.'),
  ('304', 8, 'Зачекайте, доки кава повністю стече.'),
  ('305', 2, 'Налийте приблизно (2 x <final_coffee_amount>) г води, рівномірно змочивши всю мелену каву. Залиште каву для передзмочування.'),
  ('305', 4, 'Зачекайте, доки кава повністю стече, потім зніміть фільтр і подавайте. За бажанням додайте свіжий лід.'),
  ('401', 4, 'Столовою ложкою перемішайте кірку на поверхні кави. Видаліть піну та частинки, що плавають на поверхні.'),
  ('401', 6, 'Вставте поршень, але не натискайте його до кінця — залиште на поверхні кави. Обережно налийте каву в чашку.'),
  ('402', 9, 'Перелийте каву в графин і зачекайте ще 2 хвилини перед подаванням.'),
  ('403', 2, 'Швидко налийте <final_water_amount> г води, переконавшись, що вся мелена кава змокла.'),
  ('404', 1, 'Складіть паперовий фільтр, помістіть його в заварник і промийте гарячою водою. Вийміть фільтр і покладіть його в чашку. Злийте воду. Змеліть каву й засипте її у френч-прес. Поставте на ваги та обнуліть їх.'),
  ('404', 6, 'Зачекайте.'),
  ('404', 7, 'Обережно вставте поршень із прикріпленим паперовим фільтром. Повільно натискайте.'),
  ('501', 6, 'Поставте Clever Dripper на сервер і зачекайте, доки кава повністю стече.'),
  ('502', 6, 'Поставте Clever Dripper на сервер і зачекайте, доки кава повністю стече.'),
  ('503', 4, 'Ложкою розбийте кірку на поверхні кави, перемішавши 3 рази.'),
  ('503', 5, 'Залиште каву настоюватися.'),
  ('503', 6, 'Поставте Clever Dripper на сервер і зачекайте, доки кава повністю стече.'),
  ('504', 4, 'Залиште каву настоюватися. Незадовго до завершення настоювання покладіть у сервер (0.34 x <final_water_amount>) г льоду.'),
  ('504', 5, 'Поставте Clever Dripper на сервер і зачекайте, доки кава повністю стече.'),
  ('504', 6, 'Покрутіть сервер або перемішайте ложкою, щоб розтопити решту льоду. За бажанням додайте кілька крапель сольового розчину, щоб зменшити гіркоту.'),
  ('601', 3, 'Виконайте передзмочування, наливши (3 x <final_coffee_amount>) г води.'),
  ('601', 4, 'Трохи покрутіть Kalita Wave; за потреби перемішайте ложкою.'),
  ('601', 5, 'Залиште каву для передзмочування.'),
  ('601', 7, 'Зачекайте, доки рівень суміші кави й води знизиться приблизно наполовину.'),
  ('601', 9, 'Обережно покрутіть Kalita Wave й зачекайте, доки кава повністю стече.'),
  ('602', 2, 'Виконайте передзмочування, наливши (2 x <final_coffee_amount>) г води.'),
  ('602', 3, 'Залиште каву для передзмочування.'),
  ('602', 5, 'Наливайте порціями до <final_water_amount> г; за можливості використовуйте чайник з обмежувачем потоку.'),
  ('602', 6, 'Зачекайте, доки кава повністю стече.'),
  ('603', 1, 'Промивайте фільтр, доки Kalita Wave не прогріється. Зважте й змеліть каву. Засипте її в Kalita Wave та струсіть, щоб розрівняти шар кави.'),
  ('603', 13, 'Зачекайте, доки кава повністю стече.'),
  ('604', 1, 'Промийте фільтр і прогрійте Kalita Wave та сервер, потім злийте воду. Покладіть у сервер (0.4 x <final_water_amount>) г льоду. Поставте Kalita Wave із сервером на ваги та обнуліть їх. Засипте мелену каву, розрівняйте шар і знову обнуліть ваги.'),
  ('604', 2, 'Запустіть таймер. Виконайте передзмочування, наливши (2.1 x <final_coffee_amount>) г води й рівномірно змочивши всю мелену каву.'),
  ('604', 5, 'Зачекайте, доки потік кави сповільниться. Зніміть Kalita Wave, покрутіть сервер, доки лід не розтане, і подавайте зі свіжим льодом.'),
  ('701', 3, 'Трохи покрутіть Wilfa Svart Pour Over.'),
  ('701', 4, 'Залиште каву настоюватися.'),
  ('701', 7, 'Повністю відкрийте регулятор потоку й зачекайте, доки кава повністю стече.'),
  ('702', 2, 'Виконайте передзмочування, наливши (2.2 x <final_coffee_amount>) г води.'),
  ('702', 3, 'Залиште каву для передзмочування.'),
  ('702', 7, 'Зачекайте, доки кава повністю стече, і закрийте регулятор потоку.'),
  ('703', 4, 'Залиште каву настоюватися. Незадовго до завершення настоювання покладіть у сервер (0.34 x <final_water_amount>) г льоду.'),
  ('703', 5, 'Поставте Wilfa Svart Pour Over на сервер і зачекайте, доки кава повністю стече.'),
  ('703', 6, 'Покрутіть сервер або перемішайте ложкою, щоб розтопити решту льоду. За бажанням додайте кілька крапель сольового розчину, щоб зменшити гіркоту.'),
  ('801', 2, 'Виконайте передзмочування, наливши (0.2 x <final_water_amount>) г води, і кілька разів обережно покрутіть Origami Dripper.'),
  ('801', 3, 'Залиште каву для передзмочування.'),
  ('801', 5, 'Зачекайте, доки кава повністю стече.'),
  ('802', 5, 'Зачекайте.'),
  ('802', 7, 'Зачекайте, доки кава повністю стече.'),
  ('803', 5, 'Зачекайте.'),
  ('803', 7, 'Зачекайте.'),
  ('803', 9, 'Зачекайте.'),
  ('803', 11, 'Зачекайте, доки кава повністю стече.'),
  ('804', 6, '3-тє вливання: долийте воду до (0.48 x <final_water_amount>) г, потім зачекайте, доки кава повністю стече.'),
  ('804', 7, 'Покладіть у сервер (0.52 x <final_water_amount>) г льоду, обережно покрутіть сервер, щоб охолодити напій, і подавайте.'),
  ('901', 4, 'Залиште каву для передзмочування й трохи перемішайте.');

update public.steps target
set description = updates.description
from _uk_step_updates updates
where target.locale = 'uk'
  and target.recipe_id = updates.recipe_id
  and target.step_order = updates.step_order;

update public.steps
set description = replace(description, 'Aeropress', 'AeroPress')
where locale = 'uk'
  and description like '%Aeropress%';

do $$
begin
  if (select count(*) from public.steps where locale = 'uk') = 0 then
    raise notice 'No Ukrainian catalog rows present (fresh database); skipping.';
    return;
  end if;

  if (select count(*) from public.recipe_localization where locale = 'uk') <> 45 then
    raise exception 'Expected 45 Ukrainian metadata rows';
  end if;

  if (select count(*) from public.steps where locale = 'uk') <> 326 then
    raise exception 'Expected 326 Ukrainian step rows';
  end if;

  if exists (
    select 1
    from _uk_metadata_updates expected
    left join public.recipe_localization actual
      on actual.locale = 'uk'
      and actual.recipe_id = expected.recipe_id
    where actual.recipe_id is null
      or actual.name is distinct from expected.name
      or (expected.short_description is not null and actual.short_description is distinct from expected.short_description)
  ) then
    raise exception 'Ukrainian metadata verification failed';
  end if;

  if exists (
    select 1
    from _uk_step_updates expected
    left join public.steps actual
      on actual.locale = 'uk'
      and actual.recipe_id = expected.recipe_id
      and actual.step_order = expected.step_order
    where actual.recipe_id is null
      or actual.description is distinct from expected.description
  ) then
    raise exception 'Ukrainian step verification failed';
  end if;

  if exists (
    select 1
    from public.recipe_localization target
    join public.recipe_localization source using (recipe_id)
    where target.locale = 'uk'
      and source.locale = 'en'
      and (
        (source.grind_size = 'Fine' and target.grind_size <> 'Дрібний')
        or (source.grind_size in ('Fine/Medium', 'Medium/Fine') and target.grind_size <> 'Від дрібного до середнього')
        or (source.grind_size in ('Medium fine', 'Medium-fine') and target.grind_size <> 'Середньо-дрібний')
        or (source.grind_size = 'Medium' and target.grind_size <> 'Середній')
        or (source.grind_size in ('Medium-Coarse', 'Medium-coarse') and target.grind_size <> 'Середньо-грубий')
        or (source.grind_size = 'Coarse' and target.grind_size <> 'Грубий')
      )
  ) then
    raise exception 'Ukrainian grind-size normalization failed';
  end if;

  if exists (
    select 1
    from (
      select coalesce(source.recipe_id, target.recipe_id) as recipe_id
      from (select recipe_id from public.recipe_localization where locale = 'en') source
      full join (select recipe_id from public.recipe_localization where locale = 'uk') target using (recipe_id)
      where source.recipe_id is null or target.recipe_id is null
    ) mismatch
  ) then
    raise exception 'Ukrainian metadata parity failed';
  end if;

  if exists (
    select 1
    from (
      select coalesce(source.recipe_id, target.recipe_id) as recipe_id
      from (select recipe_id, step_order from public.steps where locale = 'en') source
      full join (select recipe_id, step_order from public.steps where locale = 'uk') target using (recipe_id, step_order)
      where source.recipe_id is null or target.recipe_id is null
    ) mismatch
  ) then
    raise exception 'Ukrainian step-order parity failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and array(select match[1] from regexp_matches(source.description, '<([^>]+)>', 'g') match order by match[1])
        is distinct from
          array(select match[1] from regexp_matches(target.description, '<([^>]+)>', 'g') match order by match[1])
  ) then
    raise exception 'Ukrainian placeholder parity failed';
  end if;

  if exists (
    select 1
    from public.recipe_localization source
    join public.recipe_localization target using (recipe_id)
    where source.locale = 'en'
      and target.locale = 'uk'
      and array(select match[1] from regexp_matches(source.short_description, '(https?://[^)[:space:]]+)', 'g') match order by match[1])
        is distinct from
          array(select match[1] from regexp_matches(target.short_description, '(https?://[^)[:space:]]+)', 'g') match order by match[1])
  ) then
    raise exception 'Ukrainian metadata URL parity failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and array(
        select distinct match[1]
        from regexp_matches(
          regexp_replace(regexp_replace(source.description, 'https?://[^)[:space:]]+', '', 'g'), '<[^>]+>', '', 'g'),
          '([0-9]+(?:[.,][0-9]+)?)',
          'g'
        ) match
        order by match[1]
      ) is distinct from array(
        select distinct match[1]
        from regexp_matches(
          regexp_replace(regexp_replace(target.description, 'https?://[^)[:space:]]+', '', 'g'), '<[^>]+>', '', 'g'),
          '([0-9]+(?:[.,][0-9]+)?)',
          'g'
        ) match
        order by match[1]
      )
  ) then
    raise exception 'Ukrainian step numeric parity failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and source.description ~* '\mbloom\M'
      and target.description !~* 'передзмочування'
  ) then
    raise exception 'Ukrainian bloom terminology normalization failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and source.description ~* '\mdrawdown\M'
      and target.description !~* 'стеч|стек|стікан'
  ) then
    raise exception 'Ukrainian drawdown terminology normalization failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and source.description ~* '\mswitch\M'
      and target.description !~* 'важіль Switch'
  ) then
    raise exception 'Ukrainian Hario Switch terminology normalization failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and source.description ~* 'swirl|spin'
      and source.description !~* '\m(stir|mix)\M'
      and target.description ~* 'переміш'
  ) then
    raise exception 'Ukrainian swirl/stir distinction failed';
  end if;

  if exists (
    select 1
    from public.steps source
    join public.steps target using (recipe_id, step_order)
    where source.locale = 'en'
      and target.locale = 'uk'
      and source.description ~* '\mserver\M'
      and target.description !~* '\mсервер'
  ) then
    raise exception 'Ukrainian server terminology normalization failed';
  end if;

  if exists (
    select 1
    from public.steps
    where locale = 'uk'
      and description ~* 'брудер|подстав|палоч|держател|во French|кавове ложе|ліжко кави|Середньо-крупний'
  ) then
    raise exception 'Ukrainian literal mistranslation cleanup failed';
  end if;

  if exists (
    select 1
    from public.recipe_localization
    where locale = 'uk'
      and (
        name ~ '(James Hoffmann|Scott Rao|Lance Hedrick|Gwilym Davies|Jia Ning Du|Aeropress|Аеропресс|Аеропрес)'
        or grind_size in ('Добре', 'Середньо-крупний')
        or short_description ~ '\[(Переглянути|Дивитися|Дивіться|[^]]*туторіал|підручник)'
      )
  ) then
    raise exception 'Ukrainian metadata terminology or CTA cleanup failed';
  end if;
end
$$;

commit;
