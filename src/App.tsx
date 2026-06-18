import { useMemo, useRef, useState } from 'react';
import { AdResultView } from './components/AdResult';
import { ConfigBar } from './components/ConfigBar';
import { PhaseTracker } from './components/PhaseTracker';
import { DEFAULT_MODEL } from './lib/models';
import { runPipeline } from './lib/pipeline';
import type { AdResult, ModelId, PhaseStatus, StageId } from './lib/types';

const PHASES: ReadonlyArray<{
  id: StageId;
  num: string;
  label: string;
  color: string;
  bg: string;
}> = [
  { id: 'intent', num: '1', label: 'Strategic Intent Analysis', color: '#2563EB', bg: '#EFF6FF' },
  { id: 'copy', num: '2', label: 'Copy Generation', color: '#7C3AED', bg: '#F5F3FF' },
  { id: 'compliance', num: '3', label: 'Compliance Review', color: '#059669', bg: '#ECFDF5' },
];

const STORAGE_KEY = 'gas:config:v1';

interface PersistedConfig {
  readonly modelId: ModelId;
  readonly apiKey: string;
}

function loadConfig(): PersistedConfig {
  if (typeof window === 'undefined') return { modelId: DEFAULT_MODEL, apiKey: '' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { modelId: DEFAULT_MODEL, apiKey: '' };
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    return {
      modelId: parsed.modelId === 'opencode-glm-5.1' ? 'opencode-glm-5.1' : DEFAULT_MODEL,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return { modelId: DEFAULT_MODEL, apiKey: '' };
  }
}

function saveConfig(config: PersistedConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore quota errors
  }
}

export default function App() {
  const initial = useMemo(() => loadConfig(), []);
  const [modelId, setModelId] = useState<ModelId>(initial.modelId);
  const [apiKey, setApiKey] = useState<string>(initial.apiKey);
  const [product, setProduct] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('professional');
  const [phaseStatus, setPhaseStatus] = useState<Record<StageId, PhaseStatus>>({
    intent: 'idle',
    copy: 'idle',
    compliance: 'idle',
  });
  const [phaseText, setPhaseText] = useState<Record<StageId, string>>({
    intent: '',
    copy: '',
    compliance: '',
  });
  const [ad, setAd] = useState<AdResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const persist = (next: Partial<PersistedConfig>) => {
    saveConfig({ modelId: next.modelId ?? modelId, apiKey: next.apiKey ?? apiKey });
  };

  const handleModelChange = (id: ModelId) => {
    setModelId(id);
    persist({ modelId: id });
  };

  const handleApiKeyChange = (key: string) => {
    setApiKey(key);
    persist({ apiKey: key });
  };

  const handleClear = () => {
    setApiKey('');
    persist({ apiKey: '' });
  };

  const run = async () => {
    if (!product.trim()) {
      setError('Please describe your product.');
      return;
    }
    if (!apiKey.trim()) {
      setError('Please enter an API key in the config bar.');
      return;
    }
    setError('');
    setAd(null);
    setRunning(true);
    setPhaseStatus({ intent: 'idle', copy: 'idle', compliance: 'idle' });
    setPhaseText({ intent: '', copy: '', compliance: '' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { ad: resultAd } = await runPipeline({
        modelId,
        apiKey,
        product,
        audience,
        tone,
        signal: controller.signal,
        onStage: (log) => {
          setPhaseStatus((prev) => ({ ...prev, [log.stage]: log.status }));
          setPhaseText((prev) => ({ ...prev, [log.stage]: log.text }));
        },
      });
      setAd(resultAd);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Error: ${msg}`);
      setPhaseStatus((prev) => {
        const next = { ...prev };
        (Object.keys(next) as StageId[]).forEach((k) => {
          if (next[k] === 'running') next[k] = 'idle';
        });
        return next;
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <h1>🎯 Google Ads AI Subagent</h1>
          <p>
            Three specialized AI agents in sequence: strategy → copy → compliance.
            Pick a model, paste your key, describe the product.
          </p>
        </header>

        <ConfigBar
          modelId={modelId}
          apiKey={apiKey}
          onModelChange={handleModelChange}
          onApiKeyChange={handleApiKeyChange}
          onClear={handleClear}
        />

        <section className="card">
          <label className="field-label" htmlFor="product">
            Product / Service *
          </label>
          <textarea
            id="product"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            rows={3}
            placeholder="e.g. Cloud project management software for remote teams. Real-time collaboration, Gantt charts. From $12/user/mo."
            className="field-textarea"
          />

          <div className="field-grid">
            <div>
              <label className="field-label" htmlFor="audience">
                Target Audience
              </label>
              <input
                id="audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="e.g. Startup founders at SMBs"
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="tone">
                Brand Tone
              </label>
              <select
                id="tone"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className="field-input"
              >
                <option value="professional">Professional</option>
                <option value="friendly">Friendly</option>
                <option value="urgent">Urgent</option>
                <option value="premium">Premium</option>
                <option value="playful">Playful</option>
              </select>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}

          {running ? (
            <button onClick={cancel} className="btn btn-cancel">
              Cancel
            </button>
          ) : (
            <button
              onClick={run}
              disabled={running}
              className="btn btn-primary"
            >
              {running ? 'Running subagents…' : 'Generate Ad Copy →'}
            </button>
          )}
        </section>

        <PhaseTracker phases={PHASES} status={phaseStatus} text={phaseText} />

        {ad && <AdResultView ad={ad} />}

        <footer className="page-foot">
          <p>
            Keys stay in your browser (localStorage). Calls hit the model
            provider directly — no proxy, no logs.
          </p>
        </footer>
      </div>
    </div>
  );
}
