import { useState } from 'react';
import { Badge } from './PhaseTracker';
import type { AdResult } from '../lib/types';

interface AdResultProps {
  readonly ad: AdResult;
}

export function AdResultView({ ad }: AdResultProps) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    const t = [
      'HEADLINES:',
      ...ad.headlines.map((h, i) => `${i + 1}. ${h}`),
      '',
      'DESCRIPTIONS:',
      ...ad.descriptions.map((d, i) => `${i + 1}. ${d}`),
    ].join('\n');

    try {
      await navigator.clipboard.writeText(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for environments without clipboard API
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="ad-result">
      {/* Google-style preview */}
      <div className="ad-preview">
        <div className="ad-preview-head">
          <div
            className="ad-preview-dot"
            style={{
              background:
                'linear-gradient(135deg,#4285F4,#34A853,#FBBC05,#EA4335)',
            }}
          />
          <span className="ad-preview-url">google.com</span>
          <span className="ad-preview-tag">Ad</span>
        </div>
        <div className="ad-preview-title">
          {ad.headlines.slice(0, 3).join(' | ')}
        </div>
        {ad.descriptions.map((d, i) => (
          <p key={i} className="ad-preview-desc">
            {d}
          </p>
        ))}
      </div>

      {/* Data */}
      <div className="ad-data">
        <p className="ad-section-title">Headlines</p>
        {ad.headlines.map((h, i) => (
          <div key={i} className="ad-line">
            <span className="ad-line-text">{h}</span>
            <Badge text={h} limit={30} />
          </div>
        ))}

        <p className="ad-section-title" style={{ marginTop: 14 }}>
          Descriptions
        </p>
        {ad.descriptions.map((d, i) => (
          <div key={i} className="ad-line">
            <span className="ad-line-text">{d}</span>
            <Badge text={d} limit={90} />
          </div>
        ))}

        {ad.compliance && (
          <div className="ad-compliance">
            <p className="ad-compliance-title">✓ Compliance</p>
            <p className="ad-compliance-body">{ad.compliance}</p>
          </div>
        )}

        <button onClick={copyToClipboard} className="ad-copy">
          {copied ? '✓ Copied!' : 'Copy Ad Copy'}
        </button>
      </div>
    </div>
  );
}
