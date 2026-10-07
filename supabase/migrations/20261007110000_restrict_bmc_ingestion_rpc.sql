-- F03: Public execution of this SECURITY DEFINER RPC allowed forged donation
-- ingestion and disclosure of correlation data without webhook HMAC verification.
-- Keep the function body, deduplication, correlation and search_path unchanged.
revoke execute on function public.insert_bmc_support_event(text, jsonb, text, text) from public;
revoke execute on function public.insert_bmc_support_event(text, jsonb, text, text) from anon;
revoke execute on function public.insert_bmc_support_event(text, jsonb, text, text) from authenticated;
grant execute on function public.insert_bmc_support_event(text, jsonb, text, text) to service_role;
grant execute on function public.insert_bmc_support_event(text, jsonb, text, text) to postgres;
