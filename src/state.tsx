import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { demoWorkspace } from './lib/demo';
import { emptyWorkspace, type Workspace } from './lib/types';
import { validateWorkspace } from './lib/validate';
import { ConflictError, loadWorkspace, onExternalSave, saveWorkspace, type WorkspaceKey } from './storage/db';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

interface StoreValue {
  mode: WorkspaceKey;
  loading: boolean;
  loadError: string | null;
  ws: Workspace;
  saveState: SaveState;
  saveError: string | null;
  /** Message shown after another tab changed the data. */
  syncNotice: string | null;
  dismissSyncNotice: () => void;
  /**
   * Validate and persist a new workspace. Resolves once saved; rejects (and
   * leaves the in-memory workspace unchanged) if saving fails.
   */
  commit: (next: Workspace) => Promise<void>;
  enterDemo: () => Promise<void>;
  exitDemo: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

const MODE_KEY = 'cmc-mode';

function readStoredMode(): WorkspaceKey {
  try {
    return sessionStorage.getItem(MODE_KEY) === 'demo' ? 'demo' : 'personal';
  } catch {
    return 'personal';
  }
}

function storeMode(mode: WorkspaceKey) {
  try {
    sessionStorage.setItem(MODE_KEY, mode);
  } catch {
    /* convenience only */
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<WorkspaceKey>(readStoredMode);
  const [ws, setWs] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const load = useCallback(async (key: WorkspaceKey) => {
    const loaded = await loadWorkspace(key);
    if (key === 'demo' && loaded.revision === 0) {
      // First visit to the example: write a fresh copy into its own record.
      const revision = await saveWorkspace('demo', demoWorkspace(), 0);
      revisionRef.current = revision;
      setWs(demoWorkspace());
      return;
    }
    revisionRef.current = loaded.revision;
    setWs(loaded.workspace);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load(mode)
      .then(() => !cancelled && setLoadError(null))
      .catch((e: Error) => !cancelled && setLoadError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mode, load]);

  // Keep tabs in sync: reload when another tab saves the workspace we're showing.
  useEffect(() => {
    const refresh = async () => {
      try {
        const loaded = await loadWorkspace(modeRef.current);
        if (loaded.revision !== revisionRef.current) {
          revisionRef.current = loaded.revision;
          setWs(loaded.workspace);
          setSyncNotice('Updated with changes made in another tab.');
        }
      } catch {
        /* a later save will surface any storage problem */
      }
    };
    const unsubscribe = onExternalSave((msg) => {
      if (msg.key === modeRef.current && msg.revision !== revisionRef.current) void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const commit = useCallback(async (next: Workspace) => {
    const valid = validateWorkspace(next);
    if (!valid.ok) {
      setSaveState('failed');
      setSaveError(valid.errors[0]);
      throw new Error(valid.errors[0]);
    }
    setSaveState('saving');
    setSaveError(null);
    const key = modeRef.current;
    try {
      const revision = await saveWorkspace(key, valid.workspace, revisionRef.current);
      revisionRef.current = revision;
      setWs(valid.workspace);
      setSaveState('saved');
    } catch (e) {
      setSaveState('failed');
      const message = (e as Error).message || 'Your change could not be saved.';
      setSaveError(message);
      if (e instanceof ConflictError) {
        try {
          const loaded = await loadWorkspace(key);
          revisionRef.current = loaded.revision;
          setWs(loaded.workspace);
        } catch {
          /* keep showing the failure */
        }
      }
      throw new Error(message);
    }
  }, []);

  const switchMode = useCallback(async (next: WorkspaceKey) => {
    if (next === 'demo') {
      // Start each example visit from the original numbers, in its own record.
      try {
        const current = await loadWorkspace('demo');
        await saveWorkspace('demo', demoWorkspace(), current.revision);
      } catch {
        /* falls back to whatever load() finds */
      }
    }
    setSaveState('idle');
    setSaveError(null);
    setSyncNotice(null);
    storeMode(next);
    setMode(next);
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      mode,
      loading,
      loadError,
      ws,
      saveState,
      saveError,
      syncNotice,
      dismissSyncNotice: () => setSyncNotice(null),
      commit,
      enterDemo: () => switchMode('demo'),
      exitDemo: () => switchMode('personal'),
    }),
    [mode, loading, loadError, ws, saveState, saveError, syncNotice, commit, switchMode],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}
