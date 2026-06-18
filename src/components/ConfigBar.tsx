import { useState } from 'react';
import { MODELS } from '../lib/models';
import type { ModelId } from '../lib/types';

interface ConfigBarProps {
  readonly modelId: ModelId;
  readonly apiKey: string;
  readonly onModelChange: (id: ModelId) => void;
  readonly onApiKeyChange: (key: string) => void;
  readonly onClear: () => void;
}

export function ConfigBar({
  modelId,
  apiKey,
  onModelChange,
  onApiKeyChange,
  onClear,
}: ConfigBarProps) {
  const [showKey, setShowKey] = useState(false);
  const config = MODELS[modelId];

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
      </div>

      <div className="config-row">
        <label className="config-label" htmlFor="api-key">
          API key
        </label>
        <div className="api-key-wrap">
          <input
            id="api-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={modelId === 'nvidia-gpt-oss-120b' ? 'nvapi-...' : 'sk-...'}
            className="config-input"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="config-toggle"
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
          {apiKey && (
            <button type="button" onClick={onClear} className="config-clear" aria-label="Clear API key">
              Clear
            </button>
          )}
        </div>
      </div>

      <p className="config-hint">
        {config.description}{' '}
        <a href={config.docsUrl} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
      </p>
    </div>
  );
}
