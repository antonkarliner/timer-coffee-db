begin;

-- Derive every Spanish grind label from the English source instead of fixing
-- individual spellings. This makes the mapping deterministic for all current
-- recipes and prevents case, gender, slash, and hyphen variants from returning.
update public.recipe_localization as es
set grind_size = case en.grind_size
  when 'Fine' then 'Fino'
  when 'Fine/Medium' then 'De fino a medio'
  when 'Medium/Fine' then 'De fino a medio'
  when 'Medium fine' then 'Medio-fino'
  when 'Medium-fine' then 'Medio-fino'
  when 'Medium' then 'Medio'
  when 'Medium (like kosher salt)' then 'Medio (como sal kosher)'
  when 'Medium, finer than usual' then 'Medio, más fino de lo habitual'
  when 'Medium-Coarse' then 'Medio-grueso'
  when 'Medium-coarse' then 'Medio-grueso'
  when 'Medium-coarse (sea salt)' then 'Medio-grueso (como sal marina)'
  when 'Coarse' then 'Grueso'
  else btrim(es.grind_size)
end
from public.recipe_localization as en
where es.recipe_id = en.recipe_id
  and es.locale = 'es'
  and en.locale = 'en';

-- Preserve official product spelling and translate the descriptive French
-- press category consistently.
update public.recipe_localization
set
  name = replace(replace(name, 'Aeropress', 'AeroPress'), 'French Press', 'prensa francesa'),
  short_description = replace(
    replace(short_description, 'Aeropress', 'AeroPress'),
    'French Press',
    'prensa francesa'
  )
where locale = 'es';

update public.steps
set description = replace(
  replace(description, 'Aeropress', 'AeroPress'),
  'French Press',
  'prensa francesa'
)
where locale = 'es';

-- Translate descriptive recipe-name text while preserving product and author
-- names.
update public.recipe_localization as target
set name = replacement.name
from (
  values
    ('103', 'Receta definitiva de café helado por extracción flash de Lance Hedrick'),
    ('104', 'Receta de V60 para café helado de James Hoffmann'),
    ('205', 'Receta de AeroPress para café helado de Alexander Mills'),
    ('401', 'Receta de prensa francesa de James Hoffmann'),
    ('402', 'Receta de prensa francesa de Gwilym Davies'),
    ('403', 'Receta de prensa francesa de Scott Rao'),
    ('404', 'Prensa francesa para supercatadores de The Coffee Chronicler'),
    ('501', 'Receta definitiva para Clever Dripper de James Hoffmann'),
    ('504', 'Receta de Clever Dripper para café helado de James Hoffmann'),
    ('701', 'Receta de inmersión para Wilfa Svart Pour Over de Tim Wendelboe'),
    ('702', 'Receta de café de filtro manual para Wilfa Svart Pour Over de Best Coffee'),
    ('703', 'Receta de café helado para Wilfa Svart Pour Over de James Hoffmann'),
    ('804', 'Receta de café helado para Origami Dripper de Kurasu'),
    ('901', 'Receta básica para cafetera de filtro automática'),
    ('1001', 'Receta «Diablo» de Tetsu Kasuya para Hario Switch'),
    ('1004', 'Receta «Nuevo híbrido» de 2025 para Hario Switch de Tetsu Kasuya')
) as replacement(recipe_id, name)
where target.recipe_id = replacement.recipe_id
  and target.locale = 'es';

-- Restore omitted source details, correct unsupported or inaccurate claims,
-- and keep calls to source material in the app's informal singular voice.
update public.recipe_localization as target
set short_description = replacement.short_description
from (
  values
    ('102', 'La receta V60 de Scott Rao se centra en lograr una extracción uniforme y una preparación consistente. Scott Rao [recomienda](https://www.youtube.com/watch?v=c0Qe_ASxfNM) usar un V60 de plástico para conservar el calor y poder manipularlo durante la preparación sin quemarte.'),
    ('106', 'El método 4:6 recibe su nombre de cómo se divide el agua caliente durante los vertidos: 40 % y 60 %. Esto permite ajustar el sabor y la concentración del café. Tetsu Kasuya, creador de la técnica, ganó la World Brewers Cup 2016 con este método. [Lee la guía](https://en.philocoffea.com/blogs/blog/coffee-brewing-method) para entender mejor cómo funciona. Prueba a preparar los mismos granos y cambia solo un parámetro cada vez para comprobar la diferencia.'),
    ('107', 'Una receta base sencilla para V60 que busca un rendimiento de extracción de aproximadamente el 20–23 %. [Mira el vídeo](https://www.youtube.com/watch?v=Ji4lZTtRAoo) para ver una explicación detallada. Lance recomienda usar entre 15 y 25 g de café.'),
    ('202', 'Receta de James Hoffmann, campeón mundial de baristas, creador de contenido, consultor de café y autor. Para un café de tueste medio, el agua a 90–95 °C dará mejores resultados. Para un tueste oscuro, prueba con agua a 85–90 °C. Si usas un tueste claro, muele el café hacia el extremo fino de un molido medio. Cuanto más oscuro sea el tueste, quizá prefieras aumentar la dosis y usar un molido más grueso. [Mira el vídeo](https://www.youtube.com/watch?v=j6VlT_jUVPc).'),
    ('204', 'Receta de Wendelien van Bunnik, barista neerlandesa y campeona mundial de AeroPress 2019. Ten en cuenta que utiliza el método invertido. Si no sabes cómo funciona, [mira primero el vídeo](https://www.youtube.com/watch?v=jLNIGf-lf3s).'),
    ('206', 'Receta de Mark Prince, juez de los campeonatos de baristas de Canadá, Estados Unidos y del mundo, y fundador de CoffeeGeek. [Lee la guía detallada](https://www.coffeegeek.com/guides/aeropress-inverted-brew-method-how-to/). Ten en cuenta que utiliza el método invertido y que Mark recomienda encarecidamente usar un filtro metálico en lugar de uno de papel.'),
    ('207', 'Esta receta de AeroPress para café helado de James Hoffmann es, en esencia, una versión ampliada de su técnica definitiva que usa hielo como agua de bypass. [Mira el vídeo](https://youtu.be/DlaEwef6MTg).'),
    ('401', 'Receta de prensa francesa de James Hoffmann, campeón mundial de baristas, creador de contenido, consultor de café y autor. [Mira el vídeo](https://www.youtube.com/watch?v=st571DYYTR8).'),
    ('403', 'Receta de prensa francesa de Scott Rao, experto en café y autor especializado en la gestión de cafeterías, la formación de baristas, el tueste y la preparación de café.'),
    ('501', 'Receta para Clever Dripper de James Hoffmann, campeón mundial de baristas, creador de contenido, consultor de café y autor. [Mira el vídeo](https://www.youtube.com/watch?v=RpOdennxP24).'),
    ('504', 'Esta receta utiliza una técnica mejorada de café helado por inmersión de James Hoffmann. [Mira el vídeo](https://www.youtube.com/watch?v=8uGGeV8A-BM). Opcional: añade al final unas gotas de solución salina, compuesta por un 20 % de sal y un 80 % de agua, para reducir el amargor. Nota: usa un molido más fino que para un café de filtro manual, pero no tan fino como para espresso.'),
    ('602', 'Receta de James McCarthy, ganador de la World Brewers Cup 2013 con la Kalita Wave. [Lee más detalles](https://sprudge.com/meet-the-worlds-best-brewer-james-mccarthy-brewers-cup-champ-38672.html).'),
    ('701', 'Receta de inmersión para Wilfa Svart Pour Over de Tim Wendelboe, campeón mundial de baristas y campeón mundial de cata de café. Tim colaboró con Wilfa en la creación de este dripper.'),
    ('702', 'Otra forma de preparar café con el Wilfa Svart Pour Over es mediante café de filtro manual. Esta receta procede de [Best Coffee](https://www.bestcoffee.guide/blogs/product-reviews/wilfa-pour-over-smart-dripper-review).'),
    ('703', 'Esta receta utiliza una técnica mejorada de café helado por inmersión de James Hoffmann. [Mira el vídeo](https://www.youtube.com/watch?v=8uGGeV8A-BM). Opcional: añade al final unas gotas de solución salina, compuesta por un 20 % de sal y un 80 % de agua, para reducir el amargor. Nota: usa un molido más fino que para un café de filtro manual, pero no tan fino como para espresso.'),
    ('801', 'Receta para Origami Dripper de [Alexander Mills](https://alexandermills.ca/), consultor de la industria del café y aficionado entregado a la preparación en casa. Ten en cuenta que esta receta utiliza filtros Kalita.'),
    ('802', 'Receta para Origami Dripper de Jia Ning Du, la primera barista china en ganar la World Brewers Cup (WBrC). Esta es la receta con la que ganó la competición. [Mira el vídeo](https://www.youtube.com/watch?v=HNDnngFhZMU).'),
    ('803', 'Receta de Carlos Medina, de Chile, con la que ganó la World Brewers Cup 2023. [Mira la actuación ganadora](https://www.youtube.com/watch?v=Ed8w-RKhR5U). Ten en cuenta que Carlos utilizó filtros cónicos para esta receta.'),
    ('1001', 'Esta receta, desarrollada por Tetsu Kasuya, campeón de la World Brewers Cup 2016, busca maximizar la extracción al principio de la preparación y ralentizarla en las etapas posteriores. [Mira el vídeo](https://www.youtube.com/watch?v=gC8K40kZ_6E), en el que Tetsu explica los conceptos de la receta.'),
    ('1003', 'Esta es una receta fácil de seguir de Emi Fukahori, campeona de la World Brewers Cup 2018. [Mira el vídeo](https://www.youtube.com/watch?v=3euEkTBxtEk) para conocer todos los detalles.'),
    ('1004', 'Esta es una versión actualizada de la receta «Diablo» de Kasuya que suele producir una taza muy dulce. [Mira el vídeo](https://www.youtube.com/watch?v=4FeUp_zNiiY), en el que Tetsu explica la nueva técnica.')
) as replacement(recipe_id, short_description)
where target.recipe_id = replacement.recipe_id
  and target.locale = 'es';

-- Normalize remaining link labels by medium without changing their targets.
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
  replace(short_description,
    '[Ver vídeo tutorial]', '[Mira el vídeo]'),
    '[Ver el vídeo tutorial]', '[Mira el vídeo]'),
    '[Recomendaciones aquí]', '[Mira el vídeo]'),
    '[Ver tutorial aquí]', '[Mira el vídeo]'),
    '[Ver tutorial]', '[Mira el vídeo]'),
    '[Tutorial aquí]', '[Mira el vídeo]'),
    '[consulta el tutorial]', '[mira el vídeo]'),
    '[Tutorial disponible aquí]', '[Lee la guía]'),
    '[Tutorial detallado aquí]', '[Lee la guía detallada]'),
    '[Más detalles aquí]', '[Lee más detalles]'),
    '[Ver guía]', '[Lee la guía]'),
    '[Lea la guía original]', '[Lee la guía original]'),
    '[Consulta el tutorial detallado]', '[Lee la guía detallada]'),
    '[Ver actuación ganadora]', '[Mira la actuación ganadora]'),
    '[Ver la receta original]', '[Consulta la receta original]')
where locale = 'es';

-- Convert direct instructions to the informal singular register used by the
-- rest of the Spanish app. Replacements are case-sensitive and target command
-- forms at sentence starts; exact technical fixes below take precedence.
with recursive substitutions(ord, source, target) as (
  values
    (1, 'Espere', 'Espera'),
    (2, 'Vierta', 'Vierte'),
    (3, 'Deje', 'Deja'),
    (4, 'Añada', 'Añade'),
    (5, 'Coloque', 'Coloca'),
    (6, 'Enjuague', 'Enjuaga'),
    (7, 'Agregue', 'Añade'),
    (8, 'Muela', 'Muele'),
    (9, 'Esperar', 'Espera'),
    (10, 'Mezcle', 'Remueve'),
    (11, 'Agite', 'Agita'),
    (12, 'Verter', 'Vierte'),
    (13, 'Gire', 'Gira'),
    (14, 'Inserte', 'Inserta'),
    (15, 'Realice', 'Haz'),
    (16, 'Complete', 'Completa'),
    (17, 'Continue', 'Continúa'),
    (18, 'Humedezca', 'Humedece'),
    (19, 'Remueva', 'Remueve'),
    (20, 'Rompa', 'Rompe'),
    (21, 'Abra', 'Abre'),
    (22, 'Continúe', 'Continúa'),
    (23, 'Inicie', 'Inicia'),
    (24, 'Permita', 'Deja'),
    (25, 'Presione', 'Presiona'),
    (26, 'Cave', 'Remueve'),
    (27, 'Cierre', 'Cierra'),
    (28, 'Elija', 'Elige'),
    (29, 'Encienda', 'Enciende'),
    (30, 'Excave', 'Remueve'),
    (31, 'Finalice', 'Finaliza'),
    (32, 'Posicione', 'Coloca'),
    (33, 'Pre-enjuague', 'Enjuaga previamente'),
    (34, 'Pre-moje', 'Humedece previamente'),
    (35, 'Prehumecte', 'Humedece previamente'),
    (36, 'Prepare', 'Prepara'),
    (37, 'Repita', 'Repite'),
    (38, 'Retire', 'Retira'),
    (39, 'Siga', 'Sigue'),
    (40, 'Sirva', 'Sirve'),
    (41, 'Sumerja', 'Baja'),
    (42, 'Utilice', 'Usa'),
    (43, 'Verte', 'Vierte'),
    (44, 'Voltee', 'Da la vuelta a'),
    (45, 'Enjuagar', 'Enjuaga'),
    (46, 'Descarte', 'Desecha'),
    (47, 'Deseche', 'Desecha'),
    (48, 'Revuelva', 'Remueve')
), rewritten(id, ord, description) as (
  select id, 0, description
  from public.steps
  where locale = 'es'

  union all

  select rewritten.id,
         substitutions.ord,
         replace(rewritten.description, substitutions.source, substitutions.target)
  from rewritten
  join substitutions on substitutions.ord = rewritten.ord + 1
)
update public.steps as target
set description = rewritten.description
from rewritten
where target.id = rewritten.id
  and rewritten.ord = (select max(ord) from substitutions)
  and target.description is distinct from rewritten.description;

-- Canonical Spanish preinfusion terminology. Avoid literal coffee "flowering"
-- and the untranslated English term "bloom".
update public.steps
set description =
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(
  replace(description,
    'Prehumedezca con', 'Haz la preinfusión con'),
    'Humedece previamente con', 'Haz la preinfusión con'),
    'Haz el bloom con', 'Haz la preinfusión con'),
    'Realiza el bloom con', 'Haz la preinfusión con'),
    'Humedece inicialmente con', 'Haz la preinfusión con'),
    'Humedece el café con', 'Haz la preinfusión con'),
    'Deja que el café florezca ligeramente.', 'Deja que se forme una ligera preinfusión.'),
    'Deja que el café florezca.', 'Deja el café en preinfusión.'),
    'Espera a que el café florezca.', 'Espera durante la preinfusión.'),
    'la floración', 'la preinfusión')
where locale = 'es';

-- Approved step-level semantic corrections and dry-ground terminology fixes.
update public.steps as target
set description = replacement.description
from (
  values
    ('106', 1, 'Enjuaga el filtro y precalienta el V60. Añade el café molido, coloca el V60 sobre la balanza y ponla a cero.'),
    ('301', 3, 'Remueve para humedecer todo el café molido y déjalo en preinfusión.'),
    ('304', 3, 'Remueve suavemente el lecho de café con una cucharilla.'),
    ('401', 4, 'Remueve la costra de la superficie con una cuchara sopera. Retira la espuma y las partículas flotantes.'),
    ('401', 6, 'Coloca el émbolo sin bajarlo del todo; déjalo sobre la superficie del café. Sirve con cuidado.'),
    ('403', 3, 'Coloca el émbolo 1 cm por debajo de la superficie del café.'),
    ('403', 5, 'Baja el émbolo suavemente.'),
    ('501', 1, 'Coloca el filtro de papel en el Clever Dripper y enjuágalo con agua. Muele el café, pero no lo añadas todavía. Coloca el Clever Dripper sobre la balanza y ponla a cero. Prepara una cuchara.'),
    ('502', 1, 'Coloca el filtro de papel en el Clever Dripper y enjuágalo con agua caliente. Muele el café y añade el café molido al Clever Dripper.'),
    ('503', 1, 'Coloca el filtro de papel en el Clever Dripper y enjuágalo con agua caliente. Muele el café y añade el café molido al Clever Dripper.'),
    ('602', 1, 'Muele y tamiza el café, si lo deseas. Enjuaga el filtro, añade el café molido a la Kalita Wave y agítala para nivelar el lecho.'),
    ('603', 1, 'Enjuaga el filtro hasta que la Kalita Wave esté caliente. Pesa y muele el café. Añade el café molido a la Kalita Wave y agítala para nivelar el lecho.'),
    ('701', 3, 'Gira suavemente el Wilfa Svart Pour Over.'),
    ('801', 1, 'Muele el café y enjuaga el filtro con agua caliente. Coloca el filtro en el Origami Dripper, añade el café molido, pon el dripper sobre la balanza y ponla a cero.'),
    ('802', 1, 'Enjuaga el filtro y el Origami Dripper con agua caliente. Muele el café, añade el café molido al Origami Dripper y pon la balanza a cero.')
) as replacement(recipe_id, step_order, description)
where target.recipe_id = replacement.recipe_id
  and target.step_order = replacement.step_order
  and target.locale = 'es';

-- Use one Hario Switch vocabulary and the informal singular throughout.
update public.steps as target
set description = replacement.description
from (
  values
    ('1001', 1, 'Coloca el filtro, enjuágalo con agua caliente y desecha el agua. Muele el café y añádelo al Hario Switch. Pon la palanca del Switch en posición abierta. Prepara una botella de agua fría.'),
    ('1001', 2, 'Añade (3 x <final_coffee_amount>)g de agua caliente.'),
    ('1001', 3, 'Espera.'),
    ('1001', 4, 'Añade agua caliente hasta (6 x <final_coffee_amount>)g.'),
    ('1001', 5, 'Añade agua fría al hervidor para bajar la temperatura del agua a unos 70 °C / 158 °F.'),
    ('1001', 6, 'Pon la palanca del Switch en posición cerrada y añade agua hasta <final_water_amount>g.'),
    ('1001', 7, 'Espera.'),
    ('1001', 8, 'Pon la palanca del Switch en posición abierta y espera a que el café termine de filtrarse.'),
    ('1002', 1, 'Coloca el filtro, enjuágalo con agua caliente y desecha el agua. Muele el café y añádelo al Hario Switch. Pon la palanca del Switch en posición abierta.'),
    ('1002', 2, 'Vierte (0.5 x <final_water_amount>)g de agua.'),
    ('1002', 3, 'Espera.'),
    ('1002', 4, 'Pon la palanca del Switch en posición cerrada y vierte agua hasta <final_water_amount>g.'),
    ('1002', 5, 'Espera.'),
    ('1002', 6, 'Pon la palanca del Switch en posición abierta y deja que el café termine de filtrarse.'),
    ('1003', 1, 'Coloca el filtro, enjuágalo con agua caliente y desecha el agua. Coloca el Hario Switch sobre una jarra, añade el café molido y pon la palanca del Switch en posición cerrada.'),
    ('1003', 2, 'Vierte (0.25 x <final_water_amount>)g de agua.'),
    ('1003', 3, 'Espera.'),
    ('1003', 4, 'Pon la palanca del Switch en posición abierta y vierte agua hasta <final_water_amount>g en el centro del lecho de café.'),
    ('1003', 5, 'Espera a que el café termine de filtrarse.'),
    ('1004', 1, 'Coloca el filtro y enjuágalo con agua caliente. Muele el café y añádelo al filtro. Coloca el Hario Switch sobre la balanza y ponla a cero. Prepara una botella de agua fría potable. Pon la palanca del Switch en posición cerrada.'),
    ('1004', 2, 'Vierte entre (2 x <final_coffee_amount>) y (2.5 x <final_coffee_amount>)g de agua.'),
    ('1004', 3, 'Espera.'),
    ('1004', 4, 'Pon la palanca del Switch en posición abierta.'),
    ('1004', 5, 'Vierte agua hasta (0.4 x <final_water_amount>)g.'),
    ('1004', 6, 'Espera.'),
    ('1004', 7, 'Vierte agua hasta (10 x <final_coffee_amount>)g.'),
    ('1004', 8, 'Añade agua fría al hervidor para bajar la temperatura a 70–80 °C (158–176 °F).'),
    ('1004', 9, 'Pon la palanca del Switch en posición cerrada.'),
    ('1004', 10, 'Añade agua hasta <final_water_amount>g.'),
    ('1004', 11, 'Espera.'),
    ('1004', 12, 'Pon la palanca del Switch en posición abierta y espera a que el café termine de filtrarse.')
) as replacement(recipe_id, step_order, description)
where target.recipe_id = replacement.recipe_id
  and target.step_order = replacement.step_order
  and target.locale = 'es';

-- Standardize the remaining device/category wording and untranslated commands.
update public.steps
set description = replace(description, 'cafetera de lote', 'cafetera de filtro automática')
where locale = 'es' and recipe_id = '901';

update public.steps
set description = replace(description, 'Continue', 'Continúa')
where locale = 'es' and recipe_id in ('301', '602', '702');

-- Multi-sentence instructions need exact rewrites because Spanish formal and
-- informal imperatives can occur after conjunctions and punctuation, where a
-- sentence-opening substitution is insufficient.
update public.steps as target
set description = replacement.description
from (
  values
    ('101', 1, 'Enjuaga el filtro y precalienta el V60. Añade el café molido y haz un hueco en el centro.'),
    ('101', 3, 'Gira el V60 hasta que la mezcla sea homogénea.'),
    ('102', 1, 'Enjuaga el filtro y precalienta el V60. Añade el café molido y nivela el lecho.'),
    ('103', 1, 'Enjuaga el filtro y precalienta el V60. Añade el café molido y nivela el lecho.'),
    ('103', 4, 'Añade de nuevo (0.375 x <final_water_amount>)g de agua y gira suavemente el V60. Espera a que el café termine de filtrarse.'),
    ('103', 5, 'Añade (0.25 x <final_water_amount>)g de hielo y remueve hasta enfriar el café a 5–10 °C.'),
    ('104', 1, 'Enjuaga el filtro sobre el fregadero para no calentar la jarra. Añade el café molido al V60. Pon (0.4 x <final_water_amount>)g de hielo en la jarra, coloca el conjunto sobre la balanza y ponla a cero.'),
    ('104', 7, 'Gira la jarra para derretir el hielo. Sirve el café en vasos con cubitos de hielo nuevos.'),
    ('105', 1, 'Enjuaga el filtro y precalienta el V60. Añade el café molido.'),
    ('205', 1, 'Enjuaga previamente dos filtros de papel en la tapa para eliminar el sabor a papel y precalentar la AeroPress. Desecha el agua y reserva la tapa. Llena la jarra con una cantidad de hielo igual a la cantidad de agua. Añade el café molido a la AeroPress.'),
    ('205', 2, 'Con la AeroPress invertida, añade (0.3 x <final_water_amount>)g de agua hirviendo.'),
    ('205', 7, 'Coloca la AeroPress sobre la jarra y presiona de forma constante durante 30 segundos sobre el hielo. Detente cuando oigas el silbido.'),
    ('205', 8, 'Gira bien la jarra para enfriar el café y sírvelo en un vaso frío.'),
    ('206', 1, 'Prepara el equipo y el café. Hierve el agua y monta la AeroPress. Introduce el émbolo casi 1 cm en el cilindro y comprueba que esté bien alineado. Pesa y muele el café. Coloca la AeroPress sobre la balanza, añade el café molido y ponla a cero.'),
    ('301', 1, 'Muele el café y hierve el agua. Coloca el filtro de papel en la Chemex con los tres pliegues hacia el pico. Enjuaga el filtro con agua hirviendo y desecha el agua. Añade el café molido, haz un hueco en el centro, coloca la Chemex sobre la balanza y ponla a cero.'),
    ('302', 1, 'Muele el café y calienta el agua. Dobla el filtro de papel, colócalo en la Chemex y enjuaga el filtro y la jarra. Añade el café molido.'),
    ('302', 6, 'Repite el proceso con vertidos adicionales hasta alcanzar <final_water_amount>g de agua. Espera a que el café termine de filtrarse.'),
    ('303', 1, 'Muele el café y calienta el agua. Dobla el filtro de papel, colócalo en la Chemex y enjuaga el filtro y la jarra. Añade el café molido.'),
    ('303', 8, 'Añade agua hasta alcanzar <final_water_amount>g y espera a que el café termine de filtrarse.'),
    ('304', 1, 'Muele el café y calienta el agua. Dobla el filtro, colócalo en la Chemex y enjuaga el filtro y la jarra. Añade el café molido.'),
    ('304', 8, 'Espera a que el café termine de filtrarse.'),
    ('305', 1, 'Enjuaga bien el filtro y desecha el agua. Enjuaga rápidamente la Chemex con agua fría. Añade (0.334 x <final_water_amount>)g de hielo y después el café molido. Coloca la Chemex sobre la balanza y ponla a cero.'),
    ('305', 4, 'Deja que el café termine de filtrarse, retira el filtro y sirve. Añade cubitos de hielo nuevos si lo deseas.'),
    ('401', 1, 'Muele el café, añádelo a la prensa francesa, colócala sobre la balanza y ponla a cero.'),
    ('402', 1, 'Muele el café, añádelo a la prensa francesa, colócala sobre la balanza y ponla a cero.'),
    ('402', 9, 'Vierte el café en una jarra y espera 2 minutos más antes de servir.'),
    ('403', 1, 'Muele el café, añádelo a la prensa francesa, colócala sobre la balanza y ponla a cero.'),
    ('501', 5, 'Gira suavemente el Clever Dripper o remueve con la cuchara para romper la costra.'),
    ('501', 6, 'Coloca el Clever Dripper sobre una jarra y espera a que el café termine de filtrarse.'),
    ('502', 6, 'Coloca el Clever Dripper sobre una jarra y deja que el café termine de filtrarse.'),
    ('503', 6, 'Coloca el Clever Dripper sobre una jarra y deja que el café termine de filtrarse.'),
    ('504', 1, 'Coloca el filtro de papel en el Clever Dripper y enjuágalo con agua. Muele el café, pero no lo añadas todavía. Coloca el Clever Dripper sobre la balanza y ponla a cero. Prepara una cuchara. Necesitarás (0.34 x <final_water_amount>)g de hielo; déjalo en el congelador por ahora.'),
    ('504', 3, 'Añade el café al agua y remueve con una cuchara hasta humedecer todo el café.'),
    ('504', 4, 'Deja reposar el café. Poco antes de que termine el tiempo de reposo, añade (0.34 x <final_water_amount>)g de hielo a la jarra.'),
    ('504', 5, 'Coloca el Clever Dripper sobre la jarra y espera a que el café termine de filtrarse.'),
    ('504', 6, 'Gira la jarra o remueve con una cuchara para derretir el hielo restante. Opcional: añade unas gotas de solución salina para reducir el amargor.'),
    ('601', 1, 'Muele el café. Enjuaga el filtro de papel con agua caliente, colócalo en la Kalita Wave y añade el café molido.'),
    ('601', 3, 'Gira suavemente la Kalita Wave; remueve con una cuchara si es necesario.'),
    ('601', 8, 'Gira suavemente la Kalita Wave y espera a que el café termine de filtrarse.'),
    ('603', 13, 'Espera a que el café termine de filtrarse.'),
    ('604', 1, 'Enjuaga el filtro y calienta la Kalita Wave y la jarra; después desecha el agua. Añade (0.4 x <final_water_amount>)g de hielo a la jarra. Coloca la Kalita Wave y la jarra sobre la balanza y ponla a cero. Añade el café molido, nivela el lecho y vuelve a poner la balanza a cero.'),
    ('604', 5, 'Deja que el café gotee hasta que el flujo sea lento. Retira la Kalita Wave, gira suavemente la jarra hasta que se derrita el hielo y sirve sobre cubitos de hielo nuevos.'),
    ('701', 1, 'Enjuaga el filtro y el Wilfa Svart Pour Over con agua caliente. Muele el café, añade el café molido y pon la balanza a cero. Cierra el control de flujo.'),
    ('701', 7, 'Abre por completo el control de flujo y espera a que el café termine de filtrarse.'),
    ('702', 1, 'Enjuaga el filtro y el Wilfa Svart Pour Over con agua caliente. Muele el café, añade el café molido y pon la balanza a cero. Cierra el control de flujo.'),
    ('702', 7, 'Espera a que el café termine de filtrarse y cierra el control de flujo.'),
    ('703', 1, 'Coloca el filtro de papel en el Wilfa Svart Pour Over y enjuágalo con agua. Muele el café, pero no lo añadas todavía. Coloca el dripper sobre la balanza y ponla a cero. Prepara una cuchara. Necesitarás (0.34 x <final_water_amount>)g de hielo; déjalo en el congelador por ahora.'),
    ('703', 3, 'Añade el café al agua y remueve con una cuchara hasta humedecer todo el café.'),
    ('703', 4, 'Deja reposar el café. Poco antes de que termine el tiempo de reposo, añade (0.34 x <final_water_amount>)g de hielo a la jarra.'),
    ('703', 5, 'Coloca el Wilfa Svart Pour Over sobre una jarra y espera a que el café termine de filtrarse.'),
    ('703', 6, 'Gira la jarra o remueve con una cuchara para derretir el hielo restante. Opcional: añade unas gotas de solución salina para reducir el amargor.'),
    ('801', 2, 'Haz la preinfusión con (0.2 x <final_water_amount>)g de agua y gira suavemente el Origami Dripper varias veces.'),
    ('801', 5, 'Espera a que el café termine de filtrarse.'),
    ('802', 7, 'Espera a que el café termine de filtrarse.'),
    ('803', 1, 'Enjuaga el Origami Dripper y el filtro con agua caliente. Muele el café, añade el café molido y pon la balanza a cero.'),
    ('804', 1, 'Elige el filtro: uno cónico para mezclas o uno Kalita Wave para cafés de origen único. Enjuágalo con agua caliente y desecha el agua. Muele el café con un molido medio, añade el café molido y pon la balanza a cero.'),
    ('804', 2, 'Primer vertido: vierte en espiral desde el centro hacia fuera hasta (0.14 x <final_water_amount>)g de agua.'),
    ('804', 4, 'Segundo vertido: repite el movimiento en espiral y vierte hasta (0.31 x <final_water_amount>)g de agua.'),
    ('804', 6, 'Tercer vertido: vierte hasta (0.48 x <final_water_amount>)g de agua y espera a que el café termine de filtrarse.'),
    ('804', 7, 'Añade (0.52 x <final_water_amount>)g de hielo a la jarra, gírala suavemente para enfriar el café y sirve.'),
    ('901', 2, 'Enciende la cafetera de filtro automática y espera al primer vertido.'),
    ('902', 1, 'Añade (0.4 x <final_water_amount>)g de hielo a la jarra de la Moccamaster. Añade (0.6 x <final_water_amount>)g de agua al depósito. Muele el café más fino de lo habitual, coloca un filtro de papel en la cesta, añade el café molido y coloca la jarra.'),
    ('902', 2, 'Enciende la Moccamaster y deja que termine el ciclo de preparación. Gira suavemente la jarra para derretir el hielo restante y sirve en vasos previamente enfriados.')
) as replacement(recipe_id, step_order, description)
where target.recipe_id = replacement.recipe_id
  and target.step_order = replacement.step_order
  and target.locale = 'es';

-- Recipe 601 intentionally keeps its existing Spanish IDs and step_order values.
-- A cross-locale audit showed that Spanish alone uses 1-8 while all 21 other
-- locales use 1,3-9. That structural repair is deferred for separate approval.

commit;
