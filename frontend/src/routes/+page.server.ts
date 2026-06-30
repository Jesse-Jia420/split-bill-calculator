import type { PageServerLoad } from './\$types';

export const load: PageServerLoad = async () => {
  try {
    const res = await fetch('http://127.0.0.1:8449/version');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json() as { backend: string };
    return { backendVersion: data.backend };
  } catch (e) {
    return { backendVersion: 'unreachable' };
  }
};
