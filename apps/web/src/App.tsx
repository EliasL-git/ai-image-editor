import { useEffect, useState } from 'react';
import { clearSession, getStoredUser } from './lib/api';
import type { User } from '@aie/types';
import AuthPage from './components/AuthPage';
import EditorPage from './components/EditorPage';

/**
 * Top-level shell: shows the auth screen when logged out, the editor otherwise.
 * Session is persisted in localStorage (token + user).
 */
export default function App() {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);

  if (!ready) return null;

  if (!user) {
    return <AuthPage onAuthed={(u) => setUser(u)} />;
  }

  return (
    <EditorPage
      user={user}
      onLogout={() => {
        clearSession();
        setUser(null);
      }}
    />
  );
}
