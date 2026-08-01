import { useEffect, useState } from 'react';
import { getStoredUser } from './lib/api';
import type { User } from '@aie/types';
import EditorPage from './components/EditorPage';

const LOCAL_USER: User = {
  id: 'local-user',
  email: 'local@local',
  name: 'Local',
  createdAt: new Date().toISOString(),
};

/**
 * Top-level shell. Auth is currently disabled, so the editor is shown directly
 * under a single shared local user (the stored session is reused when present).
 */
export default function App() {
  const [user, setUser] = useState<User>(() => getStoredUser() ?? LOCAL_USER);
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);

  if (!ready) return null;

  return <EditorPage user={user} onLogout={() => setUser(LOCAL_USER)} />;
}
