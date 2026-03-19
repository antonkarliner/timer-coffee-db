import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

serve(async (req: any) => {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  try {
    const geo = ip
      ? await fetch(`https://ipapi.co/${ip}/json/`).then((r) => r.json())
      : await fetch('https://ipapi.co/json/').then((r) => r.json());
    const country = (geo.country || '').toUpperCase();
    const region = mapCountryToRegion(country);
    return new Response(JSON.stringify({ country, region }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).toString() }), { status: 500 });
  }
});

function mapCountryToRegion(country: string): string {
  if (["US", "CA", "MX"].includes(country)) return "NA";
  if (["GB", "DE", "FR", "ES", "IT", "NL", "BE", "SE", "NO", "FI", "DK", "PL", "PT", "IE", "AT", "CH"].includes(country)) return "EU";
  if (["JP", "CN", "HK", "KR", "SG", "TH", "VN", "MY", "ID", "PH", "IN"].includes(country)) return "AS";
  if (["AU", "NZ"].includes(country)) return "AU";
  if (["AR", "BR", "CL", "CO", "PE", "UY", "PY", "BO", "VE", "EC"].includes(country)) return "SA";
  if (["DZ", "EG", "MA", "ZA", "KE", "NG", "GH", "TZ", "UG", "ET", "RW", "CI", "SN", "CM", "TN", "MU", "NA", "BW", "MZ"].includes(country)) return "AF";
  if (["AE", "SA", "QA", "KW", "BH", "OM", "JO", "LB", "IL", "IQ", "IR"].includes(country)) return "ME";
  return "WW";
}