/**
 * Full pipeline integration test — runs intent → copy → validate → (refine → validate)*
 * with real keys. Exercises the new AX DSPy-style state machine.
 */
import { runPipeline } from '../src/lib/pipeline.ts';

const PRODUCT = 'Cloud project management software for remote teams. Real-time collaboration, Gantt charts, time tracking. From $12 per user per month.';
const AUDIENCE = 'Startup founders at SMBs (5-50 employees)';
const TONE = 'professional';

async function test(modelId: 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1', apiKey: string) {
  console.log(`\n=== Full pipeline via ${modelId} ===`);
  const start = Date.now();
  const result = await runPipeline({
    modelId,
    apiKey,
    product: PRODUCT,
    audience: AUDIENCE,
    tone: TONE,
    mode: 'full',
    threshold: 0.7,
    maxRefinements: 2,
    onStage: (log) => {
      console.log(`  [${log.status.padEnd(7)}] ${log.stage.padEnd(8)} ${log.text ? '— ' + log.text.replace(/\s+/g, ' ').slice(0, 90) : ''}`);
    },
  }).catch((e) => {
    console.error(`  ❌ pipeline threw:`, e);
    process.exit(1);
  });
  const ms = Date.now() - start;

  console.log(`\nResult:`);
  console.log(`  mode:          ${result.mode}`);
  console.log(`  score:         ${(result.score * 100).toFixed(0)}/100`);
  console.log(`  attempts:      ${result.attempts}`);
  console.log(`  refinements:   ${result.refinements}`);
  console.log(`  latency:       ${ms}ms`);
  console.log(`  pipeline:      ${result.pipeline.join(' → ')}`);
  console.log(`  headlines:     ${result.ad.headlines.length} (max 5)`);
  console.log(`  descriptions:  ${result.ad.descriptions.length} (max 2)`);
  console.log(`  compliance:    ${result.ad.compliance.slice(0, 120)}`);
  console.log(`\n  Headlines:`);
  for (const h of result.ad.headlines) console.log(`    - [${h.length}/30] ${h}`);
  console.log(`  Descriptions:`);
  for (const d of result.ad.descriptions) console.log(`    - [${d.length}/90] ${d}`);

  // Verify char limits
  const overLongH = result.ad.headlines.filter((h) => h.length > 30);
  const overLongD = result.ad.descriptions.filter((d) => d.length > 90);
  if (overLongH.length || overLongD.length) {
    console.log(`  ⚠ over-limit: ${overLongH.length} headlines, ${overLongD.length} descriptions`);
  } else {
    console.log(`  ✓ all char limits respected`);
  }
}

const nvidiaKey = process.env.NVIDIA_API_KEY;
const opencodeKey = process.env.OPENCODE_API_KEY;

if (!nvidiaKey && !opencodeKey) {
  console.error('Set NVIDIA_API_KEY and/or OPENCODE_API_KEY');
  process.exit(1);
}

try {
  if (nvidiaKey) await test('nvidia-gpt-oss-120b', nvidiaKey);
  if (opencodeKey) await test('opencode-glm-5.1', opencodeKey);
} catch (e) {
  console.error('Test failed:', e);
  process.exit(1);
}
