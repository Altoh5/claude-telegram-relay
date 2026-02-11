import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { chat_id, role, content, metadata } = await req.json();

    if (!chat_id || !role || !content) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Generate embedding if OpenAI key is available
    let embedding = null;
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (openaiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: content,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          embedding = data.data[0].embedding;
        }
      } catch {
        // OpenAI call failed — continue without embedding
      }
    }

    const { error } = await supabase.from("messages").insert({
      chat_id,
      role,
      content,
      metadata: metadata || {},
      ...(embedding ? { embedding } : {}),
    });

    return new Response(
      JSON.stringify({ ok: !error, error: error?.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
