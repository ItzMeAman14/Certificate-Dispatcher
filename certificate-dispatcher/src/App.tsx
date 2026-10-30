import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ApiError, api, errorText, setSessionToken } from './api.ts';
import type { Me } from './api.ts';
import AuthScreen from './components/AuthScreen';
import CertificateDispatcher from './components/CertificateDispatcher';
import Footer from './components/Footer';

type State =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'ready'; me: Me };

export default function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const me = await api<Me & { success: true }>('/api/auth/me');
      setState({ status: 'ready', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState({ status: 'signed-out' });
      else setState({ status: 'error', message: errorText(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSignOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      setSessionToken(null);
      setState({ status: 'signed-out' });
    }
  }, []);

  const handleUnauthorized = useCallback(() => {
    setSessionToken(null);
    setState({ status: 'signed-out' });
  }, []);
  const handleMeChange = useCallback((me: Me) => setState({ status: 'ready', me }), []);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-screen flex-col justify-between bg-slate-50">
        <div className="flex flex-1 items-center justify-center px-4">
          <div role="alert" className="max-w-md rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
            <AlertTriangle className="mx-auto h-8 w-8 text-red-500" aria-hidden />
            <p className="mt-3 text-sm text-slate-700">{state.message}</p>
            <button
              type="button"
              onClick={() => {
                setState({ status: 'loading' });
                void refresh();
              }}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Try again
            </button>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <div className="flex min-h-screen flex-col justify-between bg-slate-50">
        <div className="flex-1">
          <AuthScreen onAuthenticated={() => void refresh()} />
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <CertificateDispatcher
      key={state.me.user.id}
      me={state.me}
      onMeChange={handleMeChange}
      onSignOut={() => void handleSignOut()}
      onUnauthorized={handleUnauthorized}
    />
  );
}
