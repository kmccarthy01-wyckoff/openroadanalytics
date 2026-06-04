const https = require('https');

function callAPI(hostname, path, headers, payload) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body);
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    const anthropicPayload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: body.messages
    });

    const openaiPayload = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      messages: [{ role: 'user', content: body.openaiMessage }]
    });

    const [claudeRes, openaiRes] = await Promise.all([
      callAPI('api.anthropic.com', '/v1/messages', {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      }, anthropicPayload),
      callAPI('api.openai.com', '/v1/chat/completions', {
        'Authorization': `Bearer ${openaiKey}`
      }, openaiPayload)
    ]);

    const claudeText = claudeRes.content?.[0]?.text || '';
    const openaiText = openaiRes.choices?.[0]?.message?.content || '';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ claudeText, openaiText })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
