/**
 * Probe which NVIDIA model names the user's key actually has access to.
 */
const KEY = process.env.NVIDIA_API_KEY;
if (!KEY) {
  console.error('Set NVIDIA_API_KEY');
  process.exit(1);
}

const candidates = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'mistralai/mistral-large-2-instruct',
  'mistralai/mixtral-8x22b-instruct',
  'nvidia/nemotron-4-340b-instruct',
  'google/gemma-2-27b-it',
  'qwen/qwen2.5-72b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
];

async function probe(model) {
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        temperature: 0.1,
      }),
    });
    const text = await r.text();
    return { status: r.status, snippet: text.slice(0, 100) };
  } catch (e) {
    return { status: -1, snippet: String(e).slice(0, 100) };
  }
}

console.log('Probing NVIDIA model catalog…\n');
for (const m of candidates) {
  const r = await probe(m);
  const mark = r.status === 200 ? '✅' : '❌';
  console.log(`${mark} ${m.padEnd(40)} ${r.status}  ${r.snippet.replace(/\n/g, ' ').slice(0, 60)}`);
}
