/**
 * Live integration test — exercises both providers end-to-end with real keys.
 * Reads keys from env so they never touch the repo.
 */
import { chatCompletion } from '../lib/llmClient.ts';

interface TestResult {
  provider: string;
  ok: boolean;
  model: string;
  preview: string;
  latencyMs: number;
  error?: string;
}

async function testProvider(
  provider: 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1',
  apiKey: string,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const res = await chatCompletion(
      provider,
      apiKey,
      [
        {
          role: 'system',
          content: 'You are a concise assistant. Reply in <=20 words.',
        },
        { role: 'user', content: 'Say "hello from <provider>" and nothing else.' },
      ],
      { temperature: 0.2, maxTokens: 64 },
    );
    return {
      provider,
      ok: true,
      model: res.model,
      preview: res.content.replace(/\s+/g, ' ').slice(0, 120),
      latencyMs: Date.now() - start,
    };
  } catch (e: unknown) {
    return {
      provider,
      ok: false,
      model: '—',
      preview: '—',
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

const nvidiaKey = process.env.NVIDIA_API_KEY;
const opencodeKey = process.env.OPENCODE_API_KEY;

if (!nvidiaKey && !opencodeKey) {
  console.error('Set NVIDIA_API_KEY and/or OPENCODE_API_KEY env vars to run this test.');
  process.exit(1);
}

const results: TestResult[] = [];
if (nvidiaKey) results.push(await testProvider('nvidia-gpt-oss-120b', nvidiaKey));
if (opencodeKey) results.push(await testProvider('opencode-glm-5.1', opencodeKey));

console.log('\n=== Live API integration test ===\n');
for (const r of results) {
  const status = r.ok ? '✅' : '❌';
  console.log(`${status} ${r.provider}`);
  console.log(`   model:    ${r.model}`);
  console.log(`   latency:  ${r.latencyMs}ms`);
  console.log(`   preview:  ${r.preview}`);
  if (r.error) console.log(`   error:    ${r.error}`);
  console.log('');
}

const allOk = results.every((r) => r.ok);
process.exit(allOk ? 0 : 1);
