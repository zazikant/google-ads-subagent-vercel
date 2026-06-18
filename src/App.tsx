import { useMemo, useRef, useState } from 'react';
import { AdResultView } from './components/AdResult';
import { ConfigBar } from './components/ConfigBar';
import { PhaseTracker } from './components/PhaseTracker';
import { DEFAULT_MODEL } from './lib/models';
import { runPipeline } from './lib/pipeline';
import type {
  AdResult,
  ModelId,
  PhaseStatus,
  PipelineMode,
  StageId,
} from './lib/types';
import './App.css';

const PHASES: ReadonlyArray<{
  id: StageId;
  num: string;
  label: string;
  color: string;
  bg: string;
}> = [
  { id: 'intent', num: '1', label: 'Strategic Intent Analysis', color: '#2563EB', bg: '#EFF6FF' },
  { id: 'copy', num: '2', label: 'Copy Generation', color: '#7C3AED', bg: '#F5F3FF' },
  { id: 'validate', num: '3', label: 'Compliance & Quality Review', color: '#059669', bg: '#ECFDF5' },
  { id: 'refine', num: '4', label: 'Refinement Loop', color: '#D97706', bg: '#FFFBEB' },
];

const STORAGE_KEY = 'gas:config:v3';

interface PersistedConfig {
  readonly modelId: ModelId;
  readonly apiKey: string;
  readonly mode: PipelineMode;
}

function loadConfig(): PersistedConfig {
  if (typeof window === 'undefined') return { modelId: DEFAULT_MODEL, apiKey: '', mode: 'full' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { modelId: DEFAULT_MODEL, apiKey: '', mode: 'full' };
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    return {
      modelId: parsed.modelId === 'opencode-glm-5.1' ? 'opencode-glm-5.1' : DEFAULT_MODEL,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      mode: parsed.mode === 'fast' ? 'fast' : 'full',
    };
  } catch {
    return { modelId: DEFAULT_MODEL, apiKey: '', mode: 'full' };
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
  const [apiKeyDraft, setApiKeyDraft] = useState<string>(initial.apiKey);
  const [keyCommitted, setKeyCommitted] = useState<boolean>(Boolean(initial.apiKey));
  const [mode, setMode] = useState<PipelineMode>(initial.mode);
  const [product, setProduct] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('professional');
  const [phaseStatus, setPhaseStatus] = useState<Record<StageId, PhaseStatus>>({
    intent: 'idle',
    copy: 'idle',
    validate: 'idle',
    refine: 'idle',
  });
  const [phaseText, setPhaseText] = useState<Record<StageId, string>>({
    intent: '',
    copy: '',
    validate: '',
    refine: '',
  });
  const [ad, setAd] = useState<AdResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [pipelineTrace, setPipelineTrace] = useState<ReadonlyArray<string>>([]);
  const [pipelineScore, setPipelineScore] = useState<number | null>(null);
  const [pipelineAttempts, setPipelineAttempts] = useState<number>(0);
  const [pipelineRefinements, setPipelineRefinements] = useState<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);

  const persist = (next: Partial<PersistedConfig>) => {
    saveConfig({
      modelId: next.modelId ?? modelId,
      apiKey: next.apiKey ?? apiKey,
      mode: next.mode ?? mode,
    });
  };

  const handleModelChange = (id: ModelId) => {
    setModelId(id);
    persist({ modelId: id });
  };

  const handleModeChange = (m: PipelineMode) => {
    setMode(m);
    persist({ mode: m });
  };

  const commitApiKey = () => {
    const trimmed = apiKeyDraft.trim();
    setApiKey(trimmed);
    setKeyCommitted(Boolean(trimmed));
    persist({ apiKey: trimmed });
  };

  const handleApiKeyOk = () => {
    commitApiKey();
    apiKeyInputRef.current?.blur();
  };

  const handleApiKeyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApiKeyOk();
    }
  };

  const handleClear = () => {
    setApiKey('');
    setApiKeyDraft('');
    setKeyCommitted(false);
    persist({ apiKey: '' });
  };

  const run = async () => {
    if (!product.trim()) {
      setError('Please describe your product.');
      return;
    }
    if (!apiKey.trim()) {
      setError('Click OK next to the API key first to save it.');
      return;
    }
    setError('');
    setAd(null);
    setRunning(true);
    setPipelineTrace([]);
    setPipelineScore(null);
    setPipelineAttempts(0);
    setPipelineRefinements(0);
    setPhaseStatus({ intent: 'idle', copy: 'idle', validate: 'idle', refine: 'idle' });
    setPhaseText({ intent: '', copy: '', validate: '', refine: '' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await runPipeline({
        modelId,
        apiKey,
        product,
        audience,
        tone,
        mode,
        signal: controller.signal,
        onStage: (log) => {
          setPhaseStatus((prev) => ({ ...prev, [log.stage]: log.status }));
          setPhaseText((prev) => ({ ...prev, [log.stage]: log.text }));
        },
      });
      setAd(result.ad);
      setPipelineTrace(result.pipeline);
      setPipelineScore(result.score);
      setPipelineAttempts(result.attempts);
      setPipelineRefinements(result.refinements);
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
            AX DSPy-style pipeline: <strong>strategy → copy → validate → refine</strong>.
            Pick a model, paste your key, describe the product.
          </p>
        </header>

        <ConfigBar
          modelId={modelId}
          onModelChange={handleModelChange}
          apiKeyDraft={apiKeyDraft}
          onApiKeyDraftChange={setApiKeyDraft}
          onApiKeyOk={handleApiKeyOk}
          onApiKeyKeyDown={handleApiKeyKeyDown}
          onClear={handleClear}
          keyCommitted={keyCommitted}
          apiKeyInputRef={apiKeyInputRef}
        />

        <section className="card">
          <div className="field-grid">
            <div>
              <label className="field-label" htmlFor="mode-select">
                Pipeline mode
              </label>
              <select
                id="mode-select"
                value={mode}
                onChange={(e) => handleModeChange(e.target.value as PipelineMode)}
                className="field-input"
              >
                <option value="full">
                  Full (intent → copy → validate → refine, up to 2 refinements)
                </option>
                <option value="fast">
                  Fast (intent → copy, no validation)
                </option>
              </select>
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

          <label className="field-label" htmlFor="audience">
            Target Audience <span className="field-label-hint">(optional)</span>
          </label>
          <input
            id="audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder="e.g. Startup founders at SMBs"
            className="field-input"
          />

          {error && <p className="error-text">{error}</p>}

          {running ? (
            <button onClick={cancel} className="btn btn-cancel">
              Cancel
            </button>
          ) : (
            <button
              onClick={run}
              disabled={running || !keyCommitted}
              className="btn btn-primary"
            >
              {running ? 'Running pipeline…' : `Generate Ad Copy (${mode}) →`}
            </button>
          )}
        </section>

        <PhaseTracker phases={PHASES} status={phaseStatus} text={phaseText} />

        {pipelineTrace.length > 0 && (
          <section className="trace">
            <div className="trace-head">
              <span className="trace-title">Pipeline trace</span>
              {pipelineScore !== null && (
                <span className="trace-score">
                  score {Math.round(pipelineScore * 100)}/100
                </span>
              )}
              <span className="trace-stat">attempts: {pipelineAttempts}</span>
              <span className="trace-stat">refinements: {pipelineRefinements}</span>
            </div>
            <div className="trace-steps">
              {pipelineTrace.map((step, i) => (
                <span key={i} className={`trace-step ${step.includes('fail') ? 'trace-step-bad' : step.includes('pass') || step.includes('echo') || step.includes('fixes') ? 'trace-step-info' : ''}`}>
                  {step}
                </span>
              ))}
            </div>
          </section>
        )}

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
