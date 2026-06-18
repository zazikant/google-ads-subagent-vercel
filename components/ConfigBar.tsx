import { useState } from 'react';
import { MODELS } from '../lib/models';
import type { ModelId } from '../lib/types';

interface ConfigBarProps {
  readonly modelId: ModelId;
  readonly onModelChange: (id: ModelId) => void;
  readonly apiKeyDraft: string;
  readonly onApiKeyDraftChange: (value: string) => void;
  readonly onApiKeyOk: () => void;
  readonly onApiKeyKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly onClear: () => void;
  readonly keyCommitted: boolean;
  readonly apiKeyInputRef: React.RefObject<HTMLInputElement>;
}

export function ConfigBar({
  modelId,
  onModelChange,
  apiKeyDraft,
  onApiKeyDraftChange,
  onApiKeyOk,
  onApiKeyKeyDown,
  onClear,
  keyCommitted,
  apiKeyInputRef,
}: ConfigBarProps) {
  const [showKey, setShowKey] = useState(false);
  const config = MODELS[modelId];
  const hasDraft = apiKeyDraft.trim().length > 0;
  const draftMatchesCommitted = apiKeyDraft === '' || (keyCommitted && hasDraft);

  return (
    <div className="config-bar">
      <div className="config-row">
        <label className="config-label" htmlFor="model-select">
          Model
        </label>
        <select
          id="model-select"
          value={modelId}
          onChange={(e) => onModelChange(e.target.value as ModelId)}
          className="config-select"
        >
          {Object.values(MODELS).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <span
          className={`config-status ${keyCommitted ? 'config-status-ok' : 'config-status-warn'}`}
          title={keyCommitted ? 'API key saved' : 'API key not yet saved'}
        >
          {keyCommitted ? '● key saved' : '○ key not set'}
        </span>
      </div>

      <div className="config-row">
        <label className="config-label" htmlFor="api-key">
          API key
        </label>
        <div className="api-key-wrap">
          <input
            id="api-key"
            ref={apiKeyInputRef}
            type={showKey ? 'text' : 'password'}
            value={apiKeyDraft}
            onChange={(e) => onApiKeyDraftChange(e.target.value)}
            onKeyDown={onApiKeyKeyDown}
            placeholder={modelId === 'nvidia-gpt-oss-120b' ? 'nvapi-...' : 'sk-...'}
            className="config-input"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="api-key-status"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="config-toggle"
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={onApiKeyOk}
            disabled={!hasDraft || draftMatchesCommitted}
            className="config-ok"
          >
            OK
          </button>
          {keyCommitted && (
            <button type="button" onClick={onClear} className="config-clear" aria-label="Clear API key">
              Clear
            </button>
          )}
        </div>
      </div>

      <p className="config-hint" id="api-key-status">
        {config.description}{' '}
        <a href={config.docsUrl} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
        <span className="config-hint-tail"> · Keys are stored only in your browser (localStorage).</span>
      </p>
    </div>
  );
}
