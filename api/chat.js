module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const {
      message = '',
      history = [],
      sessionId = 'default-session',
      model,
      systemPrompt,
      supabaseUrl,
      supabaseAnonKey
    } = body;

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(500).json({ error: 'La clave de Gemini no está configurada en Vercel.' });
    }

    const effectiveModel = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    // Lista de modelos a probar en orden: el elegido arriba, y si falla (cuota,
    // modelo dado de baja, error temporal, etc.) sigue probando con los siguientes.
    const MODEL_FALLBACK_CHAIN = [
      effectiveModel,
      'gemini-3.5-flash',
      'gemini-3-flash-preview', // preview de Gemini 3, cuotas más chicas mientras dure la fase preview
      'gemini-2.0-flash',  // se intenta igual por pedido explícito, aunque Google lo dio de baja el 1/jun/2026 y hoy responde error
      'gemini-2.5-flash'
    ].filter((m, i, arr) => m && arr.indexOf(m) === i); // sin duplicados ni vacíos

    const effectiveSystemPrompt = systemPrompt || process.env.CHAT_SYSTEM_PROMPT || 'Eres el asistente de Contralamaquina. Responde de forma clara, breve y útil sobre tecnología, soporte técnico, computadoras, celulares y servicios del negocio. Si no sabes algo, dilo con honestidad.';
    const effectiveSupabaseUrl = supabaseUrl || process.env.SUPABASE_URL || '';
    const effectiveSupabaseAnonKey = supabaseAnonKey || process.env.SUPABASE_ANON_KEY || '';

    const contents = [];
    for (const entry of history) {
      if (!entry || !entry.content) continue;
      if (entry.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: entry.content }] });
      } else if (entry.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: entry.content }] });
      }
    }

    contents.push({ role: 'user', parts: [{ text: message }] });

    const { reply, modelUsed } = await callGeminiWithFallback(MODEL_FALLBACK_CHAIN, geminiApiKey, effectiveSystemPrompt, contents);

    if (effectiveSupabaseUrl && effectiveSupabaseAnonKey) {
      await Promise.all([
        saveToSupabase(effectiveSupabaseUrl, effectiveSupabaseAnonKey, sessionId, 'user', message),
        saveToSupabase(effectiveSupabaseUrl, effectiveSupabaseAnonKey, sessionId, 'assistant', reply)
      ]);
    }

    return res.status(200).json({ reply, sessionId });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error inesperado' });
  }
};

async function callGeminiWithFallback(modelChain, geminiApiKey, systemPrompt, contents) {
  let lastError = null;

  for (const modelName of modelChain) {
    try {
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents
          })
        }
      );

      const geminiData = await geminiResponse.json();

      if (!geminiResponse.ok) {
        lastError = new Error(geminiData?.error?.message || `Error al consultar Gemini (${modelName})`);
        continue; // probar el siguiente modelo de la lista
      }

      const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!reply) {
        lastError = new Error(`Respuesta vacía del modelo ${modelName}`);
        continue;
      }

      return { reply, modelUsed: modelName };
    } catch (err) {
      lastError = err;
      // error de red u otro imprevisto: seguir probando el siguiente modelo
    }
  }

  throw lastError || new Error('No se pudo obtener respuesta de ningún modelo de Gemini.');
}

async function saveToSupabase(url, key, sessionId, role, content) {
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/chat_messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify([{ session_id: sessionId, role, content }])
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase error: ${err}`);
  }
}
