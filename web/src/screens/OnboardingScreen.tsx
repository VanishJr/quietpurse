/**
 * First-run wizard: shown while the database has no accounts at all
 * (GET /api/onboarding/status). Three steps on one scroll:
 *   1) base currency and owner name (needed by the transfer classifier);
 *   2) connecting a bank: Monobank (token in .env), Enable Banking (a browser
 *      on the machine running the backend), a CSV statement (paste the file text
 *      or drop the file in);
 *   3) the first sync.
 * All of this can be done later too — the wizard just gathers the knobs you need
 * in one place and disappears as soon as the first account shows up.
 */
import { useState } from 'react';
import { api, API_BASE, apiLabel } from '../api';
import { CsvImport } from '../components/CsvImport';
import { OnboardingStatus } from '../types';

export function OnboardingScreen({
  status,
  onDone,
}: {
  status: OnboardingStatus;
  onDone: () => void;
}) {
  const [currency, setCurrency] = useState(status.settings.baseCurrency);
  const [ownerName, setOwnerName] = useState(status.settings.ownerNames.join(', '));
  const [savedSettings, setSavedSettings] = useState(false);

  const [ebBank, setEbBank] = useState('');
  const [ebCountry, setEbCountry] = useState('DE');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStarted, setSyncStarted] = useState(false);

  const saveSettings = async () => {
    setBusy(true);
    try {
      setError(null);
      await api.updateAppSettings({
        baseCurrency: currency.trim().toUpperCase(),
        ownerNames: ownerName
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setSavedSettings(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startSync = async () => {
    setBusy(true);
    try {
      setError(null);
      await api.startSync();
      setSyncStarted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen" style={{ position: 'static', flex: 1 }}>
      <div className="screen-inner onboarding">
        <h1 className="title">First run</h1>
        <p style={{ color: 'var(--ink-secondary)' }}>
          No accounts yet. Three steps and the data shows up. You can change all of it in the app
          later.
        </p>
        {error && <p className="error">Error: {error}</p>}

        {/* step 1: currency and owner */}
        <h2 className="step">1 · Currency and owner</h2>
        <p className="hint">
          The base currency is the one all totals are computed in. The owner name (as it appears
          in bank statements) is needed so transfers to yourself aren't counted as income.
          Multiple spellings — separated by commas.
        </p>
        <div className="stack">
          <input
            className="input"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="EUR"
            aria-label="Base currency"
          />
          <input
            className="input"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="Yurii Kalvenko, Yuriy Kalvenko"
            aria-label="Owner names"
          />
          <button className="btn" disabled={busy} onClick={saveSettings}>
            {savedSettings ? 'Saved ✓' : 'Save'}
          </button>
        </div>

        {/* step 2: bank */}
        <h2 className="step">2 · Connect a bank</h2>

        <h3 className="provider">
          Monobank {status.providers.monobank.configured ? '· configured ✓' : ''}
        </h3>
        {!status.providers.monobank.configured && (
          <p className="hint">
            Get a token at api.monobank.ua, add MONOBANK_TOKEN=… to backend/.env and restart the
            backend.
          </p>
        )}

        <h3 className="provider">
          Enable Banking (Revolut, N26, any EU bank){' '}
          {status.providers.enablebanking.sessions > 0 ? '· connected ✓' : ''}
        </h3>
        {status.providers.enablebanking.configured ? (
          <>
            <p className="hint">
              Enter the bank and country — the bank's authorization page opens. For security
              reasons the link works in a browser on the same machine that runs the backend.
            </p>
            <div className="inline-row">
              <input
                className="input"
                value={ebBank}
                onChange={(e) => setEbBank(e.target.value)}
                placeholder="Revolut"
                aria-label="Bank name"
              />
              <input
                className="input input-code"
                value={ebCountry}
                onChange={(e) => setEbCountry(e.target.value)}
                placeholder="LT"
                aria-label="Country code"
              />
            </div>
            <a
              className="btn-ghost"
              style={{ display: 'block', marginTop: 10, pointerEvents: ebBank.trim() ? 'auto' : 'none', opacity: ebBank.trim() ? 1 : 0.5 }}
              href={`${API_BASE}/api/enablebanking/connect?bank=${encodeURIComponent(
                ebBank.trim(),
              )}&country=${encodeURIComponent(ebCountry.trim())}`}
              target="_blank"
              rel="noreferrer"
            >
              Open bank connection
            </a>
          </>
        ) : (
          <p className="hint">
            Requires EB_APP_ID and EB_PRIVATE_KEY_PATH in backend/.env (free sign-up at
            enablebanking.com).
          </p>
        )}

        <h3 className="provider">CSV statement (any bank)</h3>
        <CsvImport />
        <p className="hint">
          You can come back to this any time: Accounts → Import.
        </p>

        {/* step 3: sync */}
        <h2 className="step">3 · First sync</h2>
        <button
          className="btn"
          style={{ display: 'block', width: '100%' }}
          disabled={busy}
          onClick={startSync}
        >
          {syncStarted ? 'Sync started ✓' : 'Sync now'}
        </button>

        <button
          className="btn-link"
          style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 28, fontSize: 16, fontWeight: 700 }}
          onClick={onDone}
        >
          Go to the app →
        </button>
        <p className="api-hint">API: {apiLabel()}</p>
      </div>
    </div>
  );
}
