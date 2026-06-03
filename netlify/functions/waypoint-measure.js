const https = require('https');

function callAPI(hostname, path, apiHeaders, payload) {
  return new Promise((resolve) => {
    const options = { hostname, path, method: 'POST', headers: apiHeaders };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

function parseResponse(text, company, competitor) {
  if (!text) return { coRaw: 0, compRaw: 0, coCited: false, compCited: false, coSnippet: '', compSnippet: '' };
  const t = text.toLowerCase();
  const co = company.toLowerCase();
  const comp = competitor.toLowerCase();
  const coIdx = t.indexOf(co);
  const compIdx = t.indexOf(comp);
  const coCited = coIdx !== -1;
  const compCited = compIdx !== -1;

  // Strip markdown and extract clean snippet around brand mention
  function extractSnippet(fullText, idx) {
    if (idx === -1) return '';
    // Strip markdown headers, bold, bullets before extracting
    const clean = fullText
      .replace(/#{1,6}\s+[^\n]*/g, '')  // remove ## headings
      .replace(/\*\*([^*]+)\*\*/g, '$1') // remove **bold**
      .replace(/\*([^*]+)\*/g, '$1')      // remove *italic*
      .replace(/^[-*]\s+/gm, '')           // remove bullet points
      .replace(/\n{2,}/g, ' ')             // collapse newlines
      .trim();
    // Recalculate idx in cleaned text
    const brand = fullText.substring(idx, idx + 30).toLowerCase();
    const cleanIdx = clean.toLowerCase().indexOf(brand.substring(0, 15));
    const useIdx = cleanIdx !== -1 ? cleanIdx : 0;
    const start = Math.max(0, useIdx - 30);
    const end = Math.min(clean.length, useIdx + 130);
    let snippet = clean.substring(start, end).trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < clean.length) snippet = snippet + '...';
    return snippet;
  }

  const coSnippet = extractSnippet(text, coIdx);
  const compSnippet = extractSnippet(text, compIdx);

  function posScore(idx, otherIdx) {
    if (idx === -1) return 0;
    if (otherIdx === -1 || idx < otherIdx) return 3;
    if (idx < otherIdx + 150) return 2;
    return 1;
  }

  function sentScore(text, brand) {
    if (!text.includes(brand)) return 0;
    const idx = text.indexOf(brand);
    const w = text.substring(Math.max(0, idx-100), idx+100);
    const pos = ['recommend','best','top','excellent','leading','popular','trusted','premier','well-known','great','strong','widely'].filter(s=>w.includes(s)).length;
    const neg = ['however','but','although','limited','lacks','despite','behind','compared to','weaker','less'].filter(s=>w.includes(s)).length;
    return pos > neg ? 3 : neg > pos ? 1 : 2;
  }

  const hasThirdParty = ['according to','cited by','featured in','reviewed','referenced','source:','reports','study','research','survey','analysis'].some(s=>t.includes(s));

  const coRaw = coCited ? (posScore(coIdx,compIdx) * sentScore(t,co)) + (hasThirdParty?1:0) : 0;
  const compRaw = compCited ? (posScore(compIdx,coIdx) * sentScore(t,comp)) + (hasThirdParty?1:0) : 0;

  return { coRaw, compRaw, coCited, compCited, coSnippet, compSnippet };
}

function normalize(avg) {
  return Math.min(100, Math.round((avg / 10) * 100));
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  try {
    const { company, competitor, industry, market, prompts } = JSON.parse(event.body);
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    const allPrompts = [...prompts.pa, ...prompts.cp, ...prompts.ar];
    const dimSize = prompts.pa.length;

    // Build all API calls at once — fully parallel
    const calls = allPrompts.flatMap(q => {
      const question = `Answer this question naturally. Mention specific brands when relevant.\n\nQuestion: ${q}\nContext: ${industry} in ${market}.`;

      const claudePayload = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: question }]
      });

      const gptPayload = JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [{ role: 'user', content: question }]
      });

      const claudeHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(claudePayload),
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      };

      const gptHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(gptPayload),
        'Authorization': 'Bearer ' + openaiKey
      };

      return [
        callAPI('api.anthropic.com', '/v1/messages', claudeHeaders, claudePayload)
          .then(r => r && r.content && r.content[0] ? r.content[0].text : ''),
        callAPI('api.openai.com', '/v1/chat/completions', gptHeaders, gptPayload)
          .then(r => r && r.choices && r.choices[0] ? r.choices[0].message.content : '')
      ];
    });

    // Fire everything at once
    const responses = await Promise.all(calls);

    // Parse results — now includes snippets
    const parsed = allPrompts.map((q, i) => ({
      prompt: q,
      claude: parseResponse(responses[i*2], company, competitor),
      gpt: parseResponse(responses[i*2+1], company, competitor),
      claudeRaw: responses[i*2] || '',
      gptRaw: responses[i*2+1] || ''
    }));

    const pa = parsed.slice(0, dimSize);
    const cp = parsed.slice(dimSize, dimSize*2);
    const ar = parsed.slice(dimSize*2);

    function dimScore(results, brand) {
      const avg = results.reduce((s,r) => {
        const raw = brand==='co' ? (r.claude.coRaw+r.gpt.coRaw)/2 : (r.claude.compRaw+r.gpt.compRaw)/2;
        return s + raw;
      }, 0) / results.length;
      return normalize(avg);
    }

    function citRate(results, brand) {
      const n = results.filter(r => brand==='co' ? (r.claude.coCited||r.gpt.coCited) : (r.claude.compCited||r.gpt.compCited)).length;
      return Math.round((n/results.length)*100);
    }

    // Pull best verbatim snippets per dimension (first cited response)
    function getBestSnippet(results, brand, engine) {
      for (const r of results) {
        const snippet = engine === 'claude'
          ? (brand === 'co' ? r.claude.coSnippet : r.claude.compSnippet)
          : (brand === 'co' ? r.gpt.coSnippet : r.gpt.compSnippet);
        if (snippet && snippet.length > 20) return { prompt: r.prompt, snippet, engine };
      }
      return null;
    }

    // Per-engine scores for display
    function dimScoreEngine(results, brand, engine) {
      const avg = results.reduce((s,r) => {
        const src = engine === 'claude' ? r.claude : r.gpt;
        const raw = brand === 'co' ? src.coRaw : src.compRaw;
        return s + raw;
      }, 0) / results.length;
      return normalize(avg);
    }

    const scores = {
      prompt_alignment:  {
        a: dimScore(pa,'co'),  b: dimScore(pa,'comp'),
        claude_a: dimScoreEngine(pa,'co','claude'), claude_b: dimScoreEngine(pa,'comp','claude'),
        gpt_a: dimScoreEngine(pa,'co','gpt'), gpt_b: dimScoreEngine(pa,'comp','gpt'),
        citation_rate_a: citRate(pa,'co'),  citation_rate_b: citRate(pa,'comp'),
        snippet_a: getBestSnippet(pa,'co','claude') || getBestSnippet(pa,'co','gpt'),
        snippet_b: getBestSnippet(pa,'comp','claude') || getBestSnippet(pa,'comp','gpt')
      },
      citation_presence: {
        a: dimScore(cp,'co'),  b: dimScore(cp,'comp'),
        claude_a: dimScoreEngine(cp,'co','claude'), claude_b: dimScoreEngine(cp,'comp','claude'),
        gpt_a: dimScoreEngine(cp,'co','gpt'), gpt_b: dimScoreEngine(cp,'comp','gpt'),
        citation_rate_a: citRate(cp,'co'),  citation_rate_b: citRate(cp,'comp'),
        snippet_a: getBestSnippet(cp,'co','claude') || getBestSnippet(cp,'co','gpt'),
        snippet_b: getBestSnippet(cp,'comp','claude') || getBestSnippet(cp,'comp','gpt')
      },
      answer_readiness:  {
        a: dimScore(ar,'co'),  b: dimScore(ar,'comp'),
        claude_a: dimScoreEngine(ar,'co','claude'), claude_b: dimScoreEngine(ar,'comp','claude'),
        gpt_a: dimScoreEngine(ar,'co','gpt'), gpt_b: dimScoreEngine(ar,'comp','gpt'),
        citation_rate_a: citRate(ar,'co'),  citation_rate_b: citRate(ar,'comp'),
        snippet_a: getBestSnippet(ar,'co','claude') || getBestSnippet(ar,'co','gpt'),
        snippet_b: getBestSnippet(ar,'comp','claude') || getBestSnippet(ar,'comp','gpt')
      }
    };

    const company_total = Math.round((scores.prompt_alignment.a + scores.citation_presence.a + scores.answer_readiness.a) / 3);
    const competitor_total = Math.round((scores.prompt_alignment.b + scores.citation_presence.b + scores.answer_readiness.b) / 3);

    // Build methodology transparency object
    const methodology = {
      total_prompts: allPrompts.length,
      engines: 2,
      total_responses: allPrompts.length * 2,
      prompts_tested: allPrompts,
      scoring: 'Citation detected · Position score (1-3) × Sentiment score (1-3) + Third-party signal bonus · Normalized 0-100 · Averaged across both engines'
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        company_total,
        competitor_total,
        scores,
        top_prompts: [prompts.pa[0], prompts.cp[0], prompts.ar[0]],
        raw_counts: {
          total_prompts: allPrompts.length,
          engines: 2,
          total_responses: allPrompts.length * 2
        },
        methodology
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
};
