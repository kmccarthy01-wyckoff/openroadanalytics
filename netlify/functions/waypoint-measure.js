const https = require('https');

function callClaude(key, prompt) {
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch(e) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.write(payload);
    req.end();
  });
}

function callGPT(key, prompt) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + key
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch(e) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.write(payload);
    req.end();
  });
}

// Parse a response to extract citation data
function parseResponse(text, company, competitor) {
  const t = text.toLowerCase();
  const co = company.toLowerCase();
  const comp = competitor.toLowerCase();

  // Was brand cited?
  const coCited = t.includes(co);
  const compCited = t.includes(comp);

  // Position — find first mention index
  const coIdx = t.indexOf(co);
  const compIdx = t.indexOf(comp);

  // Position score — lower index = higher score
  function posScore(idx, otherIdx) {
    if (idx === -1) return 0;
    if (otherIdx === -1 || idx < otherIdx) return 3; // mentioned first
    if (idx < otherIdx + 100) return 2; // mentioned close second
    return 1; // mentioned later
  }

  // Sentiment — simple positive/negative signals around brand mention
  function sentScore(text, brand) {
    if (!text.includes(brand)) return 0;
    const brandIdx = text.indexOf(brand);
    const window = text.substring(Math.max(0, brandIdx - 80), brandIdx + 80);
    const positive = ['recommend', 'best', 'top', 'excellent', 'leading', 'popular', 'trusted', 'known for', 'great', 'premier', 'well-known'];
    const negative = ['however', 'but', 'although', 'limited', 'lacks', 'despite', 'compared to', 'behind'];
    const posCount = positive.filter(w => window.includes(w)).length;
    const negCount = negative.filter(w => window.includes(w)).length;
    if (posCount > negCount) return 3;
    if (negCount > posCount) return 1;
    return 2;
  }

  // Third party signal
  const thirdPartySignals = ['according to', 'cited by', 'featured in', 'reviewed by', 'mentioned by', 'referenced', 'source:', 'via ', 'from ', 'reports', 'study', 'research'];
  const hasThirdParty = thirdPartySignals.some(s => t.includes(s));

  const coPos = posScore(coIdx, compIdx);
  const compPos = posScore(compIdx, coIdx);
  const coSent = sentScore(t, co);
  const compSent = sentScore(t, comp);
  const bonus = hasThirdParty ? 1 : 0;

  const coRaw = coCited ? (coPos * coSent) + bonus : 0;
  const compRaw = compCited ? (compPos * compSent) + bonus : 0;

  return { coRaw, compRaw, coCited, compCited };
}

// Normalize raw scores to 0-100
function normalize(scores) {
  const max = 10; // max possible: 3 pos * 3 sent + 1 bonus = 10
  return Math.min(100, Math.round((scores / max) * 100));
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

    // Build analysis prompts — ask engines to respond naturally to each query
    const buildPrompt = (query) =>
      `Answer this question naturally and helpfully, as you would to a real user. Be specific and mention relevant brands when appropriate.\n\nQuestion: ${query}\n\nContext: The user is asking about ${industry} in ${market}.`;

    // Run all prompts in parallel batches of 10
    const BATCH = 10;
    const results = { pa: [], cp: [], ar: [] };

    for (let dim of ['pa', 'cp', 'ar']) {
      const dimPrompts = prompts[dim];
      for (let i = 0; i < dimPrompts.length; i += BATCH) {
        const batch = dimPrompts.slice(i, i + BATCH);
        const calls = batch.flatMap(q => [
          callClaude(anthropicKey, buildPrompt(q)),
          callGPT(openaiKey, buildPrompt(q))
        ]);
        const responses = await Promise.all(calls);
        for (let j = 0; j < batch.length; j++) {
          const claudeResp = responses[j * 2];
          const gptResp = responses[j * 2 + 1];
          results[dim].push({
            prompt: batch[j],
            claude: parseResponse(claudeResp, company, competitor),
            gpt: parseResponse(gptResp, company, competitor),
            claudeText: claudeResp.substring(0, 300),
            gptText: gptResp.substring(0, 300)
          });
        }
      }
    }

    // Calculate dimension scores
    function dimScore(dimResults, brand) {
      const total = dimResults.reduce((sum, r) => {
        const claudeRaw = brand === 'co' ? r.claude.coRaw : r.claude.compRaw;
        const gptRaw = brand === 'co' ? r.gpt.coRaw : r.gpt.compRaw;
        return sum + (claudeRaw + gptRaw) / 2;
      }, 0);
      return normalize(total / dimResults.length);
    }

    function citationRate(dimResults, brand) {
      const cited = dimResults.filter(r =>
        brand === 'co' ? (r.claude.coCited || r.gpt.coCited) : (r.claude.compCited || r.gpt.compCited)
      ).length;
      return Math.round((cited / dimResults.length) * 100);
    }

    const scores = {
      prompt_alignment: {
        a: dimScore(results.pa, 'co'),
        b: dimScore(results.pa, 'comp'),
        citation_rate_a: citationRate(results.pa, 'co'),
        citation_rate_b: citationRate(results.pa, 'comp')
      },
      citation_presence: {
        a: dimScore(results.cp, 'co'),
        b: dimScore(results.cp, 'comp'),
        citation_rate_a: citationRate(results.cp, 'co'),
        citation_rate_b: citationRate(results.cp, 'comp')
      },
      answer_readiness: {
        a: dimScore(results.ar, 'co'),
        b: dimScore(results.ar, 'comp'),
        citation_rate_a: citationRate(results.ar, 'co'),
        citation_rate_b: citationRate(results.ar, 'comp')
      }
    };

    const company_total = Math.round((scores.prompt_alignment.a + scores.citation_presence.a + scores.answer_readiness.a) / 3);
    const competitor_total = Math.round((scores.prompt_alignment.b + scores.citation_presence.b + scores.answer_readiness.b) / 3);

    // Sample prompts shown in UI — pick 3 representative ones
    const top_prompts = [
      prompts.pa[0],
      prompts.cp[0],
      prompts.ar[0]
    ];

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        company_total,
        competitor_total,
        scores,
        top_prompts,
        raw_counts: {
          total_prompts: results.pa.length + results.cp.length + results.ar.length,
          engines: 2,
          total_responses: (results.pa.length + results.cp.length + results.ar.length) * 2
        }
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
