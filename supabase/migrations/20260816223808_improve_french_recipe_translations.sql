begin;

-- Canonical French grind-size vocabulary. The implied noun is "mouture", so
-- labels use feminine agreement throughout.
update public.recipe_localization as fr
set grind_size = case en.grind_size
  when 'Fine' then 'Fine'
  when 'Fine/Medium' then 'Fine à moyenne'
  when 'Medium/Fine' then 'Fine à moyenne'
  when 'Medium fine' then 'Moyenne-fine'
  when 'Medium-fine' then 'Moyenne-fine'
  when 'Medium' then 'Moyenne'
  when 'Medium (like kosher salt)' then 'Moyenne (comme du gros sel)'
  when 'Medium, finer than usual' then 'Moyenne, plus fine que d’habitude'
  when 'Medium-Coarse' then 'Moyenne-grossière'
  when 'Medium-coarse' then 'Moyenne-grossière'
  when 'Medium-coarse (sea salt)' then 'Moyenne-grossière (comme du sel de mer)'
  when 'Coarse' then 'Grossière'
  else btrim(fr.grind_size)
end
from public.recipe_localization as en
where fr.recipe_id = en.recipe_id
  and fr.locale = 'fr'
  and en.locale = 'en';

-- Preserve the official AeroPress spelling everywhere.
update public.recipe_localization
set
  name = replace(name, 'Aeropress', 'AeroPress'),
  short_description = replace(short_description, 'Aeropress', 'AeroPress')
where locale = 'fr'
  and (name like '%Aeropress%' or short_description like '%Aeropress%');

update public.steps
set description = replace(description, 'Aeropress', 'AeroPress')
where locale = 'fr' and description like '%Aeropress%';

-- Translate descriptive method names while keeping official product names.
update public.recipe_localization
set
  name = 'Recette ultime de café glacé par extraction flash de Lance Hedrick',
  short_description = 'Une recette de café glacé à extraction élevée, peu amère, qui préserve toutes les nuances des grains. [Voir la vidéo](https://www.youtube.com/watch?v=qwvnQcojq9Q&).'
where recipe_id = '103' and locale = 'fr';

update public.recipe_localization
set
  name = 'Recette de cafetière à piston de James Hoffmann',
  short_description = 'Recette de cafetière à piston de James Hoffmann, champion du monde de barista. [Voir le tutoriel](https://www.youtube.com/watch?v=st571DYYTR8).'
where recipe_id = '401' and locale = 'fr';

update public.recipe_localization
set
  name = 'Recette de cafetière à piston de Gwilym Davies',
  short_description = 'Recette de cafetière à piston de Gwilym Davies, champion du monde de barista. [Voir le tutoriel](https://www.youtube.com/watch?v=AkrqY8LkWM4).'
where recipe_id = '402' and locale = 'fr';

update public.recipe_localization
set
  name = 'Recette de cafetière à piston de Scott Rao',
  short_description = 'Recette de cafetière à piston de Scott Rao, expert en café et auteur spécialisé dans la gestion des cafés, la formation des baristas, la torréfaction et la préparation du café.'
where recipe_id = '403' and locale = 'fr';

update public.recipe_localization
set
  name = 'Cafetière à piston pour super-dégustateurs par The Coffee Chronicler',
  short_description = 'Recette de cafetière à piston d’Asser Christensen, alias The Coffee Chronicler. Elle vise à produire un café limpide et savoureux et nécessite des filtres en papier. Asser recommande des filtres en forme de panier qui couvrent entièrement le piston et dépassent de 2 à 3 cm sur les côtés, voire un peu plus. [Consultez le tutoriel détaillé](https://coffeechronicler.com/how-to-make-french-press-recipe/).'
where recipe_id = '404' and locale = 'fr';

update public.recipe_localization
set short_description = 'Cette recette utilise une technique améliorée de café glacé par immersion de James Hoffmann. [Voir le tutoriel](https://www.youtube.com/watch?v=8uGGeV8A-BM). Facultatif : ajoutez à la fin quelques gouttes de solution saline composée de 20 % de sel et de 80 % d’eau pour réduire l’amertume. Remarque : choisissez une mouture plus fine que pour un café filtre manuel, mais moins fine que pour un espresso.'
where recipe_id = '504' and locale = 'fr';

update public.recipe_localization
set
  name = 'Recette par immersion pour Wilfa Svart Pour Over de Tim Wendelboe',
  short_description = 'Recette par immersion pour Wilfa Svart Pour Over de Tim Wendelboe, champion du monde de barista et champion de la World Cup Tasters. Tim s’est associé à Wilfa pour créer ce porte-filtre.'
where recipe_id = '701' and locale = 'fr';

update public.recipe_localization
set
  name = 'Wilfa Svart Pour Over – Recette de café filtre manuel de Best Coffee',
  short_description = 'Une autre façon d’utiliser le Wilfa Svart Pour Over consiste à préparer un café filtre manuel. Cette recette vient de [Best Coffee](https://www.bestcoffee.guide/blogs/product-reviews/wilfa-pour-over-smart-dripper-review).'
where recipe_id = '702' and locale = 'fr';

update public.recipe_localization
set short_description = 'Cette recette, inspirée par James Hoffmann, utilise une technique améliorée de café glacé par immersion. [Consultez le tutoriel](https://www.youtube.com/watch?v=8uGGeV8A-BM). Facultatif : ajoutez quelques gouttes de solution saline composée de 20 % de sel et de 80 % d’eau pour réduire l’amertume. Remarque : choisissez une mouture plus fine que pour un café filtre manuel, mais moins fine que pour un espresso.'
where recipe_id = '703' and locale = 'fr';

update public.recipe_localization
set short_description = 'Recette pour Origami Dripper de Jia Ning Du, première barista chinoise à remporter la World Brewers Cup (WBrC). Il s’agit de la recette avec laquelle elle a remporté la compétition. [Voici le tutoriel](https://www.youtube.com/watch?v=HNDnngFhZMU).'
where recipe_id = '802' and locale = 'fr';

update public.recipe_localization
set
  name = 'Recette de café glacé pour Origami Dripper de Kurasu',
  short_description = 'Recette de café glacé pour Origami Dripper développée par Mishima, barista chez Kurasu. [Voir la recette originale](https://kurasu.kyoto/blogs/recipe/new-origami-dripper-iced-coffee-recipe).'
where recipe_id = '804' and locale = 'fr';

update public.recipe_localization
set name = 'Recette de base pour cafetière filtre automatique'
where recipe_id = '901' and locale = 'fr';

-- Approved accuracy fixes and terminology normalization. Instructions use the
-- polite second-person plural imperative consistently.
update public.steps as target
set description = replacement.description
from (
  values
    ('101', 3, 'Faites doucement tourner le V60 jusqu’à ce que le mélange soit homogène.'),
    ('101', 4, 'Laissez le café préinfuser.'),
    ('101', 5, 'Au cours des 30 prochaines secondes, terminez la première coulée principale jusqu’à (0.6 x <final_water_amount>)g.'),
    ('101', 6, 'Au cours des 30 prochaines secondes, terminez doucement la deuxième coulée principale jusqu’à <final_water_amount>g.'),
    ('101', 9, 'Essayez de terminer l’écoulement à 3 min 30 s.'),
    ('102', 4, 'Laissez le café préinfuser.'),
    ('102', 5, 'Commencez la coulée principale jusqu’à <final_water_amount>g.'),
    ('102', 8, 'L’écoulement devrait être terminé en moins de 3 minutes.'),
    ('103', 2, 'Préinfusez avec (0.25 x <final_water_amount>)g d’eau.'),
    ('103', 4, 'Versez de nouveau (0.375 x <final_water_amount>)g d’eau et faites doucement tourner le V60. Attendez que le café se soit entièrement écoulé.'),
    ('104', 1, 'Rincez le filtre au-dessus de l’évier afin de ne pas chauffer la carafe. Ajoutez le café moulu dans le V60. Placez (0.4 x <final_water_amount>)g de glace dans la carafe. Posez l’ensemble sur la balance et tarez-la.'),
    ('104', 3, 'Remuez légèrement le café pendant la préinfusion.'),
    ('104', 4, 'Laissez le café préinfuser.'),
    ('105', 4, 'Laissez le café préinfuser.'),
    ('105', 13, 'Attendez que le café se soit entièrement écoulé.'),
    ('106', 1, 'Rincez le filtre et préchauffez le V60. Ajoutez le café moulu. Placez le V60 sur la balance et tarez-la.'),
    ('106', 2, 'Versez (<m1> x <final_water_amount>)g d’eau.'),
    ('106', 3, 'Attendez.'),
    ('106', 4, 'Versez jusqu’à (<m2> x <final_water_amount>)g d’eau.'),
    ('106', 5, 'Attendez.'),
    ('106', 6, 'Versez jusqu’à (<m3> x <final_water_amount>)g d’eau.'),
    ('106', 7, 'Attendez.'),
    ('106', 8, 'Versez jusqu’à (<m4> x <final_water_amount>)g d’eau.'),
    ('106', 9, 'Attendez.'),
    ('106', 10, 'Versez jusqu’à (<m5> x <final_water_amount>)g d’eau.'),
    ('106', 11, 'Attendez.'),
    ('107', 10, 'Attendez que le café se soit entièrement écoulé.'),
    ('202', 5, 'Maintenez l’AeroPress et le piston, puis faites doucement tourner l’appareil.'),
    ('205', 1, 'Rincez au préalable deux filtres en papier dans le porte-filtre afin d’éliminer le goût de papier et de préchauffer l’AeroPress. Jetez l’eau et mettez le porte-filtre de côté. Remplissez la carafe d’une quantité de glace égale à la quantité d’eau. Ajoutez le café moulu dans l’AeroPress.'),
    ('205', 4, 'Laissez le café préinfuser.'),
    ('205', 6, 'Remuez le mélange une fois en profondeur, puis fixez le porte-filtre sur l’AeroPress.'),
    ('206', 3, 'Laissez une légère préinfusion se former.'),
    ('207', 8, 'Faites tourner la carafe pour faire fondre toute la glace restante. Servez sur des glaçons frais.'),
    ('301', 3, 'Remuez pour humidifier toute la mouture, puis laissez le café préinfuser.'),
    ('301', 8, 'Attendez que le café se soit entièrement écoulé.'),
    ('302', 3, 'Laissez le café préinfuser.'),
    ('302', 6, 'Répétez le même processus avec des versements en immersion supplémentaires jusqu’à atteindre <final_water_amount>g d’eau. Attendez que le café se soit entièrement écoulé.'),
    ('303', 3, 'Laissez le café préinfuser.'),
    ('303', 8, 'Ajoutez de l’eau jusqu’à atteindre <final_water_amount>g, puis attendez que le café se soit entièrement écoulé.'),
    ('304', 4, 'Attendez pendant la préinfusion du café.'),
    ('304', 8, 'Attendez que le café se soit entièrement écoulé.'),
    ('305', 2, 'Versez environ (2 x <final_coffee_amount>)g d’eau en veillant à imbiber toute la mouture. Laissez le café préinfuser.'),
    ('401', 1, 'Moulez le café et ajoutez-le dans la cafetière à piston. Placez-la sur la balance et tarez-la.'),
    ('401', 6, 'Insérez le piston sans l’enfoncer complètement et laissez-le à la surface du café. Versez doucement.'),
    ('402', 1, 'Moulez le café et ajoutez-le dans la cafetière à piston. Placez-la sur la balance et tarez-la.'),
    ('403', 1, 'Moulez le café et ajoutez-le dans la cafetière à piston. Placez-la sur la balance et tarez-la.'),
    ('404', 1, 'Pliez le filtre en papier, placez-le dans la cafetière à piston et rincez-le à l’eau chaude. Retirez-le et placez-le dans la tasse. Jetez l’eau. Moulez le café et ajoutez-le dans la cafetière à piston. Placez-la sur la balance et tarez-la.'),
    ('501', 6, 'Placez le Clever Dripper sur une carafe et attendez que le café se soit entièrement écoulé.'),
    ('502', 1, 'Insérez le filtre dans le Clever Dripper et rincez-le à l’eau chaude. Moulez le café et ajoutez la mouture dans le Clever Dripper.'),
    ('502', 2, 'Ajoutez <final_water_amount>g d’eau dans le Clever Dripper.'),
    ('502', 6, 'Placez le Clever Dripper sur la carafe et laissez le café s’écouler.'),
    ('503', 1, 'Insérez le filtre en papier dans le Clever Dripper et rincez-le à l’eau chaude. Moulez le café et ajoutez la mouture dans le Clever Dripper.'),
    ('503', 2, 'Versez <final_water_amount>g d’eau dans le Clever Dripper.'),
    ('503', 6, 'Placez le Clever Dripper sur une carafe et laissez le café s’écouler.'),
    ('504', 1, 'Insérez le filtre en papier dans le Clever Dripper et rincez-le à l’eau. Moulez le café, sans encore l’ajouter. Placez le Clever Dripper sur la balance et tarez-la. Préparez une cuillère. Vous aurez besoin de (0.34 x <final_water_amount>)g de glace ; laissez-la au congélateur pour l’instant.'),
    ('504', 5, 'Placez le Clever Dripper sur la carafe et attendez que le café se soit entièrement écoulé.'),
    ('504', 6, 'Faites tourner la carafe ou remuez avec une cuillère pour faire fondre la glace restante. Facultatif : ajoutez quelques gouttes de solution saline pour réduire l’amertume.'),
    ('601', 4, 'Faites légèrement tourner la Kalita Wave ; utilisez une cuillère si nécessaire.'),
    ('601', 5, 'Laissez le café préinfuser.'),
    ('601', 7, 'Attendez que le mélange se soit écoulé environ de moitié.'),
    ('601', 9, 'Faites doucement tourner la Kalita Wave et attendez que le café se soit entièrement écoulé.'),
    ('602', 3, 'Laissez le café préinfuser.'),
    ('602', 6, 'Attendez que le café se soit entièrement écoulé.'),
    ('603', 1, 'Rincez le filtre jusqu’à ce que la Kalita Wave soit chaude. Pesez et moulez le café. Ajoutez la mouture dans la Kalita Wave et secouez-la pour niveler le lit de café.'),
    ('603', 13, 'Attendez que le café se soit entièrement écoulé.'),
    ('604', 2, 'Démarrez le minuteur. Versez (2.1 x <final_coffee_amount>)g d’eau en veillant à imbiber toute la mouture. Laissez le café préinfuser.'),
    ('701', 1, 'Rincez le filtre et le Wilfa Svart Pour Over à l’eau chaude. Moulez le café, ajoutez la mouture et tarez la balance. Fermez le régulateur de débit.'),
    ('701', 3, 'Faites doucement tourner le Wilfa Svart Pour Over.'),
    ('701', 7, 'Ouvrez complètement le régulateur de débit et attendez que le café se soit entièrement écoulé.'),
    ('702', 1, 'Rincez le filtre et le Wilfa Svart Pour Over à l’eau chaude. Moulez le café, ajoutez la mouture et tarez la balance. Fermez le régulateur de débit.'),
    ('702', 3, 'Laissez le café préinfuser.'),
    ('702', 7, 'Attendez que le café se soit entièrement écoulé, puis fermez le régulateur de débit.'),
    ('703', 1, 'Insérez le filtre en papier dans le Wilfa Svart Pour Over et rincez-le à l’eau. Moulez le café, sans encore l’ajouter. Placez le porte-filtre sur la balance et tarez-la. Préparez une cuillère. Vous aurez besoin de (0.34 x <final_water_amount>)g de glace ; laissez-la au congélateur pour l’instant.'),
    ('703', 2, 'Versez (0.66 x <final_water_amount>)g d’eau dans le Wilfa Svart Pour Over.'),
    ('703', 4, 'Laissez le café infuser. Peu avant la fin, placez (0.34 x <final_water_amount>)g de glace dans la carafe.'),
    ('703', 5, 'Placez le Wilfa Svart Pour Over sur la carafe et attendez que le café se soit entièrement écoulé.'),
    ('703', 6, 'Faites tourner la carafe ou remuez avec une cuillère pour faire fondre la glace restante. Facultatif : ajoutez quelques gouttes de solution saline pour réduire l’amertume.'),
    ('801', 2, 'Préinfusez le café avec (0.2 x <final_water_amount>)g d’eau et faites doucement tourner le porte-filtre Origami plusieurs fois.'),
    ('801', 3, 'Laissez le café préinfuser.'),
    ('801', 4, 'Versez lentement en cercles concentriques jusqu’à (1.0 x <final_water_amount>)g d’eau, en terminant le dernier versement sur le pourtour du filtre. Faites encore une fois doucement tourner le porte-filtre Origami.'),
    ('801', 5, 'Attendez que le café se soit entièrement écoulé.'),
    ('802', 1, 'Rincez le filtre et l’Origami Dripper à l’eau chaude. Moulez le café, ajoutez la mouture et tarez la balance.'),
    ('802', 2, 'Versez (0.25 x <final_water_amount>)g d’eau pour la préinfusion.'),
    ('802', 4, 'Versez jusqu’à (0.5835 x <final_water_amount>)g d’eau.'),
    ('802', 6, 'Terminez le versement jusqu’à <final_water_amount>g.'),
    ('802', 7, 'Attendez que le café se soit entièrement écoulé.'),
    ('803', 1, 'Rincez le porte-filtre Origami et le filtre à l’eau chaude. Moulez le café, ajoutez la mouture et tarez la balance.'),
    ('803', 11, 'Attendez que le café se soit entièrement écoulé.'),
    ('804', 1, 'Choisissez votre filtre : un filtre conique pour les mélanges ou un filtre Kalita Wave pour les cafés d’origine unique. Rincez le filtre à l’eau chaude et jetez l’eau de rinçage. Moulez le café avec une mouture moyenne, ajoutez la mouture et tarez la balance.'),
    ('901', 1, 'Moulez le café, insérez le filtre dans le panier et rincez-le à l’eau chaude. Ajoutez le café moulu dans le filtre et remplissez le réservoir d’eau.'),
    ('901', 2, 'Allumez la cafetière filtre automatique et attendez le premier versement.'),
    ('901', 4, 'Laissez le café préinfuser et remuez légèrement.'),
    ('1001', 1, 'Insérez le filtre, rincez-le à l’eau chaude et jetez l’eau. Moulez le café et ajoutez-le dans le Hario Switch. Mettez le levier du Switch en position ouverte. Préparez une bouteille d’eau froide.'),
    ('1001', 2, 'Ajoutez (3 x <final_coffee_amount>)g d’eau chaude.'),
    ('1001', 6, 'Mettez le levier du Switch en position fermée et ajoutez de l’eau jusqu’à <final_water_amount>g.'),
    ('1001', 8, 'Mettez le levier du Switch en position ouverte et attendez que le café se soit entièrement écoulé.'),
    ('1002', 1, 'Insérez le filtre, rincez-le à l’eau chaude et jetez l’eau. Moulez le café et ajoutez-le dans le Hario Switch. Mettez le levier du Switch en position ouverte.'),
    ('1002', 4, 'Mettez le levier du Switch en position fermée et versez de l’eau jusqu’à <final_water_amount>g.'),
    ('1002', 5, 'Attendez.'),
    ('1002', 6, 'Mettez le levier du Switch en position ouverte et laissez le café s’écouler.'),
    ('1003', 1, 'Insérez le filtre, rincez-le à l’eau chaude et jetez l’eau. Placez le Hario Switch sur une carafe, ajoutez le café moulu et mettez le levier du Switch en position fermée.'),
    ('1003', 4, 'Mettez le levier du Switch en position ouverte et versez de l’eau jusqu’à <final_water_amount>g au centre du lit de café.'),
    ('1003', 5, 'Attendez que le café se soit entièrement écoulé.'),
    ('1004', 1, 'Insérez le filtre et rincez-le à l’eau chaude. Moulez le café et ajoutez-le dans le filtre. Placez le Hario Switch sur la balance et tarez-la. Préparez une bouteille d’eau froide potable. Mettez le levier du Switch en position fermée.'),
    ('1004', 4, 'Mettez le levier du Switch en position ouverte.'),
    ('1004', 9, 'Mettez le levier du Switch en position fermée.'),
    ('1004', 12, 'Mettez le levier du Switch en position ouverte et attendez que le café se soit entièrement écoulé.')
) as replacement(recipe_id, step_order, description)
where target.recipe_id = replacement.recipe_id
  and target.step_order = replacement.step_order
  and target.locale = 'fr';

commit;
