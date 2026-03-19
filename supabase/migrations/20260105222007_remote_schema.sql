alter table "service"."year_story_clicks" add column "event" text not null;

CREATE INDEX notifications_locale_idx ON service.notifications USING btree (locale);

CREATE INDEX year_story_clicks_event_time_idx ON service.year_story_clicks USING btree (event, created_at DESC);

grant select on table "public"."giftbox_offers" to "cline_mcp_readonly_role";

grant select on table "public"."yearly_user_liters" to "cline_mcp_readonly_role";

grant select on table "public"."yearly_wish_deliveries" to "cline_mcp_readonly_role";

grant select on table "public"."yearly_wishes" to "cline_mcp_readonly_role";

grant delete on table "service"."feature_flags" to "anon";

grant insert on table "service"."feature_flags" to "anon";

grant references on table "service"."feature_flags" to "anon";

grant trigger on table "service"."feature_flags" to "anon";

grant truncate on table "service"."feature_flags" to "anon";

grant update on table "service"."feature_flags" to "anon";

grant delete on table "service"."feature_flags" to "authenticated";

grant insert on table "service"."feature_flags" to "authenticated";

grant references on table "service"."feature_flags" to "authenticated";

grant trigger on table "service"."feature_flags" to "authenticated";

grant truncate on table "service"."feature_flags" to "authenticated";

grant update on table "service"."feature_flags" to "authenticated";

grant delete on table "service"."feature_flags" to "service_role";

grant insert on table "service"."feature_flags" to "service_role";

grant references on table "service"."feature_flags" to "service_role";

grant select on table "service"."feature_flags" to "service_role";

grant trigger on table "service"."feature_flags" to "service_role";

grant truncate on table "service"."feature_flags" to "service_role";

grant update on table "service"."feature_flags" to "service_role";

grant delete on table "service"."giftbox_offer_clicks" to "anon";

grant insert on table "service"."giftbox_offer_clicks" to "anon";

grant references on table "service"."giftbox_offer_clicks" to "anon";

grant select on table "service"."giftbox_offer_clicks" to "anon";

grant trigger on table "service"."giftbox_offer_clicks" to "anon";

grant truncate on table "service"."giftbox_offer_clicks" to "anon";

grant update on table "service"."giftbox_offer_clicks" to "anon";

grant delete on table "service"."giftbox_offer_clicks" to "authenticated";

grant insert on table "service"."giftbox_offer_clicks" to "authenticated";

grant references on table "service"."giftbox_offer_clicks" to "authenticated";

grant trigger on table "service"."giftbox_offer_clicks" to "authenticated";

grant truncate on table "service"."giftbox_offer_clicks" to "authenticated";

grant update on table "service"."giftbox_offer_clicks" to "authenticated";

grant delete on table "service"."year_story_clicks" to "anon";

grant insert on table "service"."year_story_clicks" to "anon";

grant references on table "service"."year_story_clicks" to "anon";

grant select on table "service"."year_story_clicks" to "anon";

grant trigger on table "service"."year_story_clicks" to "anon";

grant truncate on table "service"."year_story_clicks" to "anon";

grant update on table "service"."year_story_clicks" to "anon";

grant delete on table "service"."year_story_clicks" to "authenticated";

grant references on table "service"."year_story_clicks" to "authenticated";

grant select on table "service"."year_story_clicks" to "authenticated";

grant trigger on table "service"."year_story_clicks" to "authenticated";

grant truncate on table "service"."year_story_clicks" to "authenticated";

grant update on table "service"."year_story_clicks" to "authenticated";

grant delete on table "service"."year_story_clicks" to "service_role";

grant insert on table "service"."year_story_clicks" to "service_role";

grant references on table "service"."year_story_clicks" to "service_role";

grant select on table "service"."year_story_clicks" to "service_role";

grant trigger on table "service"."year_story_clicks" to "service_role";

grant truncate on table "service"."year_story_clicks" to "service_role";

grant update on table "service"."year_story_clicks" to "service_role";


